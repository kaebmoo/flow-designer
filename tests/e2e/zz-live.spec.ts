/**
 * Browser acceptance for Phase 4: live per-job events on the run detail page.
 *
 * The stub thClaws worker fixture is what makes a *running* run observable at all — every
 * other worker in this harness is deliberately unreachable, so its jobs are terminal within
 * milliseconds. The stub substitutes for a worker, never for Atlas: Atlas genuinely dials it,
 * consumes its `/agent/run` stream, writes real `job_events` rows, and serves the real
 * per-job SSE that the page consumes through the same-origin proxy route.
 *
 * Nothing here simulates node state and nothing sleeps a fixed interval to "let it happen":
 * every assertion is a condition poll with a bounded deadline (Playwright's `expect` retries),
 * and what it polls for is Atlas state as the UI renders it.
 *
 * The `zz-` prefix is load-bearing: Playwright runs spec files in name order with one worker,
 * and `reads.spec.ts` asserts on *exactly* the globally-seeded rows. This file registers an
 * extra worker and extra workflows in the shared Atlas, so — like `runs.spec.ts` and
 * `triggers.spec.ts`, which already rely on running after the strict-seed assertions — it must
 * sort after them.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS } from "../contract/atlas-instance";
import { startStubWorker, type StubWorker } from "../fixtures/thclaws-stub";
import { readSeed } from "./global-setup";

let cachedSeed: ReturnType<typeof readSeed> | undefined;
function seedIds() {
  cachedSeed ??= readSeed();
  return cachedSeed;
}

function atlasHeaders(): Record<string, string> {
  return { authorization: `Bearer ${seedIds().adminToken}` };
}

let stub: StubWorker;
let stubWorkerId = "";

test.beforeAll(async ({ request }) => {
  stub = await startStubWorker();
  const response = await request.post(`${seedIds().atlasOrigin}/api/workers`, {
    headers: atlasHeaders(),
    data: { name: "E2E Live Stub Worker", base_url: stub.origin, role: "streamer" },
  });
  expect(response.status()).toBe(201);
  stubWorkerId = ((await response.json()) as { worker: { id: string } }).worker.id;
});

test.afterAll(async () => {
  await stub?.close();
});

let workflowCounter = 0;

/** One worker node on the stub, its pacing controlled by the prompt's stub directives. */
async function startStubRun(request: APIRequestContext, prompt: string): Promise<string> {
  workflowCounter += 1;
  const workflow = await request.post(`${seedIds().atlasOrigin}/api/workflows`, {
    headers: atlasHeaders(),
    data: {
      name: `E2E live ${workflowCounter}`,
      description: "",
      graph: {
        start: "work",
        nodes: [
          { id: "work", type: "worker", prompt, worker_id: stubWorkerId, outputs: ["report"] },
        ],
        edges: [],
      },
      policy: {},
    },
  });
  expect(workflow.status()).toBe(201);
  const workflowId = ((await workflow.json()) as { workflow: { id: string } }).workflow.id;

  const run = await request.post(`${seedIds().atlasOrigin}/api/workflow-runs`, {
    headers: atlasHeaders(),
    data: { workflow_definition_id: workflowId, input: {} },
  });
  expect(run.status()).toBe(202);
  return ((await run.json()) as { run: { id: string } }).run.id;
}

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function openRun(page: Page, runId: string) {
  await page.goto(`/runs/${runId}`);
  await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });
  await expect(page.getByRole("heading", { name: runId })).toBeVisible();
}

/** The canvas node for graph node `work`, addressed by the state Atlas last reported for it. */
function canvasNode(page: Page, runState: string) {
  return page.locator(`[data-testid="run-canvas"] [data-run-state="${runState}"]`);
}

test.describe("live run detail", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("canvas highlight follows Atlas runtime state through a running job", async ({
    page,
    request,
  }) => {
    // ~8 s of genuine execution: long enough to watch, bounded enough for CI.
    const runId = await startStubRun(request, "stub:count=20;interval=400");
    await openRun(page, runId);

    // The node lights up as running from Atlas's runtime record — reached via per-job SSE
    // events triggering the refetch, never via a browser timer.
    await expect(canvasNode(page, "running")).toBeVisible({ timeout: 15_000 });

    // Live events flow while it runs — and the status pill is a live region, so phase
    // transitions (streaming/stale/reconnecting/closed) are announced to screen readers
    // while individual SSE text frames stay silent (Phase 6).
    await expect(page.getByTestId("stream-status")).toHaveText(/streaming|connecting/, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("stream-status")).toHaveAttribute("role", "status");
    await expect(page.getByTestId("live-log").locator("li").first()).toBeVisible({
      timeout: 10_000,
    });

    // And it settles as succeeded when Atlas says so.
    await expect(canvasNode(page, "succeeded")).toBeVisible({ timeout: 30_000 });
  });

  test("refresh mid-run loses no persisted events and rebuilds live state", async ({
    page,
    request,
  }) => {
    const runId = await startStubRun(request, "stub:count=25;interval=400");
    await openRun(page, runId);
    await expect(canvasNode(page, "running")).toBeVisible({ timeout: 15_000 });

    // Atlas's persisted run history is on the page (the workflow-level events).
    const persistedRows = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Run events" }) })
      .locator("tbody tr");
    await expect.poll(async () => persistedRows.count(), { timeout: 15_000 }).toBeGreaterThan(0);

    // Reload mid-run: state is rebuilt from persisted history and current runtime nodes.
    await page.reload();
    await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });
    await expect.poll(async () => persistedRows.count(), { timeout: 15_000 }).toBeGreaterThan(0);
    // The live stream reattaches (replaying from seq 0 through the same proxy).
    await expect(page.getByTestId("live-log").locator("li").first()).toBeVisible({
      timeout: 15_000,
    });

    // After completion the historical view is still correct.
    await expect(canvasNode(page, "succeeded")).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });
    await expect(canvasNode(page, "succeeded")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => persistedRows.count(), { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test("a long stream stays bounded in the DOM", async ({ page, request }) => {
    // 600 events exceed the 500-event state cap and the 150-row render cap while the job is
    // still running (600 × 20 ms ≈ 12 s of stream time).
    const runId = await startStubRun(request, "stub:count=600;interval=20");
    await openRun(page, runId);

    const logRows = page.getByTestId("live-log").locator("li");
    await expect(logRows.first()).toBeVisible({ timeout: 15_000 });

    // Wait until the buffer has provably overflowed — the footer names the compaction.
    await expect(page.getByText(/older events compacted/)).toBeVisible({ timeout: 45_000 });

    // Bounded DOM: never more rows than the render cap, however many events streamed.
    expect(await logRows.count()).toBeLessThanOrEqual(150);

    await expect(canvasNode(page, "succeeded")).toBeVisible({ timeout: 30_000 });
  });

  test("a quiet stream stays live on Atlas keepalives, then completes", async ({
    page,
    request,
  }) => {
    // One quick frame, then 25 s without a domain event. Atlas sends a 15 s comment keepalive,
    // so transport health must stay live even though the timeline remains unchanged.
    const runId = await startStubRun(request, "stub:count=1;interval=0;stall=25000");
    await openRun(page, runId);
    await expect(canvasNode(page, "running")).toBeVisible({ timeout: 15_000 });

    // The idle watchdog is transport-only, and the keepalive resets it before the 15 s stale
    // threshold. The node — Atlas's record — stays running throughout.
    await expect(page.getByTestId("stream-status")).not.toHaveText(/stale/, { timeout: 22_000 });
    await expect(canvasNode(page, "running")).toBeVisible();

    // When the worker finally answers, the run completes for real.
    await expect(canvasNode(page, "succeeded")).toBeVisible({ timeout: 45_000 });
  });
});
