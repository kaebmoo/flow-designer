import { expect, test, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS } from "../contract/atlas-instance";

/**
 * Phase 6 security acceptance: CSRF enforcement on the real server-function transport.
 *
 * These tests capture a genuine RPC request the app itself issues, then replay its exact URL
 * and body with crafted request metadata. That drives the production middleware in
 * `src/start.ts` — not a re-implementation of its rules — so what is asserted is what an
 * actual cross-site attacker's request would receive.
 *
 * The framework's evaluation order (verified against the installed
 * `createCsrfMiddleware`): `Sec-Fetch-Site` wins when present and must be `same-origin`;
 * otherwise `Origin` is matched against the normalised `PUBLIC_ORIGIN`; otherwise `Referer`;
 * a request carrying none of the three is denied.
 */

async function gotoAuthHydrated(page: Page) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
}

/**
 * Strips the metadata under test (and hop-by-hop noise) from a captured request's headers,
 * so each case controls Sec-Fetch-Site/Origin/Referer exactly while every functional header
 * the RPC transport needs (content type, `x-tsr-serverFn`, accept) is replayed verbatim.
 */
function replayHeaders(captured: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  const dropped = new Set([
    "origin",
    "referer",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "cookie",
    "host",
    "content-length",
    "connection",
  ]);
  for (const [name, value] of Object.entries(captured)) {
    if (!name.startsWith(":") && !dropped.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

/** Captures the login RPC's URL, body, and headers by driving the real form once. */
async function captureLoginRpc(page: Page) {
  await gotoAuthHydrated(page);
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  // A wrong password on purpose: the capture needs the request shape, not a session.
  await page.getByLabel("Password").fill("csrf-capture-wrong-password");
  const [request] = await Promise.all([
    page.waitForRequest(
      (candidate) => candidate.method() === "POST" && candidate.url().includes("_serverFn"),
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await expect(page.getByRole("alert")).toContainText(/incorrect username or password/i);
  return {
    url: request.url(),
    body: request.postData() ?? "",
    headers: replayHeaders(request.headers()),
  };
}

test("CSRF: the login mutation accepts same-origin and rejects cross-site metadata", async ({
  page,
  request,
  baseURL,
}) => {
  const rpc = await captureLoginRpc(page);
  const post = (headers: Record<string, string>) =>
    request.post(rpc.url, {
      headers: { ...rpc.headers, ...headers },
      data: rpc.body,
    });

  // Same-origin Sec-Fetch-Site: the function executes (bad credentials are a 200 envelope,
  // not a CSRF rejection).
  const sameOrigin = await post({ "sec-fetch-site": "same-origin" });
  expect(sameOrigin.status()).toBe(200);

  // A browser-issued cross-site request always carries Sec-Fetch-Site: cross-site.
  const crossSite = await post({ "sec-fetch-site": "cross-site" });
  expect(crossSite.status()).toBe(403);
  const crossSiteBody = await crossSite.text();
  expect(crossSiteBody).not.toContain("incorrect");

  // Legacy browsers without Sec-Fetch-Site fall back to Origin matching.
  const evilOrigin = await post({ origin: "https://evil.example" });
  expect(evilOrigin.status()).toBe(403);

  const goodOrigin = await post({ origin: baseURL! });
  expect(goodOrigin.status()).toBe(200);

  // The normalisation rule, exercised end-to-end: PUBLIC_ORIGIN comparison is by URL origin,
  // so an Origin header that differs only in case still matches.
  const casedOrigin = await post({ origin: baseURL!.toUpperCase() });
  expect(casedOrigin.status()).toBe(200);

  // Referer is the last fallback for browsers that send neither of the first two.
  const goodReferer = await post({ referer: `${baseURL}/auth` });
  expect(goodReferer.status()).toBe(200);
});

test("CSRF: a request carrying no Sec-Fetch-Site, Origin, or Referer is denied", async ({
  page,
  request,
}) => {
  const rpc = await captureLoginRpc(page);
  const bare = await request.post(rpc.url, {
    headers: rpc.headers,
    data: rpc.body,
  });
  expect(bare.status()).toBe(403);
});

test("CSRF: an authenticated mutation is protected and a rejected call has no effect", async ({
  page,
}) => {
  // Sign in for real, so the replayed request carries a valid session cookie — proving the
  // cookie alone is not enough to drive a mutation.
  await gotoAuthHydrated(page);
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Capture the logout RPC — a real authenticated mutation — then cancel its effect by
  // signing straight back in.
  const [logoutRequest] = await Promise.all([
    page.waitForRequest(
      (candidate) => candidate.method() === "POST" && candidate.url().includes("_serverFn"),
    ),
    page.getByRole("button", { name: "Sign out" }).click(),
  ]);
  const rpc = {
    url: logoutRequest.url(),
    body: logoutRequest.postData() ?? "",
    headers: replayHeaders(logoutRequest.headers()),
  };
  await expect(page).toHaveURL(/\/auth$/);

  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // `page.request` shares the browser context's cookies, so this is a cross-site request
  // presenting the live session cookie — the classic CSRF shape.
  const forged = await page.request.post(rpc.url, {
    headers: { ...rpc.headers, "sec-fetch-site": "cross-site" },
    data: rpc.body,
  });
  expect(forged.status()).toBe(403);

  // The rejected logout must not have revoked anything: the session still works.
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard$/);
});
