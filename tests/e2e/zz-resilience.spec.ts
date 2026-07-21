import { expect, test, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS, respawnAtlas } from "../contract/atlas-instance";
import { readSeed } from "./global-setup";

/**
 * Atlas-restart recovery (Phase 6).
 *
 * Named `zz-resilience` so it runs last: it kills the suite's shared Atlas mid-test. A
 * replacement is booted on the same port against the same SQLite file, which is exactly what
 * an operator's single-node Atlas restart looks like — the origin the app talks to never
 * changes, and the persisted state must all still be there.
 */

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function waitForAtlasDown(origin: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await fetch(`${origin}/api/me`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error("Atlas did not stop within 15s");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

test("an Atlas outage is shown truthfully and a restart recovers without losing persisted state", async ({
  page,
}) => {
  const seed = readSeed();
  test.skip(seed.atlasRestart.pid === undefined, "no Atlas pid recorded by global setup");

  await signIn(page);

  // Baseline: persisted state is visible before the outage.
  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page.getByText("Contract Workflow").first()).toBeVisible();

  // Kill the shared Atlas — the app's configured origin now refuses connections.
  process.kill(seed.atlasRestart.pid!, "SIGTERM");
  await waitForAtlasDown(seed.atlasOrigin);

  let replacement: { stop: () => void } | undefined;
  try {
    // A navigation to a page with no cached window renders a truthful failure state after
    // the bounded retries — and does NOT misread the outage as a sign-out: no redirect to
    // /auth, because Atlas being unreachable is not a 401. (A page whose data is still
    // fresh in the query cache keeps rendering it — the cache exists precisely so a blip
    // does not blank pages — which is why this asserts on a never-visited page.)
    await page.getByRole("link", { name: "Users & Tokens", exact: true }).click();
    await expect(
      page.getByText(/Atlas unreachable|Atlas timed out|Atlas failed to process/).first(),
    ).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname).not.toBe("/auth");

    // Restart: same port, same database.
    replacement = await respawnAtlas(seed.atlasRestart);

    // Recovery is the page's own Try again control — no reload required — with the session
    // cookie still valid and every row Atlas had persisted still present.
    // "auditor" renders only in the users table — the sidebar shows the signed-in admin —
    // so its visibility proves the read genuinely recovered.
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("auditor").first()).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname).not.toBe("/auth");

    await page.getByRole("link", { name: "Workflows", exact: true }).click();
    await expect(page.getByText("Contract Workflow").first()).toBeVisible();
  } finally {
    // The suite's teardown only knows the original pid; the replacement is ours to stop.
    // It must outlive the test's assertions but not the run.
    replacement?.stop();
  }
});
