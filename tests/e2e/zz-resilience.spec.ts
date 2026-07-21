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

  // Warm two real query-cache windows before the outage. Returning to the 100-row window
  // after its ten-second staleTime gives TanStack Query cached data to retain while the
  // background refetch experiences the real dead Atlas socket.
  await page.getByRole("button", { name: "100", exact: true }).click();
  await expect(page).toHaveURL(/limit=100/);
  await expect(page.getByText("Contract Workflow").first()).toBeVisible();
  await page.getByRole("button", { name: "25", exact: true }).click();
  await expect(page).toHaveURL(/limit=25/);
  await page.waitForTimeout(10_100);

  // Kill the shared Atlas — the app's configured origin now refuses connections.
  process.kill(seed.atlasRestart.pid!, "SIGTERM");
  await waitForAtlasDown(seed.atlasOrigin);

  let replacement: { stop: () => void } | undefined;
  try {
    // A cached window is not silently presented as current once its background refetch fails.
    // The shell-level warning is driven by the real QueryCache state, not navigator.onLine or
    // a mocked response, and names the cached/stale risk explicitly.
    await page.getByRole("button", { name: "100", exact: true }).click();
    await expect(page.getByTestId("stale-data-warning")).toContainText(
      "Some data may be cached and stale",
      { timeout: 30_000 },
    );
    expect(new URL(page.url()).pathname).not.toBe("/auth");

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

    // Recovery needs no document reload. Depending on focus/refetch timing, the active query
    // either recovers automatically or leaves its explicit Try again control; exercise the
    // control when present and accept the already-recovered table otherwise.
    const retry = page.getByRole("button", { name: "Try again" });
    const auditor = page.getByText("auditor").first();
    await expect
      .poll(async () => (await retry.isVisible()) || (await auditor.isVisible()), {
        timeout: 30_000,
      })
      .toBe(true);
    if (await retry.isVisible()) await retry.click();
    // "auditor" renders only in the users table — the sidebar shows the signed-in admin —
    // so its visibility proves the read genuinely recovered with persisted state intact.
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
