/**
 * Seeds a freshly-booted, empty Atlas with the rows the read-only UI needs.
 *
 * Everything is created through Atlas's own HTTP API with an admin bearer, so the rows are
 * whatever Atlas actually stores — never a fixture shaped to match what the client expects.
 * A test that passed against hand-written JSON would prove nothing about the wire contract.
 *
 * No thClaws worker is running during tests, and none is needed:
 *  - `POST /api/workers` and `POST /api/workspaces` are plain DB upserts with no health probe
 *    (`atlas/db.py:1955`, `atlas/db.py:2152`), so the worker row lands in status `unknown`.
 *  - `POST /api/workflow-runs` persists the run *before* handing it to the background executor
 *    (`atlas/workflows.py:427-429`), so the run row exists even though execution then fails
 *    against an unreachable worker. A failing run is a perfectly good read fixture.
 *  - `POST /api/jobs` likewise persists the job before the worker call (`atlas/jobs.py:415`).
 *
 * The workflow graph below is the minimum `validate_workflow_graph` accepts
 * (`atlas/workflows.py:149-233`): a non-empty node list, a `start` naming a real node, and a
 * node type from the four Atlas allows.
 */

export interface SeededAtlas {
  workerId: string;
  workspaceId: string;
  workflowId: string;
  runId: string;
  jobId: string;
}

/** The base URL given to the seeded worker. Deliberately unroutable — nothing must dial it. */
const UNREACHABLE_WORKER_URL = "http://127.0.0.1:9";

async function post(origin: string, token: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      // Same Atlas keep-alive desync workaround the production client applies; see
      // docs/ATLAS_LIMITATIONS.md.
      connection: "close",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`seed ${path} failed: ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

function idOf(payload: unknown, key: string): string {
  const row = (payload as Record<string, unknown> | null)?.[key];
  const id = (row as Record<string, unknown> | undefined)?.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`seed response had no ${key}.id: ${JSON.stringify(payload)}`);
  }
  return id;
}

export async function seedAtlas(origin: string, adminToken: string): Promise<SeededAtlas> {
  const worker = await post(origin, adminToken, "/api/workers", {
    name: "Contract Worker",
    base_url: UNREACHABLE_WORKER_URL,
    role: "reporter",
    tags: ["contract", "seeded"],
  });
  const workerId = idOf(worker, "worker");

  const workspace = await post(origin, adminToken, "/api/workspaces", {
    worker_id: workerId,
    workspace_key: "contract-ws",
    workspace_dir: "/tmp/contract-ws",
    company: "Contract Co",
    tags: ["seeded"],
  });
  const workspaceId = idOf(workspace, "workspace");

  const workflow = await post(origin, adminToken, "/api/workflows", {
    name: "Contract Workflow",
    description: "Seeded by the flow-designer contract tests.",
    graph: {
      start: "n1",
      nodes: [
        {
          id: "n1",
          type: "worker",
          label: "Reporter",
          prompt: "Summarise the contract fixture.",
          worker_id: workerId,
          outputs: ["report"],
        },
      ],
      edges: [],
    },
    policy: { max_jobs: 2, max_minutes: 1 },
  });
  const workflowId = idOf(workflow, "workflow");

  // 202: Atlas persists the run row, then fails asynchronously against the unreachable worker.
  const run = await post(origin, adminToken, "/api/workflow-runs", {
    workflow_definition_id: workflowId,
    input: {},
  });
  const runId = idOf(run, "run");

  const job = await post(origin, adminToken, "/api/jobs", {
    prompt: "Contract fixture job.",
    worker_id: workerId,
    workspace_id: workspaceId,
  });
  const jobId = idOf(job, "job");

  return { workerId, workspaceId, workflowId, runId, jobId };
}
