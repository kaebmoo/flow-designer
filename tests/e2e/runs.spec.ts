import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS } from "../contract/atlas-instance";
import { readSeed } from "./global-setup";

/**
 * Browser acceptance for the run detail page's operator actions.
 *
 * The whole harness has exactly one worker and it is deliberately unreachable, so a run whose
 * start node calls a worker fails within milliseconds and is terminal before a browser can be
 * pointed at it. The fixture that makes this page testable is a workflow whose `graph.start` is
 * itself a `human_gate`: Atlas's executor creates the approval and parks the run in
 * `waiting_for_human` *before* it resolves any worker (`atlas/workflows.py:986-1000`), so the run
 * reaches a stable, non-terminal state that an operator can genuinely act on.
 *
 * Nothing here sleeps for a fixed interval hoping a state arrives. Where Atlas continues a run on
 * its own thread, the test polls Atlas's own read route against a bounded deadline and fails with
 * the state it actually saw.
 *
 * **Not covered, and why:**
 *  - Pause and resume of a *running* run, and the whole `recovery_required` path. Reaching
 *    `running` for long enough to press a button needs a worker that accepts a job and does not
 *    answer immediately; this harness has none, and faking one would test the fake.
 *  - A delivery that is attempted, retried, or delivered. That needs an outbound receiver on
 *    Atlas's allowlist. Only the refusal path is asserted here.
 *  - Artifact download. A gate-only run produces no artifacts, and a `file_ref` artifact needs a
 *    worker to write the file Atlas would then serve.
 */

/** Read lazily, so `playwright test --list` does not need the seed file. See `reads.spec.ts`. */
let cachedSeed: ReturnType<typeof readSeed> | undefined;
function seedIds() {
  cachedSeed ??= readSeed();
  return cachedSeed;
}

/**
 * `connection: close` is the Atlas keep-alive desync workaround the production client applies
 * too — a rejected POST otherwise poisons the reused connection. See `docs/ATLAS_LIMITATIONS.md`.
 */
function atlasHeaders(): Record<string, string> {
  return { authorization: `Bearer ${seedIds().adminToken}`, connection: "close" };
}

interface AtlasRunDetail {
  run: {
    id: string;
    state: string;
    error: string | null;
    current_nodes: string[];
  };
  nodes: Array<{ node_key: string; state: string }>;
  approvals: Array<{
    id: string;
    node_key: string;
    state: string;
    selected_choice: string | null;
    choices: Array<{ id: string; label: string }>;
  }>;
}

interface AtlasRunEventPage {
  events: Array<{ seq: number }>;
  after: number;
  next_after: number | null;
  has_more: boolean;
}

async function atlasRun(request: APIRequestContext, runId: string): Promise<AtlasRunDetail> {
  const response = await request.get(`${seedIds().atlasOrigin}/api/workflow-runs/${runId}`, {
    headers: atlasHeaders(),
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as AtlasRunDetail;
}

async function atlasRunEvents(
  request: APIRequestContext,
  runId: string,
  after: number,
  limit: number,
): Promise<AtlasRunEventPage> {
  const response = await request.get(
    `${seedIds().atlasOrigin}/api/workflow-runs/${runId}/events?after=${after}&limit=${limit}`,
    { headers: atlasHeaders() },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as AtlasRunEventPage;
}

/**
 * Polls Atlas until `settled` holds, or fails naming the state it last saw.
 *
 * A bounded deadline rather than a fixed sleep: Atlas continues a run on a background thread
 * whose timing is not a contract, so "wait 2 seconds and assert" is either flaky or slow, and
 * always silent about which.
 */
async function untilRun(
  request: APIRequestContext,
  runId: string,
  what: string,
  settled: (detail: AtlasRunDetail) => boolean,
  timeoutMs = 20_000,
): Promise<AtlasRunDetail> {
  const deadline = Date.now() + timeoutMs;
  let last: AtlasRunDetail = await atlasRun(request, runId);
  for (;;) {
    if (settled(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} never reached ${what}; last state "${last.run.state}" with ` +
          `${last.approvals.length} approval(s)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    last = await atlasRun(request, runId);
  }
}

/** Builds a workflow directly in Atlas. The editor cannot draw every graph a run needs. */
async function createWorkflow(
  request: APIRequestContext,
  name: string,
  graph: unknown,
): Promise<string> {
  const response = await request.post(`${seedIds().atlasOrigin}/api/workflows`, {
    headers: atlasHeaders(),
    data: { name, description: "", graph, policy: {} },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { workflow: { id: string } }).workflow.id;
}

/** Starts a run and returns once Atlas has parked it at its opening human gate. */
async function startParkedRun(request: APIRequestContext, workflowId: string): Promise<string> {
  const response = await request.post(`${seedIds().atlasOrigin}/api/workflow-runs`, {
    headers: atlasHeaders(),
    data: { workflow_definition_id: workflowId, input: {} },
  });
  expect(response.status()).toBe(202);
  const runId = ((await response.json()) as { run: { id: string } }).run.id;
  await untilRun(request, runId, "waiting_for_human", (d) => d.run.state === "waiting_for_human");
  return runId;
}

let workflowCounter = 0;

/** A run parked at a gate that declares no choices: approve or reject, nothing else. */
async function plainGateRun(request: APIRequestContext): Promise<string> {
  workflowCounter += 1;
  const workflowId = await createWorkflow(request, `E2E plain gate ${workflowCounter}`, {
    start: "gate",
    nodes: [
      {
        id: "gate",
        type: "human_gate",
        label: "Sign off",
        reason: "A person confirms before the run ends.",
      },
    ],
    edges: [],
  });
  return startParkedRun(request, workflowId);
}

/** A run parked at a gate that declares choices, each routing into a further gate. */
async function branchingGateRun(request: APIRequestContext): Promise<string> {
  workflowCounter += 1;
  const workflowId = await createWorkflow(request, `E2E branching gate ${workflowCounter}`, {
    start: "choose",
    nodes: [
      {
        id: "choose",
        type: "human_gate",
        label: "Pick a branch",
        choices: [
          { id: "go", label: "Continue" },
          { id: "stop", label: "Stop here" },
        ],
      },
      { id: "confirm", type: "human_gate", label: "Confirm" },
      { id: "halt", type: "human_gate", label: "Halt" },
    ],
    edges: [
      { from: "choose", to: "confirm", condition: { type: "human_selected", choice: "go" } },
      { from: "choose", to: "halt", condition: { type: "human_selected", choice: "stop" } },
    ],
  });
  return startParkedRun(request, workflowId);
}

/**
 * Walks six real human-gate transitions. Each produces node, approval, edge, and completion
 * history, so the resulting persisted history is safely larger than a 25-row cursor page.
 */
async function pagedHistoryRun(request: APIRequestContext): Promise<string> {
  workflowCounter += 1;
  const gates = Array.from({ length: 6 }, (_, index) => ({
    id: `gate_${index + 1}`,
    type: "human_gate",
    label: `Gate ${index + 1}`,
  }));
  const edges = gates.slice(0, -1).map((gate, index) => ({
    from: gate.id,
    to: gates[index + 1]!.id,
    condition: { type: "always" },
  }));
  const workflowId = await createWorkflow(request, `E2E paged history ${workflowCounter}`, {
    start: gates[0]!.id,
    nodes: gates,
    edges,
  });
  const runId = await startParkedRun(request, workflowId);

  for (let index = 0; index < gates.length; index += 1) {
    const detail = await untilRun(request, runId, `pending ${gates[index]!.id}`, (run) =>
      run.approvals.some(
        (approval) => approval.node_key === gates[index]!.id && approval.state === "pending",
      ),
    );
    const approval = detail.approvals.find(
      (item) => item.node_key === gates[index]!.id && item.state === "pending",
    );
    expect(approval).toBeDefined();
    const response = await request.post(
      `${seedIds().atlasOrigin}/api/approvals/${approval!.id}/approve`,
      { headers: atlasHeaders(), data: {} },
    );
    expect(response.status()).toBe(202);
  }

  await untilRun(request, runId, "succeeded", (detail) => detail.run.state === "succeeded");
  return runId;
}

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** The run page is server-rendered, so its controls are clickable before React owns them. */
async function openRun(page: Page, runId: string) {
  await page.goto(`/runs/${runId}`);
  await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });
  await expect(page.getByRole("heading", { name: runId })).toBeVisible();
}

/** Each panel is a `<section>` headed by its own `h2`; this is how one is addressed. */
function section(page: Page, heading: RegExp): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: heading }) });
}

test.describe("run detail", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("a gate with no choices offers Approve and Reject", async ({ page, request }) => {
    const runId = await plainGateRun(request);
    const detail = await atlasRun(request, runId);
    // The premise, read from Atlas rather than assumed: one pending approval, no choices.
    expect(detail.approvals).toHaveLength(1);
    expect(detail.approvals[0]!.state).toBe("pending");
    expect(detail.approvals[0]!.choices).toEqual([]);

    await openRun(page, runId);
    const approvals = section(page, /^Approvals/);
    await expect(approvals).toContainText("Sign off");
    await expect(approvals.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(approvals.getByRole("button", { name: "Reject" })).toBeVisible();
  });

  test("cursor event history reveals rows incrementally and keeps them while loading the next page", async ({
    page,
    request,
  }) => {
    const runId = await pagedHistoryRun(request);
    const firstPage = await atlasRunEvents(request, runId, 0, 25);
    expect(firstPage.events).toHaveLength(25);
    expect(firstPage.has_more).toBe(true);
    expect(firstPage.next_after).toBe(firstPage.events.at(-1)?.seq);

    await openRun(page, runId);
    const history = section(page, /^Run events$/);
    const rows = history.locator("tbody tr");

    // The server's 500-row window is only a memory cap. The DOM begins at PAGE_STEP rows.
    await expect(rows).toHaveCount(25);
    await history.getByRole("button", { name: "Show 6 more events" }).click();
    await expect(rows).toHaveCount(31);

    // Choose a 25-row cursor page, then hold the real server-function request before it reaches
    // Atlas. This makes the intermediate loading state deterministic without substituting data.
    await history.getByRole("button", { name: "25", exact: true }).click();
    await expect(rows).toHaveCount(25);
    const loadMore = history.getByRole("button", { name: "Load more events" });
    await expect(loadMore).toBeVisible();

    let releaseRequest: (() => void) | undefined;
    const requestHeld = new Promise<void>((resolve) => {
      void page.route("**/_serverFn/**", async (route) => {
        const encoded = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
        const functionName = Buffer.from(encoded, "base64").toString();
        if (functionName.includes("listRunEventsFn")) {
          resolve();
          await new Promise<void>((release) => {
            releaseRequest = release;
          });
        }
        await route.continue();
      });
    });

    await loadMore.click();
    await requestHeld;
    await expect(rows).toHaveCount(25);
    await expect(history.getByText("Loading run events")).toHaveCount(0);

    releaseRequest?.();
    await expect(loadMore).toHaveCount(0);
    await expect(rows).toHaveCount(25);
    await history.getByRole("button", { name: "Show 6 more events" }).click();
    await expect(rows).toHaveCount(31);
  });

  /**
   * Atlas raises "approval requires a branch choice" on `approve` for a gate that declares
   * choices (`atlas/workflows.py:627`), so offering Approve here would be offering a button that
   * cannot work. The refusal is put to Atlas directly, so the absent button is Atlas's rule and
   * not a frontend opinion that could drift out of date.
   */
  test("a gate with choices offers the choices and not Approve", async ({ page, request }) => {
    const runId = await branchingGateRun(request);
    const detail = await atlasRun(request, runId);
    const approval = detail.approvals[0]!;
    expect(approval.choices.map((choice) => choice.id)).toEqual(["go", "stop"]);

    await openRun(page, runId);
    const approvals = section(page, /^Approvals/);
    await expect(approvals.getByRole("button", { name: "Continue" })).toBeVisible();
    await expect(approvals.getByRole("button", { name: "Stop here" })).toBeVisible();
    await expect(approvals.getByRole("button", { name: "Approve" })).toHaveCount(0);
    // A rejection is available on both kinds of gate.
    await expect(approvals.getByRole("button", { name: "Reject" })).toBeVisible();

    const refused = await request.post(
      `${seedIds().atlasOrigin}/api/approvals/${approval.id}/approve`,
      { headers: atlasHeaders(), data: {} },
    );
    expect(refused.status()).toBe(400);
    expect(await refused.text()).toContain("approval requires a branch choice");
  });

  test("rejecting is confirmed first, says it fails the run, and Atlas really fails it", async ({
    page,
    request,
  }) => {
    const runId = await plainGateRun(request);
    await openRun(page, runId);

    await section(page, /^Approvals/)
      .getByRole("button", { name: "Reject" })
      .click();

    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Reject this gate and fail the run?");
    // Not "no, take the other branch" — the dialog has to say the whole run dies.
    await expect(confirm).toContainText("finalizes the whole run as");
    await expect(confirm).toContainText("human approval rejected at gate");
    await expect(confirm).toContainText("cannot be resumed afterwards");

    await confirm.getByRole("button", { name: "Reject and fail the run" }).click();

    // Atlas's own record, not the page's: `reject_approval` finalizes the run synchronously.
    const after = await untilRun(request, runId, "failed", (d) => d.run.state === "failed");
    expect(after.run.error).toBe("human approval rejected at gate");
    expect(after.approvals[0]!.state).toBe("rejected");
    expect(after.nodes[0]!.state).toBe("failed");

    await expect(page.getByText("human approval rejected at gate").first()).toBeVisible();
  });

  test("a chosen decision moves the run on to the next gate", async ({ page, request }) => {
    const runId = await branchingGateRun(request);
    await openRun(page, runId);

    await section(page, /^Approvals/)
      .getByRole("button", { name: "Continue" })
      .click();

    // Atlas continues the run on a fresh thread after the decision, so the second gate appears
    // asynchronously — polled, never slept on.
    const after = await untilRun(
      request,
      runId,
      "a second gate",
      (detail) => detail.approvals.length === 2 && detail.run.state === "waiting_for_human",
    );
    const chosen = after.approvals.find((approval) => approval.node_key === "choose")!;
    expect(chosen.state).toBe("chosen");
    expect(chosen.selected_choice).toBe("go");
    // The "go" edge, and only it: the run is now parked on `confirm`, and `halt` was never
    // scheduled. (`current_nodes` is not the witness for that — `_wait_for_human` stores the
    // *other* ready nodes there, so a run parked at a gate reports an empty list.)
    const next = after.approvals.find((approval) => approval.node_key !== "choose")!;
    expect(next.node_key).toBe("confirm");
    expect(next.state).toBe("pending");

    await page.reload();
    await openRun(page, runId);
    const approvals = section(page, /^Approvals/);
    await expect(approvals.getByRole("row").filter({ hasText: "Pick a branch" })).toContainText(
      "chosen",
    );
    await expect(approvals.getByRole("row").filter({ hasText: "Pick a branch" })).toContainText(
      "go",
    );
    // The second gate is now the pending one, and it has a runtime node of its own — the run
    // really moved rather than merely recording a decision.
    await expect(approvals.getByRole("row").filter({ hasText: "Confirm" })).toContainText(
      "pending",
    );
    await expect(section(page, /^Runtime nodes/).getByRole("row")).toHaveCount(3);
  });

  /**
   * Pause and resume are refused by Atlas from `waiting_for_human` (`atlas/workflows.py:462,475`)
   * and cancel is not, so exactly one of the three is offered — and the two that are not say why
   * *in the page*. A `title` would not do: a disabled button has `pointer-events: none`, so its
   * tooltip is unreachable by hover, and unreachable entirely by anyone not using a mouse.
   */
  test("only the transitions Atlas permits are offered, and the rest give a visible reason", async ({
    page,
    request,
  }) => {
    const runId = await plainGateRun(request);
    await openRun(page, runId);

    const controls = section(page, /^Run control$/);
    await expect(controls.getByRole("button", { name: "Pause" })).toBeDisabled();
    await expect(controls.getByRole("button", { name: "Resume" })).toBeDisabled();
    await expect(controls.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();

    // Rendered text, not an attribute.
    await expect(controls).toContainText(
      'Atlas pauses a run only from "running"; this one is "waiting_for_human".',
    );
    await expect(controls).toContainText(
      'Atlas resumes a run only from "paused" or "recovery_required"; this one is "waiting_for_human".',
    );

    // Atlas's own refusal, so the disabled state is not the frontend inventing a rule.
    const pause = await request.post(`${seedIds().atlasOrigin}/api/workflow-runs/${runId}/pause`, {
      headers: atlasHeaders(),
      data: {},
    });
    expect(pause.status()).toBe(400);
    expect(await pause.text()).toContain(`workflow run ${runId} cannot be paused from`);

    await controls.getByRole("button", { name: "Cancel", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Cancel this run?");
    await confirm.getByRole("button", { name: "Cancel the run" }).click();

    const after = await untilRun(
      request,
      runId,
      "cancelled with its approval resolved",
      (d) =>
        d.run.state === "cancelled" &&
        d.approvals.every((approval) => approval.state !== "pending"),
    );
    expect(after.run.state).toBe("cancelled");
    // Cancelling closes the approval it was parked on, so nothing is left pending.
    expect(after.approvals[0]!.state).not.toBe("pending");

    // And the page now refuses the cancel it just performed, for the reason Atlas would give.
    await expect(controls.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await expect(controls).toContainText('The run already finished as "cancelled"');
  });

  test("a node's state pill is the state Atlas reports for it", async ({ page, request }) => {
    const runId = await branchingGateRun(request);
    const detail = await atlasRun(request, runId);
    expect(detail.nodes.length).toBeGreaterThan(0);

    await openRun(page, runId);
    const nodes = section(page, /^Runtime nodes/);
    for (const node of detail.nodes) {
      // One row per runtime node, carrying exactly the state Atlas holds — not a state derived
      // from the run's own state or from how long the page has been open.
      await expect(nodes.getByRole("row").filter({ hasText: node.node_key })).toContainText(
        node.state,
      );
    }
  });

  /** Cursor paging is visible in the UI; the DOM remains bounded as history grows. */
  test("the run event list uses cursor paging and a bounded DOM", async ({ page, request }) => {
    const runId = await plainGateRun(request);
    await openRun(page, runId);

    const events = section(page, /^Run events$/);
    for (const option of ["25", "100", "500"]) {
      await expect(events.getByRole("button", { name: option, exact: true })).toBeVisible();
    }

    await expect(events).toContainText("exclusive sequence cursor");

    await events.getByRole("button", { name: "25", exact: true }).click();
    await expect(events).toContainText("exclusive sequence cursor");

    // A header row plus the bounded history cap — never an unbounded list.
    const rendered = await events.getByRole("row").count();
    expect(rendered).toBeGreaterThan(1);
    expect(rendered).toBeLessThanOrEqual(501);
  });

  /**
   * The refusal an operator would otherwise discover by pressing a button.
   *
   * The page states the reason up front, and the point of this test is that the stated reason is
   * Atlas's real one: the same run is offered to Atlas's deliver route, which refuses it with the
   * sentence the page is paraphrasing. A UI that pre-empted the wrong condition would pass the
   * first half of this test and fail the second.
   */
  test("deliver is refused for a run with no reply callback url, and Atlas agrees", async ({
    page,
    request,
  }) => {
    const runId = await plainGateRun(request);
    const approvalId = (await atlasRun(request, runId)).approvals[0]!.id;
    // Driven through Atlas rather than the UI: the browser path for a rejection is covered by
    // its own test above, and what this one needs is only a *terminal* run — otherwise the
    // "has not completed yet" refusal masks the one under test.
    const rejected = await request.post(
      `${seedIds().atlasOrigin}/api/approvals/${approvalId}/reject`,
      { headers: atlasHeaders(), data: {} },
    );
    expect(rejected.status()).toBe(200);
    await untilRun(request, runId, "failed", (d) => d.run.state === "failed");

    await openRun(page, runId);
    const deliveries = section(page, /^Webhook delivery attempts$/);
    await expect(deliveries.getByRole("button", { name: "Send webhook now" })).toBeDisabled();
    await expect(deliveries).toContainText(
      "This run carries no _meta.reply.callback_url, so Atlas has no address to deliver to.",
    );
    await expect(deliveries).toContainText("Atlas has not opened a webhook delivery for this run.");

    const refused = await request.post(
      `${seedIds().atlasOrigin}/api/workflow-runs/${runId}/deliver`,
      { headers: atlasHeaders(), data: {} },
    );
    expect(refused.status()).toBe(400);
    expect(await refused.text()).toContain(
      "workflow run has no _meta.reply.callback_url configured",
    );
  });
});
