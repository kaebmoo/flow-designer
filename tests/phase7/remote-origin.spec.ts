import { expect, test, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS } from "../contract/atlas-instance";
import { PUBLIC_ORIGIN, readPhase7Seed } from "./global-setup";

function functionalHeaders(captured: Record<string, string>): Record<string, string> {
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

async function openAuth(page: Page) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
}

test("HTTPS public origin keeps Atlas private and secures every browser transport", async ({
  page,
  request,
  baseURL,
}) => {
  const seed = readPhase7Seed();
  expect(baseURL).toBe(PUBLIC_ORIGIN);

  const browserRequests: string[] = [];
  page.on("request", (candidate) => browserRequests.push(candidate.url()));

  // Capture the real login RPC so origin matching is exercised by the installed production
  // middleware, through the HTTPS proxy, while the app server itself listens on plain HTTP.
  await openAuth(page);
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill("phase7-wrong-password");
  const [captured] = await Promise.all([
    page.waitForRequest(
      (candidate) => candidate.method() === "POST" && candidate.url().includes("_serverFn"),
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await expect(page.getByRole("alert")).toContainText(/incorrect username or password/i);
  const rpc = {
    url: captured.url(),
    body: captured.postData() ?? "",
    headers: functionalHeaders(captured.headers()),
  };

  const matching = await request.post(rpc.url, {
    headers: { ...rpc.headers, origin: PUBLIC_ORIGIN },
    data: rpc.body,
  });
  expect(matching.status()).toBe(200);
  const rejected = await request.post(rpc.url, {
    headers: { ...rpc.headers, origin: "https://evil.example" },
    data: rpc.body,
  });
  expect(rejected.status()).toBe(403);

  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${PUBLIC_ORIGIN}/dashboard`);
  await expect(page.getByText("Contract Workflow").first()).toBeVisible();

  const session = (await page.context().cookies(PUBLIC_ORIGIN)).find(
    (cookie) => cookie.name === "fd_session",
  );
  expect(session, "flow-designer session cookie").toBeDefined();
  expect(session!.httpOnly).toBe(true);
  expect(session!.secure).toBe(true);
  expect(session!.sameSite).toBe("Lax");
  expect(session!.path).toBe("/");
  expect(session!.domain).toBe("localhost");
  expect(session!.expires).toBeGreaterThan(Date.now() / 1000 + 7 * 60 * 60);

  const artifact = await page.request.get(`/api/artifacts/${seed.artifactId}/content`);
  expect(artifact.status()).toBe(200);
  expect(artifact.url()).toBe(`${PUBLIC_ORIGIN}/api/artifacts/${seed.artifactId}/content`);
  expect(await artifact.text()).toBe(seed.artifactBody);
  expect(artifact.headers()["content-disposition"]).toContain("phase7-release.txt");
  expect(artifact.headers()["cache-control"]).toBe("private, no-store");

  const audit = await page.request.get("/api/exports/audit-csv?limit=25");
  expect(audit.status()).toBe(200);
  expect(audit.url()).toBe(`${PUBLIC_ORIGIN}/api/exports/audit-csv?limit=25`);
  expect(audit.headers()["content-type"]).toContain("text/csv");
  expect(audit.headers()["content-disposition"]).toContain("atlas-audit.csv");

  const usage = await page.request.get("/api/exports/usage-csv");
  expect(usage.status()).toBe(200);
  expect(usage.url()).toBe(`${PUBLIC_ORIGIN}/api/exports/usage-csv`);
  expect(usage.headers()["content-type"]).toContain("text/csv");

  const stream = await page.request.get(`/api/jobs/${seed.jobId}/events?after=0`);
  expect(stream.status()).toBe(200);
  expect(stream.url()).toBe(`${PUBLIC_ORIGIN}/api/jobs/${seed.jobId}/events?after=0`);
  expect(stream.headers()["content-type"]).toContain("text/event-stream");
  expect(stream.headers()["x-accel-buffering"]).toBe("no");
  expect(await stream.text()).toContain("event: close");

  expect(browserRequests.some((url) => url.startsWith(seed.atlasOrigin))).toBe(false);
  expect(browserRequests.some((url) => /[?&]token=|Bearer/i.test(url))).toBe(false);
  expect(await page.content()).not.toContain(seed.atlasOrigin);
});
