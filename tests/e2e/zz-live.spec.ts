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
import {
  managerPlaceholderProbeGraph,
  PERMIT_APPLICATION_INPUT,
  permitApplicationContractV1,
} from "../fixtures/workflow-graphs";
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

/** Saves an arbitrary graph and returns its Atlas id, for the dialog-driven cases below. */
async function createWorkflow(
  request: APIRequestContext,
  graph: Record<string, unknown>,
): Promise<string> {
  workflowCounter += 1;
  const response = await request.post(`${seedIds().atlasOrigin}/api/workflows`, {
    headers: atlasHeaders(),
    data: { name: `E2E live ${workflowCounter}`, description: "", graph, policy: {} },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { workflow: { id: string } }).workflow.id;
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

  /**
   * Milestone A's acceptance case, end to end, through the real dialog.
   *
   * Everything here is production path: a two-node permit workflow saved in Atlas, the Test Run
   * dialog filled in by hand, one explicit start, and then the run page left alone. The payload
   * is deliberately Thai — a coercion or an encoding bug anywhere between the textarea and
   * SQLite shows up as mangled text rather than as a passing test.
   */
  test("a permit application runs from the dialog and shows both outputs without a reload", async ({
    page,
    request,
  }) => {
    const workflowId = await createWorkflow(request, permitApplicationContractV1(stubWorkerId));

    await page.goto(`/workflows/${workflowId}`);
    await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });
    await expect(page.getByTestId("workflow-dirty-state")).toHaveText("Saved", { timeout: 30_000 });

    await page.getByRole("button", { name: "Test run", exact: true }).click();

    // All four fields are rendered by the start node, so an empty object must block first.
    await page.getByTestId("test-run-input").fill("{}");
    const problem = page.getByTestId("test-run-problem");
    for (const field of Object.keys(PERMIT_APPLICATION_INPUT)) {
      await expect(problem).toContainText(`input.${field}`);
    }
    await expect(page.getByTestId("start-test-run")).toBeDisabled();

    await page
      .getByTestId("test-run-input")
      .fill(JSON.stringify(PERMIT_APPLICATION_INPUT, null, 2));
    await expect(problem).toHaveCount(0);
    await page.getByTestId("start-test-run").click();

    await page.waitForURL(/\/runs\/wfr_[a-z0-9]+$/);
    const runId = new URL(page.url()).pathname.split("/").pop()!;

    // Atlas persisted every field exactly as typed, Thai text included.
    const stored = await request.get(`${seedIds().atlasOrigin}/api/workflow-runs/${runId}`, {
      headers: atlasHeaders(),
    });
    const { run } = (await stored.json()) as { run: { input: Record<string, unknown> } };
    const { _meta, ...business } = run.input;
    expect(business).toEqual(PERMIT_APPLICATION_INPUT);

    // The page is already open and is never reloaded below.
    const artifacts = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Artifacts" }) });
    await expect(artifacts.getByText("This run produced no artifacts.")).toBeVisible();

    // Both nodes' outputs arrive on their own, and both are marked as observed for this graph.
    await expect(artifacts.getByText("intake_review", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(artifacts.getByText("assessment_result", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("observed-output-intake_review")).toBeVisible();
    await expect(page.getByTestId("observed-output-assessment_result")).toBeVisible();
    await expect(artifacts.locator("tbody tr")).toHaveCount(2);

    // The bounded input preview is on this page, collapsed, and carries the Thai text intact.
    await page.getByText("Show the input this run was started with").click();
    await expect(page.getByTestId("run-input-preview")).toContainText(
      PERMIT_APPLICATION_INPUT.applicant_name,
    );
  });

  /**
   * What Atlas *renders* for a manager node, captured from the wire.
   *
   * `_prepare_worker_node_payload` (`atlas/workflows.py:1614-1618`) sends a manager node to
   * `_manager_prompt`, which never calls `render_prompt`. So an authored `{input.routing_hint}`
   * is not substituted — and this asserts it against the actual `/agent/run` body the stub
   * received, not against a reading of the source. If a future Atlas starts substituting there,
   * this test fails and `docs/ATLAS_LIMITATIONS.md` needs revisiting.
   */
  test("a manager prompt reaches the worker with {input.*} still literal", async ({
    page,
    request,
  }) => {
    const workflowId = await createWorkflow(request, managerPlaceholderProbeGraph(stubWorkerId));
    stub.resetPrompts();

    await page.goto(`/workflows/${workflowId}`);
    await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });
    await expect(page.getByTestId("workflow-dirty-state")).toHaveText("Saved", { timeout: 30_000 });

    await page.getByRole("button", { name: "Test run", exact: true }).click();

    // The dialog does not ask for it, because Atlas would ignore it...
    await expect(page.getByTestId("test-run-input")).toHaveValue(/^\{\s*\}\s*$/);
    await page.getByRole("tab", { name: "Integration" }).click();
    await expect(page.getByTestId("observed-diagnostics")).toContainText("literally");
    await expect(page.getByTestId("observed-input-paths")).toHaveCount(0);

    // ...so a value is supplied anyway, to prove supplying it changes nothing.
    await page.getByRole("tab", { name: "Input JSON" }).click();
    await page.getByTestId("test-run-input").fill('{"routing_hint":"SHOULD-NOT-BE-SUBSTITUTED"}');
    await page.getByTestId("start-test-run").click();
    await page.waitForURL(/\/runs\/wfr_[a-z0-9]+$/);

    await expect.poll(() => stub.promptsSeen().length, { timeout: 60_000 }).toBeGreaterThan(0);

    const managerPrompt = stub.promptsSeen()[0]!;
    // The authored placeholder arrived verbatim...
    expect(managerPrompt).toContain("{input.routing_hint}");
    // ...and the value the operator supplied never reached the model.
    expect(managerPrompt).not.toContain("SHOULD-NOT-BE-SUBSTITUTED");
    // It is genuinely the manager payload, not some other node's.
    expect(managerPrompt).toContain("manager_decision_v1");
  });

  /**
   * The terminal refresh happens once, and then stops.
   *
   * Invalidating a query re-renders the component that invalidated it, so an effect keyed on the
   * refetched data would invalidate again — forever, hammering Atlas for as long as the tab is
   * open. The guard is a ref in `RunLiveSection`; this counts the artifact requests that actually
   * leave the browser after the run is terminal and asserts the number stays small and stable.
   */
  test("the terminal artifact refresh fires once and does not loop", async ({ page, request }) => {
    const runId = await startStubRun(request, "stub:count=4;interval=200");

    let artifactRequests = 0;
    await page.route("**/_serverFn/**", async (route) => {
      const url = route.request().url();
      // The run-artifacts server function carries its name in the encoded URL segment.
      if (
        /listRunArtifacts/i.test(
          Buffer.from(url.split("/_serverFn/")[1] ?? "", "base64url").toString("utf8"),
        )
      ) {
        artifactRequests += 1;
      }
      await route.continue();
    });

    await openRun(page, runId);
    await expect(canvasNode(page, "succeeded")).toBeVisible({ timeout: 45_000 });
    await expect(
      page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "Artifacts" }) })
        .getByText("report", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    const afterTerminal = artifactRequests;
    // The run poll stops at terminal and no stream remains, so nothing should ask again.
    await page.waitForTimeout(6_000);

    expect(artifactRequests - afterTerminal, "artifact refetches after the run settled").toBe(0);
    // A loop would be in the hundreds; a handful is the initial load plus live invalidations.
    expect(afterTerminal, "total artifact refetches").toBeLessThan(12);
  });

  /**
   * The artifact a run produces has to appear on the page that is already open.
   *
   * Before this, `RunLiveSection` invalidated the run detail and its events but not its
   * artifacts, so the outputs table kept showing the set that existed when the page loaded — an
   * empty one, for a run opened while it was still working — and the only way to see the result
   * was a manual reload. That is precisely the moment a test run is meant to answer.
   *
   * `page.reload()` is deliberately absent below.
   */
  test("an artifact produced after the page loads appears without a reload", async ({
    page,
    request,
  }) => {
    // Slow enough that the page is open, and the table is empty, well before the node finishes.
    const runId = await startStubRun(request, "stub:count=15;interval=400");
    await openRun(page, runId);

    const artifacts = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Artifacts" }) });

    // The run is still working, so Atlas has written nothing yet.
    await expect(canvasNode(page, "running")).toBeVisible({ timeout: 15_000 });
    await expect(artifacts.getByText("This run produced no artifacts.")).toBeVisible();

    // The stub's node declares `outputs: ["report"]`, so a successful run writes that key.
    await expect(canvasNode(page, "succeeded")).toBeVisible({ timeout: 45_000 });
    await expect(artifacts.getByText("report", { exact: true })).toBeVisible({ timeout: 20_000 });

    // The complete table survives: the row still carries its kind, size, and content actions.
    await expect(artifacts.locator("tbody tr")).toHaveCount(1);
    await expect(artifacts.getByRole("button", { name: /Preview/i })).toBeVisible();
  });
});
