import { expect, test, type APIRequestContext, type Cookie, type Page } from "@playwright/test";

import { ADMIN_CREDENTIALS } from "../contract/atlas-instance";
import { startStubWorker, type StubWorker } from "../fixtures/thclaws-stub";
import { readSeed } from "./global-setup";

/**
 * File-order note: this spec creates workflow rows, so it sorts after `reads.spec.ts`, whose
 * 25-row window assertion must see only the global seed. It sorts before `zz-live.spec.ts` and
 * `zz-resilience.spec.ts`, which stay last because they add workers and exercise teardown.
 *
 * Resume coverage uses the existing `/agent/run` stub. The stub does not implement `/v1/inputs`,
 * so this spec deliberately uses a single worker with no `push_files` edge; the real
 * human-gate/file-handoff path remains covered by Atlas's live E2E and contract checks.
 */

let cachedSeed: ReturnType<typeof readSeed> | undefined;
function seed() {
  cachedSeed ??= readSeed();
  return cachedSeed;
}

function atlasHeaders(): Record<string, string> {
  return { authorization: `Bearer ${seed().adminToken}` };
}

let sessionCookies: Cookie[] | null = null;

async function signIn(page: Page) {
  await page.goto("/auth");
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached" });
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** Atlas limits concurrent sessions, so replay one authenticated cookie jar for this file. */
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

let workflowCounter = 0;
let stub: StubWorker;
let stubWorkerId = "";

function workerGraph(prompt = "stub:count=1;interval=0", includeWorker = true) {
  return {
    start: "work",
    nodes: [
      {
        id: "work",
        type: "worker",
        prompt,
        ...(includeWorker ? { worker_id: stubWorkerId } : {}),
        outputs: ["report"],
      },
    ],
    edges: [],
  };
}

async function createWorkflow(
  request: APIRequestContext,
  prompt?: string,
  includeWorker = true,
): Promise<string> {
  workflowCounter += 1;
  const response = await request.post(`${seed().atlasOrigin}/api/workflows`, {
    headers: atlasHeaders(),
    data: {
      // Held runs here are started by direct API call (production mode) — needs active.
      status: "active",
      name: `E2E held upload ${workflowCounter}`,
      description: "",
      graph: workerGraph(prompt, includeWorker),
      policy: {},
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { workflow: { id: string } }).workflow.id;
}

async function startRun(
  request: APIRequestContext,
  workflowId: string,
  hold: boolean,
): Promise<string> {
  const response = await request.post(`${seed().atlasOrigin}/api/workflow-runs`, {
    headers: atlasHeaders(),
    data: { workflow_definition_id: workflowId, input: { note: "held upload E2E" }, hold },
  });
  expect(response.status()).toBe(202);
  return ((await response.json()) as { run: { id: string } }).run.id;
}

async function getRun(request: APIRequestContext, runId: string) {
  const response = await request.get(`${seed().atlasOrigin}/api/workflow-runs/${runId}`, {
    headers: atlasHeaders(),
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    run: { id: string; state: string };
    nodes: Array<Record<string, unknown>>;
  };
}

async function getRunEvents(request: APIRequestContext, runId: string) {
  const response = await request.get(
    `${seed().atlasOrigin}/api/workflow-runs/${runId}/events?after=0&limit=25`,
    { headers: atlasHeaders() },
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as { events: Array<{ event_type?: string }> };
}

async function waitForRunState(
  request: APIRequestContext,
  runId: string,
  state: string,
  timeout = 30_000,
) {
  await expect.poll(async () => (await getRun(request, runId)).run.state, { timeout }).toBe(state);
}

async function runArtifacts(request: APIRequestContext, runId: string) {
  const response = await request.get(`${seed().atlasOrigin}/api/workflow-runs/${runId}/artifacts`, {
    headers: atlasHeaders(),
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { artifacts: Array<Record<string, unknown>> }).artifacts;
}

function artifactsSection(page: Page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Artifacts" }) });
}

test.beforeAll(async ({ request }) => {
  stub = await startStubWorker();
  const response = await request.post(`${seed().atlasOrigin}/api/workers`, {
    headers: atlasHeaders(),
    data: { name: "E2E held upload stub", base_url: stub.origin, role: "streamer" },
  });
  expect(response.status()).toBe(201);
  stubWorkerId = ((await response.json()) as { worker: { id: string } }).worker.id;
});

test.afterAll(async () => {
  await stub?.close();
});

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test("held Test Run dialog is non-sticky and creates a paused run with no runtime nodes", async ({
  page,
  request,
}) => {
  const workflowId = await createWorkflow(request, undefined, false);
  await page.goto(`/workflows/${workflowId}`);
  await ready(page);
  await expect(page.getByTestId("workflow-dirty-state")).toHaveText("Saved", { timeout: 30_000 });

  const openDialog = page.getByRole("button", { name: "Run live test", exact: true });
  const hold = page.locator("#test-run-hold");
  await openDialog.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(hold).toBeVisible();
  await expect(hold).not.toBeChecked();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openDialog.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(hold).not.toBeChecked();

  await hold.check();
  await expect(page.getByTestId("start-test-run")).toHaveText("Create held run");
  await page.getByTestId("start-test-run").click();
  await page.waitForURL(/\/runs\/wfr_[a-z0-9]+$/);

  const runId = new URL(page.url()).pathname.split("/").pop()!;
  const detail = await getRun(request, runId);
  expect(detail.run.state).toBe("paused");
  expect(detail.nodes).toHaveLength(0);
  const events = await getRunEvents(request, runId);
  expect(events.events.some((event) => event.event_type === "run_created_held")).toBe(true);
});

test("uploads two input files, including a Thai filename, as file_ref upload_* artifacts", async ({
  page,
  request,
}) => {
  const workflowId = await createWorkflow(request);
  const runId = await startRun(request, workflowId, true);
  await waitForRunState(request, runId, "paused");

  await page.goto(`/runs/${runId}`);
  await ready(page);
  await expect(page.getByRole("heading", { name: runId })).toBeVisible();
  const artifacts = artifactsSection(page);
  const uploadButton = artifacts.getByRole("button", { name: "Upload input file" });
  await expect(uploadButton).toBeVisible();

  const thaiFilename = "แผนวิสาหกิจ 70-74 ทดสอบ.pdf";
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: "test.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("id,value\n1,alpha\n2,beta\n3,gamma\n"),
    },
    {
      name: thaiFilename,
      mimeType: "application/pdf",
      buffer: Buffer.from("not a real PDF; filename encoding regression fixture\n"),
    },
  ]);

  const rows = artifacts.locator("tbody tr");
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  await expect(rows.getByText("file_ref", { exact: true })).toHaveCount(2);

  const uploaded = (await runArtifacts(request, runId)).filter(
    (artifact) => artifact.kind === "file_ref",
  );
  expect(uploaded).toHaveLength(2);
  expect(uploaded.every((artifact) => /^upload_/.test(String(artifact.key)))).toBe(true);

  const thaiArtifact = uploaded.find((artifact) => {
    const metadata = artifact.metadata as { filename?: unknown };
    return metadata.filename === thaiFilename;
  });
  expect(thaiArtifact, "Thai filename must be decoded before Atlas persistence").toBeTruthy();
});

test("resumes a held run through the real stub worker and reaches succeeded", async ({
  page,
  request,
}) => {
  const workflowId = await createWorkflow(request, "stub:count=2;interval=50");
  const runId = await startRun(request, workflowId, true);
  await waitForRunState(request, runId, "paused");

  await page.goto(`/runs/${runId}`);
  await ready(page);
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  await expect(resume).toBeEnabled();
  await resume.click();

  await waitForRunState(request, runId, "succeeded", 45_000);
  expect(stub.runsServed()).toBeGreaterThan(0);
});

test("disables input upload on a terminal run with a reason", async ({ page, request }) => {
  const workflowId = await createWorkflow(request, "stub:count=1;interval=0");
  const runId = await startRun(request, workflowId, false);
  await waitForRunState(request, runId, "succeeded", 30_000);

  await page.goto(`/runs/${runId}`);
  await ready(page);
  const uploadButton = artifactsSection(page).getByRole("button", { name: "Upload input file" });
  await expect(uploadButton).toBeDisabled();
  await expect(uploadButton).toHaveAttribute("title", /can no longer reach a node/);
});

test("rejects anonymous and cross-site direct uploads", async ({ page, browser, request }) => {
  const workflowId = await createWorkflow(request);
  const runId = await startRun(request, workflowId, true);
  await waitForRunState(request, runId, "paused");
  await page.goto(`/runs/${runId}`);
  await ready(page);

  const appOrigin = new URL(page.url()).origin;
  const uploadUrl = `${appOrigin}/api/workflow-runs/${encodeURIComponent(runId)}/files?key=upload_guard.csv`;
  const body = Buffer.from("guard\n");
  const baseHeaders = {
    "content-type": "text/csv",
    "content-length": String(body.length),
    "x-filename": "guard.csv",
  };
  const anonymousContext = await browser.newContext();
  try {
    const anonymous = await anonymousContext.request.post(uploadUrl, {
      headers: { ...baseHeaders, origin: appOrigin, "sec-fetch-site": "same-origin" },
      data: body,
    });
    expect([401, 403]).toContain(anonymous.status());

    const crossSite = await anonymousContext.request.post(uploadUrl, {
      headers: { ...baseHeaders, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      data: body,
    });
    expect(crossSite.status()).toBe(403);
  } finally {
    await anonymousContext.close();
  }
});
