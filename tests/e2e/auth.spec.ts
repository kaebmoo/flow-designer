import { expect, test } from "@playwright/test";

import { ADMIN_CREDENTIALS, VIEWER_CREDENTIALS } from "../contract/atlas-instance";

/**
 * Browser acceptance for Phase 1.
 *
 * The point of running these in a real browser rather than against the modules directly is
 * the last two tests: they check what the *browser* can observe. A bearer visible to page
 * JavaScript would defeat the whole server-side session design, and no unit test can prove
 * its absence.
 */

async function signIn(page: import("@playwright/test").Page, creds: typeof ADMIN_CREDENTIALS) {
  await page.goto("/auth");
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("an unauthenticated visitor is redirected from a protected page to /auth", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/auth$/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("signing in reaches the dashboard and shows the Atlas identity", async ({ page }) => {
  await signIn(page, ADMIN_CREDENTIALS);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText("admin", { exact: true })).toBeVisible();
  await expect(page.getByText("Admin", { exact: true })).toBeVisible();
});

test("bad credentials render an inline error and do not sign the user in", async ({ page }) => {
  await page.goto("/auth");
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill("definitely-the-wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toContainText(/incorrect username or password/i);
  await expect(page).toHaveURL(/\/auth$/);
});

test("the session survives a full page reload", async ({ page }) => {
  await signIn(page, ADMIN_CREDENTIALS);
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.reload();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText("admin", { exact: true })).toBeVisible();
});

test("signing out clears the session and blocks the back button", async ({ page }) => {
  await signIn(page, ADMIN_CREDENTIALS);
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/auth$/);

  // The session is genuinely gone, not merely navigated away from.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/auth$/);
});

test("a viewer signs in and sees their real role", async ({ page }) => {
  await signIn(page, VIEWER_CREDENTIALS);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText("Viewer", { exact: true })).toBeVisible();
});

test("no Atlas bearer is reachable from browser storage or page scripts", async ({
  page,
  context,
}) => {
  await signIn(page, ADMIN_CREDENTIALS);
  await expect(page).toHaveURL(/\/dashboard$/);

  const exposed = await page.evaluate(() => ({
    localStorage: JSON.stringify(window.localStorage),
    sessionStorage: JSON.stringify(window.sessionStorage),
    // httpOnly cookies are invisible here by definition; anything returned is readable JS-side.
    documentCookie: document.cookie,
    url: window.location.href,
  }));

  expect(exposed.localStorage).toBe("{}");
  expect(exposed.sessionStorage).toBe("{}");
  expect(exposed.documentCookie).not.toContain("fd_session");
  expect(exposed.url).not.toMatch(/token=/);

  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === "fd_session");
  expect(session, "the session cookie should exist").toBeTruthy();
  expect(session!.httpOnly, "session cookie must be httpOnly").toBe(true);
  expect(session!.sameSite).toBe("Lax");
  // Sealed, so the cookie value is ciphertext rather than anything resembling a bearer.
  expect(session!.value).not.toContain("admin");
});

/**
 * The credential-leak guard that actually bites.
 *
 * `/auth` is server-rendered, so before React hydrates — or if the JS bundle never loads —
 * the browser submits the form natively. A form without `method="post"` defaults to GET and
 * puts the typed password in the URL, browser history, and every access log in front of the
 * app. Disabling JavaScript reproduces that window deterministically; the hydrated test below
 * cannot, because by then `onSubmit` intercepts everything.
 */
test.describe("without JavaScript (pre-hydration window)", () => {
  test.use({ javaScriptEnabled: false });

  test("submitting the login form never puts credentials in the URL", async ({ page }) => {
    await page.goto("/auth");

    await page.getByLabel("Username").fill("alice");
    await page.getByLabel("Password").fill("super-secret-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForLoadState("domcontentloaded");

    const url = page.url();
    expect(url).not.toContain("super-secret-password");
    expect(url).not.toContain("alice");
    expect(url).not.toMatch(/[?&](username|password)=/);
  });
});

test("the password is never placed in the URL", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));

  await signIn(page, ADMIN_CREDENTIALS);
  await expect(page).toHaveURL(/\/dashboard$/);

  for (const url of urls) {
    expect(url).not.toContain(ADMIN_CREDENTIALS.password);
    expect(url).not.toMatch(/[?&](token|password)=/);
  }
});
