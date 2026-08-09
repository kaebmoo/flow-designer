import { expect, test, type APIRequestContext, type Cookie, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS } from "../contract/atlas-instance";
import { readSeed } from "./global-setup";

/**
 * Browser acceptance for Milestone C: Atlas's authoritative `workflow.interface`.
 *
 * File-order note, same rule `test-run.spec.ts` documents: this file creates its own workflows
 * through Atlas's API, so it must sort after `reads.spec.ts` (which asserts an under-25-row
 * window) and before `zz-live.spec.ts`/`zz-resilience.spec.ts`. Alphabetically it already does.
 *
 * Every run started here is a real Atlas run against the harness's deliberately unreachable
 * worker, so it fails within milliseconds — irrelevant to every case below, which asserts on the
 * synchronous create/start response and the persisted definition/run rows, never on completion.
 */

let cachedSeed: ReturnType<typeof readSeed> | undefined;
function seedIds() {
  cachedSeed ??= readSeed();
  return cachedSeed;
}

function atlasHeaders(): Record<string, string> {
  return { authorization: `Bearer ${seedIds().adminToken}` };
}

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** Signs in once for the whole file — see the identical rationale in `test-run.spec.ts`. */
let sessionCookies: Cookie[] | null = null;
async function signedIn(page: Page) {
  if (sessionCookies) {
    await page.context().addCookies(sessionCookies);
    return;
  }
  await signIn(page);
  sessionCookies = await page.context().cookies();
}

async function ready(page: Page) {
  await page.locator('[data-hydrated="true"]').waitFor({ state: "attached" });
}

const dirtyState = (page: Page) => page.getByTestId("workflow-dirty-state");
const dialog = (page: Page) => page.getByRole("dialog");
const testRunButton = (page: Page) => page.getByRole("button", { name: "Test run", exact: true });
const clickTestRun = async (page: Page) =>
  testRunButton(page).evaluate((button) => (button as HTMLButtonElement).click());

let workflowCounter = 0;

/** The two-node Permit shape: start node needs only required fields; downstream needs the rest. */
function permitGraph() {
  workflowCounter += 1;
  return {
    start: "intake",
    nodes: [
      {
        id: "intake",
        type: "worker",
        prompt: "applicant: {input.applicant_name} detail: {input.detail}",
        outputs: ["intake_review"],
      },
      {
        id: "assessment",
        type: "worker",
        prompt: "review {artifact.intake_review} context: {input.review_context}",
        outputs: ["assessment_result"],
      },
    ],
    edges: [{ from: "intake", to: "assessment", condition: { type: "always" } }],
  };
}

const PERMIT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["applicant_name", "detail"],
  properties: {
    applicant_name: { type: "string", minLength: 1 },
    detail: {
      type: "object",
      additionalProperties: false,
      required: ["floors"],
      properties: { floors: { type: "integer", minimum: 1 } },
    },
    review_context: { type: "string" },
  },
};

async function createWorkflow(
  request: APIRequestContext,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await request.post(`${seedIds().atlasOrigin}/api/workflows`, {
    headers: atlasHeaders(),
    data: {
      name: `Interface E2E ${workflowCounter + 1}`,
      description: "",
      graph: permitGraph(),
      policy: {},
      ...overrides,
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { workflow: { id: string } }).workflow.id;
}

async function openEditor(page: Page, workflowId: string) {
  await page.goto(`/workflows/${workflowId}`);
  await ready(page);
  await expect(dirtyState(page)).toHaveText("Saved", { timeout: 30_000 });
}

const openInterfacePanel = (page: Page) => page.getByTestId("open-interface-panel").click();

test.describe("workflow interface authoring", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test("authors a declared interface, saves it, and it survives a reload", async ({
    page,
    request,
  }) => {
    const id = await createWorkflow(request);
    await openEditor(page, id);
    await openInterfacePanel(page);

    await page.getByTestId("interface-add").click();
    const schemaField = page.getByTestId("interface-input-schema");
    await schemaField.fill(JSON.stringify(PERMIT_INPUT_SCHEMA));
    await page
      .getByTestId("interface-sample-input")
      .fill(JSON.stringify({ applicant_name: "Test Applicant", detail: { floors: 2 } }));

    // Graph-derived output table: declare the one produced by exactly one worker.
    const outputRow = page.getByTestId("interface-output-intake_review");
    await outputRow.getByRole("checkbox").check();

    await expect(dirtyState(page)).toHaveText("Unsaved changes");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(dirtyState(page)).toHaveText("Saved");

    await page.reload();
    await ready(page);
    await expect(dirtyState(page)).toHaveText("Saved", { timeout: 30_000 });
    await openInterfacePanel(page);
    await expect(page.getByTestId("interface-input-schema")).toHaveValue(
      new RegExp(PERMIT_INPUT_SCHEMA.properties.applicant_name.type),
    );
    await expect(
      page.getByTestId("interface-output-intake_review").getByRole("checkbox"),
    ).toBeChecked();

    // Confirmed against Atlas directly, not only the UI's own re-render.
    const stored = await request.get(`${seedIds().atlasOrigin}/api/workflows/${id}`, {
      headers: atlasHeaders(),
    });
    const { workflow } = (await stored.json()) as {
      workflow: { interface: { schema_version: number } };
    };
    expect(workflow.interface.schema_version).toBe(1);
  });

  test("warns that sample_input is synthetic and persisted, not private", async ({
    page,
    request,
  }) => {
    const id = await createWorkflow(request);
    await openEditor(page, id);
    await openInterfacePanel(page);
    await page.getByTestId("interface-add").click();

    const text = await page.getByTestId("interface-panel").innerText();
    expect(text.toLowerCase()).toContain("synthetic");
    expect(text.toLowerCase()).toMatch(/persist|export/);
  });

  test("clearing an authored interface sends an explicit null and returns to Observed", async ({
    page,
    request,
  }) => {
    const id = await createWorkflow(request, {
      interface: {
        schema_version: 1,
        input_schema: PERMIT_INPUT_SCHEMA,
        outputs: [{ key: "intake_review", kind: "text" }],
      },
    });
    await openEditor(page, id);
    await openInterfacePanel(page);
    await expect(page.getByTestId("interface-panel")).toBeVisible();

    await page.getByTestId("interface-clear").click();
    await expect(page.getByTestId("interface-add")).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(dirtyState(page)).toHaveText("Saved");

    const stored = await request.get(`${seedIds().atlasOrigin}/api/workflows/${id}`, {
      headers: atlasHeaders(),
    });
    const { workflow } = (await stored.json()) as { workflow: { interface: unknown } };
    expect(workflow.interface).toBeNull();

    // Test Run falls back to Observed.
    await clickTestRun(page);
    await page.getByRole("tab", { name: "Integration" }).click();
    await expect(page.getByTestId("observed-badge")).toContainText(
      "Observed · not enforced by Atlas",
    );
  });

  test("clearing an interface added and saved earlier in the same session clears it at Atlas", async ({
    page,
    request,
  }) => {
    // Regression: the editor does not remount on a successful save, so the null-vs-omit decision
    // must come from the live baseline comparison, not a "had one at mount" flag — with the flag,
    // this exact sequence saved `interface: undefined` (preserve) and Atlas kept the interface
    // while the panel claimed it was gone.
    const id = await createWorkflow(request);
    await openEditor(page, id);
    await openInterfacePanel(page);

    await page.getByTestId("interface-add").click();
    await page.getByTestId("interface-input-schema").fill(JSON.stringify(PERMIT_INPUT_SCHEMA));
    await page.getByRole("button", { name: "Save" }).click();
    await expect(dirtyState(page)).toHaveText("Saved");

    await page.getByTestId("interface-clear").click();
    await expect(page.getByTestId("interface-add")).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(dirtyState(page)).toHaveText("Saved");

    const stored = await request.get(`${seedIds().atlasOrigin}/api/workflows/${id}`, {
      headers: atlasHeaders(),
    });
    const { workflow } = (await stored.json()) as { workflow: { interface: unknown } };
    expect(workflow.interface).toBeNull();
  });

  /**
   * Not covered here, and why: an "unrecognised schema_version" interface panel is exercised at
   * the unit level instead (`tests/unit/workflow-interface-contract.test.ts`, "marks an
   * unrecognised schema_version as unsupported" / "never re-sends an unsupported-version
   * interface"). Atlas's own `validate_interface_document` rejects `schema_version !== 1`
   * outright at write time (strict equality, not a floor, per ADR 0002 §1) — confirmed directly
   * against this harness's real Atlas, which answers 400 to a create attempting `schema_version:
   * 99`. So this state can only ever be produced by a *future* Atlas this client does not yet
   * exist to talk to; reproducing it here would mean faking the TanStack Start SSR loader payload
   * (the editor route's first load is embedded in the HTML, not a separately interceptable
   * `_serverFn` request), which would test a fabrication of the network layer rather than the
   * real one. The unit tests exercise the exact same mapper and panel-draft code this page runs.
   */

  test("warns about declared/observed drift by naming the exact output", async ({
    page,
    request,
  }) => {
    // Declares only assessment_result, while the graph also produces intake_review.
    const id = await createWorkflow(request, {
      interface: {
        schema_version: 1,
        input_schema: PERMIT_INPUT_SCHEMA,
        outputs: [{ key: "assessment_result", kind: "text" }],
      },
    });
    await openEditor(page, id);
    await openInterfacePanel(page);

    const drift = page.getByTestId("interface-drift");
    await expect(drift).toBeVisible();
    await expect(drift).toContainText("intake_review");
  });
});

test.describe("declared Test Run mode", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test("prefills sample_input, labels Declared, and submits with expected_workflow_version", async ({
    page,
    request,
  }) => {
    const id = await createWorkflow(request, {
      interface: {
        schema_version: 1,
        input_schema: PERMIT_INPUT_SCHEMA,
        sample_input: { applicant_name: "Sample Applicant", detail: { floors: 2 } },
        outputs: [{ key: "intake_review", kind: "text" }],
        primary_output: "intake_review",
      },
    });
    await openEditor(page, id);
    await clickTestRun(page);

    await expect(page.getByTestId("test-run-input")).toHaveValue(/Sample Applicant/);
    await page.getByRole("tab", { name: "Integration" }).click();
    await expect(page.getByTestId("declared-badge")).toContainText("Declared · enforced by Atlas");
    await expect(page.getByTestId("declared-outputs")).toContainText("intake_review");
    await page.getByRole("tab", { name: "Input JSON" }).click();

    await page.getByTestId("start-test-run").click();
    await page.waitForURL(/\/runs\/wfr_[a-z0-9]+$/);

    const runId = new URL(page.url()).pathname.split("/").pop()!;
    const stored = await request.get(`${seedIds().atlasOrigin}/api/workflow-runs/${runId}`, {
      headers: atlasHeaders(),
    });
    const { run } = (await stored.json()) as {
      run: { workflow_version_snapshot: number; interface_snapshot: { schema_version: number } };
    };
    expect(run.interface_snapshot.schema_version).toBe(1);
    expect(run.workflow_version_snapshot).toBeGreaterThan(0);
  });

  test("blocks locally on a declared-schema violation before ever contacting Atlas", async ({
    page,
    request,
  }) => {
    const id = await createWorkflow(request, {
      interface: { schema_version: 1, input_schema: PERMIT_INPUT_SCHEMA },
    });
    await openEditor(page, id);
    await clickTestRun(page);

    await page.getByTestId("test-run-input").fill('{"applicant_name":"x"}'); // missing "detail"
    await expect(page.getByTestId("test-run-problem")).toContainText("detail");
    await expect(page.getByTestId("start-test-run")).toBeDisabled();
  });

  test("accepts raw nested JSON the declared schema allows, without a lossy form", async ({
    page,
    request,
  }) => {
    const id = await createWorkflow(request, {
      interface: { schema_version: 1, input_schema: PERMIT_INPUT_SCHEMA },
    });
    await openEditor(page, id);
    await clickTestRun(page);

    const nested = JSON.stringify({
      applicant_name: "Nested Test",
      detail: { floors: 4 },
      review_context: "extra context",
    });
    await page.getByTestId("test-run-input").fill(nested);
    await expect(page.getByTestId("test-run-input")).toHaveValue(/"floors":\s*4/);
    await expect(page.getByTestId("test-run-problem")).toHaveCount(0);
    await expect(page.getByTestId("start-test-run")).toBeEnabled();
  });

  test("presents a 400 from Atlas verbatim, with no automatic retry", async ({ page, request }) => {
    const id = await createWorkflow(request, {
      interface: { schema_version: 1, input_schema: PERMIT_INPUT_SCHEMA },
    });
    await openEditor(page, id);
    await clickTestRun(page);

    // The one declared-mode input that passes the local mirror but fails Atlas: the 1 MiB
    // effective-input cap is deliberately advisory client-side (a size *warning*, never a
    // blocked Start), while Atlas hard-rejects it. So this Start genuinely reaches Atlas and
    // the message below is Atlas's own 400 body, not the client's mirror.
    const oversized = JSON.stringify({
      applicant_name: "x".repeat(1_050_000),
      detail: { floors: 1 },
    });
    await page.getByTestId("test-run-input").fill(oversized);
    await expect(page.getByTestId("test-run-problem")).toHaveCount(0);
    await expect(page.getByTestId("start-test-run")).toBeEnabled();

    await page.getByTestId("start-test-run").click();
    const error = page.getByTestId("test-run-error");
    await expect(error).toBeVisible();
    // Atlas's own words (atlas/workflow_interface.py: "effective input exceeds ... bytes").
    await expect(error).toContainText(/effective input exceeds/i);
    // Still open, payload intact, button clickable again — shown once, never auto-retried.
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId("start-test-run")).toBeEnabled();
    // No run was created for this workflow: the 400 refused it before any row existed.
    const runs = await request.get(
      `${seedIds().atlasOrigin}/api/workflow-runs?workflow_definition_id=${id}`,
      { headers: atlasHeaders() },
    );
    const { runs: runRows } = (await runs.json()) as { runs: Array<{ id: string }> };
    expect(runRows).toHaveLength(0);
  });

  test("presents a 409 version conflict without retrying automatically", async ({
    page,
    request,
  }) => {
    const id = await createWorkflow(request, {
      interface: { schema_version: 1, input_schema: PERMIT_INPUT_SCHEMA },
    });
    await openEditor(page, id);
    await clickTestRun(page);
    await page.getByTestId("test-run-input").fill('{"applicant_name":"x","detail":{"floors":1}}');

    // Bump the version underneath the open dialog, exactly like editor.spec.ts's own conflict
    // case does for a save — here it is the *run start* that goes stale.
    const current = await request.get(`${seedIds().atlasOrigin}/api/workflows/${id}`, {
      headers: atlasHeaders(),
    });
    const { workflow } = (await current.json()) as {
      workflow: { version: number; name: string; graph: unknown; policy: unknown };
    };
    await request.put(`${seedIds().atlasOrigin}/api/workflows/${id}`, {
      headers: atlasHeaders(),
      data: {
        name: workflow.name,
        graph: workflow.graph,
        policy: workflow.policy,
        expected_version: workflow.version,
      },
    });

    await page.getByTestId("start-test-run").click();
    const error = page.getByTestId("test-run-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText(/conflict/i);
    // Still open, still holding the payload, and the button is clickable again rather than
    // having auto-resubmitted.
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId("start-test-run")).toBeEnabled();
  });

  test("never persists entered input, in declared mode either", async ({ page, request }) => {
    const id = await createWorkflow(request, {
      interface: { schema_version: 1, input_schema: PERMIT_INPUT_SCHEMA },
    });
    await openEditor(page, id);
    await clickTestRun(page);

    const marker = "MARKER-DECLARED-MUST-NOT-SURVIVE";
    await page
      .getByTestId("test-run-input")
      .fill(`{"applicant_name":"${marker}","detail":{"floors":1}}`);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toHaveCount(0);

    expect(
      await page.evaluate((needle) => {
        const scan = (store: Storage) =>
          Object.keys(store).some((key) => (store.getItem(key) ?? "").includes(needle));
        return scan(window.localStorage) || scan(window.sessionStorage);
      }, marker),
    ).toBe(false);
  });
});

test.describe("legacy observed mode after manager-prompt-parity", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  async function createManagerGraph(
    request: APIRequestContext,
    graph: Record<string, unknown>,
  ): Promise<string> {
    return createWorkflow(request, { graph });
  }

  test("blocks preflight when the start node is a manager missing its reference", async ({
    page,
    request,
  }) => {
    const id = await createManagerGraph(request, {
      start: "decide",
      nodes: [
        {
          id: "decide",
          type: "manager",
          schema: "manager_decision_v1",
          prompt: "Decide about {input.mode}.",
        },
        { id: "b", type: "worker", prompt: "done" },
      ],
      edges: [{ from: "decide", to: "b", condition: { type: "manager_selected", target: "b" } }],
    });
    await openEditor(page, id);
    await clickTestRun(page);
    await page.getByTestId("test-run-input").fill("{}");

    const problem = page.getByTestId("test-run-problem");
    await expect(problem).toContainText("input.mode");
    await expect(problem).toContainText("before any branch is chosen");
    await expect(page.getByTestId("start-test-run")).toBeDisabled();
  });

  test("only warns for a downstream manager's reference", async ({ page, request }) => {
    const id = await createManagerGraph(request, {
      start: "collect",
      nodes: [
        { id: "collect", type: "worker", prompt: "Gather the material." },
        {
          id: "decide",
          type: "manager",
          schema: "manager_decision_v1",
          prompt: "Decide using {input.tone}.",
        },
        { id: "b", type: "worker", prompt: "done" },
      ],
      edges: [
        { from: "collect", to: "decide", condition: { type: "always" } },
        { from: "decide", to: "b", condition: { type: "manager_selected", target: "b" } },
      ],
    });
    await openEditor(page, id);
    await clickTestRun(page);
    await page.getByTestId("test-run-input").fill("{}");

    const warnings = page.getByTestId("test-run-warnings");
    await expect(warnings).toContainText("input.tone");
    await expect(page.getByTestId("test-run-problem")).toHaveCount(0);
    await expect(page.getByTestId("start-test-run")).toBeEnabled();
  });
});

test.describe("historical run snapshot", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test("shows the run's frozen interface_snapshot, and says nothing after it is cleared", async ({
    page,
    request,
  }) => {
    const id = await createWorkflow(request, {
      interface: {
        schema_version: 1,
        input_schema: PERMIT_INPUT_SCHEMA,
        outputs: [
          { key: "intake_review", kind: "text" },
          { key: "assessment_result", kind: "text" },
        ],
        primary_output: "assessment_result",
      },
    });
    const started = await request.post(`${seedIds().atlasOrigin}/api/workflow-runs`, {
      headers: atlasHeaders(),
      data: {
        workflow_definition_id: id,
        input: { applicant_name: "Snapshot Test", detail: { floors: 1 } },
      },
    });
    expect(started.status()).toBe(202);
    const { run } = (await started.json()) as { run: { id: string } };

    // Clear the live interface after the run started.
    const current = await request.get(`${seedIds().atlasOrigin}/api/workflows/${id}`, {
      headers: atlasHeaders(),
    });
    const { workflow } = (await current.json()) as {
      workflow: { version: number; name: string; graph: unknown; policy: unknown };
    };
    await request.put(`${seedIds().atlasOrigin}/api/workflows/${id}`, {
      headers: atlasHeaders(),
      data: {
        name: workflow.name,
        graph: workflow.graph,
        policy: workflow.policy,
        interface: null,
        expected_version: workflow.version,
      },
    });

    await signedIn(page);
    await page.goto(`/runs/${run.id}`);
    await ready(page);

    const present = page.getByTestId("run-interface-present");
    await expect(present).toBeVisible();
    await expect(present).toContainText("schema_version");
    await expect(present).toContainText("1");

    // The live workflow now has no interface, but the run detail still shows its own snapshot —
    // proof this reads the run row, never the current live definition.
    const liveCheck = await request.get(`${seedIds().atlasOrigin}/api/workflows/${id}`, {
      headers: atlasHeaders(),
    });
    expect(
      ((await liveCheck.json()) as { workflow: { interface: unknown } }).workflow.interface,
    ).toBeNull();
    await expect(present).toBeVisible();
  });

  test("says no authoritative contract is available for a legacy run", async ({
    page,
    request,
  }) => {
    const id = await createWorkflow(request, { interface: null });
    const started = await request.post(`${seedIds().atlasOrigin}/api/workflow-runs`, {
      headers: atlasHeaders(),
      data: { workflow_definition_id: id, input: {} },
    });
    const { run } = (await started.json()) as { run: { id: string } };

    await page.goto(`/runs/${run.id}`);
    await ready(page);
    await expect(page.getByTestId("run-interface-absent")).toBeVisible();
  });
});
