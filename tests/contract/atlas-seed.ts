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

/**
 * The base URL given to the seeded worker. Deliberately unroutable — nothing must dial it.
 *
 * Exported because the mutation contract tests upsert workers of their own, and
 * `POST /api/workers` resolves a conflict on `base_url` (`atlas/db.py:1966`): a test that
 * reused this URL would silently edit the seeded worker instead of creating its own.
 */
export const UNREACHABLE_WORKER_URL = "http://127.0.0.1:9";

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

/**
 * Adds one unroutable worker per role a graph fixture asks for by name.
 *
 * `validate_workflow_references` (`atlas/workflows.py:344-350`) rejects a node that names a
 * `role` no worker on the instance can serve — a check the editor cannot reproduce, and one the
 * fixtures' own header overlooks when it lists what is "deliberately absent". Without these
 * rows Atlas refuses `ALL_KINDS_GRAPH` outright, and the round trip could never be tested.
 *
 * The URLs are dead, like every worker in this harness: a role only has to *resolve*, and nothing
 * here may dial anything. Each is a distinct loopback host on the discard port — an ordinary high
 * port would only be dead until a developer happened to run something on it, whereas nothing ever
 * listens on port 9. Distinct *hosts* are what keeps them apart, because `POST /api/workers`
 * resolves its conflict on the whole `base_url` string (`atlas/db.py:1966`). Atlas's only
 * requirement is the http(s) scheme (`atlas/db.py:1961-1964`), which these satisfy.
 */
export async function seedRoleWorkers(
  origin: string,
  adminToken: string,
  roles: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, role] of roles.entries()) {
    const worker = await post(origin, adminToken, "/api/workers", {
      name: `Contract ${role}`,
      base_url: `http://127.0.0.${2 + index}:9`,
      role,
      tags: ["seeded", role],
    });
    ids.push(idOf(worker, "worker"));
  }
  return ids;
}

export interface SeededGates {
  /** One `human_gate` with no choices and no outgoing edge: approve ends the run. */
  plainGateWorkflowId: string;
  /** A gate that declares choices, routing by `human_selected` into a second, plain gate. */
  branchingGateWorkflowId: string;
}

/**
 * Seeds two workflows whose start node is a `human_gate`.
 *
 * This is what makes the run lifecycle testable without a worker. Atlas's executor creates the
 * approval and parks the run in `waiting_for_human` before it ever resolves a worker
 * (`atlas/workflows.py:986-999`), so the run reaches a *stable, non-terminal* state that a test
 * can act on — pause/resume/cancel transitions, and a real approval decision. Every other path
 * through the executor dials the unreachable seeded worker and fails within milliseconds, which
 * leaves nothing observable to act on.
 *
 * Separate from `seedAtlas` on purpose: the read contract test asserts on exactly what that
 * function produces, so nothing here may be folded into it.
 */
export async function seedGateWorkflows(origin: string, adminToken: string): Promise<SeededGates> {
  const plain = await post(origin, adminToken, "/api/workflows", {
    name: "Contract Gate Workflow",
    description: "Parks at a human gate that declares no choices.",
    graph: {
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
    },
    policy: {},
  });

  const branching = await post(origin, adminToken, "/api/workflows", {
    name: "Contract Branching Gate Workflow",
    description: "A gate with choices routing into a second gate.",
    graph: {
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
    },
    policy: {},
  });

  return {
    plainGateWorkflowId: idOf(plain, "workflow"),
    branchingGateWorkflowId: idOf(branching, "workflow"),
  };
}
