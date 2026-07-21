import { expect, test, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS } from "../contract/atlas-instance";

/**
 * Phase 6 resilience acceptance: request cancellation on navigation, through the real
 * query → server-function → transport path.
 *
 * Nothing is mocked. The one intervention is a *delay* injected in front of the jobs-list
 * RPC (the request still reaches the real dev server and real Atlas), which holds the read
 * open long enough for a navigation to overtake it — the race an operator creates by
 * clicking away from a slow page.
 */

/** The server-fn id is base64 in the URL path; decode it to target one function. */
function rpcId(url: URL): string {
  if (!url.pathname.includes("/_serverFn/")) return "";
  try {
    return Buffer.from(url.pathname.split("/_serverFn/")[1] ?? "", "base64").toString();
  } catch {
    return "";
  }
}

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test("navigating away aborts the in-flight read RPC and leaves no stale or error UI", async ({
  page,
}) => {
  await signIn(page);

  // Delay only the jobs-list RPC. `route.continue()` after the pause still sends the real
  // request to the real server; nothing about the response is fabricated.
  const jobsRpc = (url: URL) => rpcId(url).includes("listJobsFn");
  await page.route(jobsRpc, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });

  const failed = page.waitForEvent("requestfailed", {
    predicate: (request) => rpcId(new URL(request.url())).includes("listJobsFn"),
    timeout: 15_000,
  });
  const started = page.waitForRequest((request) =>
    rpcId(new URL(request.url())).includes("listJobsFn"),
  );

  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await started;

  // Navigate away while the read is still held open: TanStack Query aborts its signal, and
  // the browser must report the RPC as aborted — not completed, not errored into the UI.
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  const aborted = await failed;
  expect(aborted.failure()?.errorText).toContain("ERR_ABORTED");

  // The destination page is healthy: real data, no failure state bleeding across from the
  // cancelled read.
  await expect(page.getByRole("heading", { name: "Mission Control" })).toBeVisible();
  await expect(page.getByText("Atlas error")).toHaveCount(0);
  await expect(page.getByText("Atlas timed out")).toHaveCount(0);

  // Returning to the page issues a fresh request and renders normally — the aborted result
  // was discarded, not written into the cache as data or as an error.
  await page.unroute(jobsRpc);
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();
  await expect(page.getByText("Atlas error")).toHaveCount(0);
});
