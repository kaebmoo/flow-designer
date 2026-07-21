/**
 * Mutation contract tests against a REAL Atlas instance.
 *
 * The read contract proved this client can *read* what Atlas stores. This one proves it can
 * write what Atlas accepts, which is a harder claim: the editor carries its own copy of
 * Atlas's graph rules (`src/lib/workflow-graph.ts`), and two validators that agree today drift
 * apart silently. Every case below therefore asserts against the real server — the same
 * document is validated locally *and* posted, so a rule that exists in only one of the two
 * fails here rather than in production.
 *
 * The instance is isolated: temp database, ephemeral port, own secret key. No developer or
 * production Atlas data is touched, and the Atlas checkout is only read.
 *
 * Nothing here sleeps waiting for a state to arrive. Where Atlas works in the background, the
 * test polls the real row with a bounded deadline and fails loudly on timeout.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AtlasError,
  atlasCancelJob,
  atlasCreateWorkflow,
  atlasCreateWorkflowTrigger,
  atlasDecideApproval,
  atlasDeleteWorkflow,
  atlasDeleteWorkflowTrigger,
  atlasDeleteWorker,
  atlasDeleteWorkspace,
  atlasDeliverRun,
  atlasFireWorkflowTrigger,
  atlasGetJob,
  atlasGetWorkflow,
  atlasGetWorkflowRun,
  atlasGetWorkspace,
  atlasListApprovals,
  atlasListDeliveries,
  atlasListWorkers,
  atlasListWorkflowTriggers,
  atlasListWorkspaces,
  atlasLogin,
  atlasRetryDelivery,
  atlasRunAction,
  atlasStartWorkflowRun,
  atlasUpdateWorkflow,
  atlasUpdateWorkflowTrigger,
  atlasUpsertWorker,
  atlasUpsertWorkspace,
  atlasValidateWorkflow,
} from "@/lib/atlas-api.server";
import { toApprovalView, toTriggerView } from "@/lib/atlas-mappers";
import { resetServerEnvCache } from "@/lib/env.server";
import type { AtlasWorkflowRun } from "@/lib/atlas-types";
import {
  parseWorkflowGraph,
  parseWorkflowPolicy,
  serializeWorkflowGraph,
  serializeWorkflowPolicy,
  validateWorkflow,
  type WorkflowGraph,
  type WorkflowPolicy,
} from "@/lib/workflow-graph";
import {
  ALL_KINDS_GRAPH,
  ALL_KINDS_POLICY,
  FAIL_CLOSED_GRAPHS,
  FILE_HANDOFF_GRAPH,
  FILE_HANDOFF_POLICY,
  MINIMAL_GRAPH,
  referenceGraph,
} from "../fixtures/workflow-graphs";
import {
  ADMIN_CREDENTIALS,
  OPERATOR_CREDENTIALS,
  VIEWER_CREDENTIALS,
  atlasAvailable,
  startIsolatedAtlas,
  type AtlasInstance,
} from "./atlas-instance";
import {
  UNREACHABLE_WORKER_URL,
  seedAtlas,
  seedGateWorkflows,
  seedRoleWorkers,
  type SeededAtlas,
  type SeededGates,
} from "./atlas-seed";

const available = atlasAvailable();
let atlas: AtlasInstance | undefined;
let adminToken = "";
let viewerToken = "";
let operatorToken = "";
let seeded: SeededAtlas | undefined;
let gates: SeededGates | undefined;

beforeAll(async () => {
  if (!available) return;
  atlas = await startIsolatedAtlas();

  process.env.ATLAS_API_ORIGIN = atlas.origin;
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "e".repeat(32);
  process.env.NODE_ENV = "test";
  resetServerEnvCache();

  adminToken = (await atlasLogin(ADMIN_CREDENTIALS)).token;
  viewerToken = (await atlasLogin(VIEWER_CREDENTIALS)).token;
  operatorToken = (await atlasLogin(OPERATOR_CREDENTIALS)).token;
  seeded = await seedAtlas(atlas.origin, adminToken);
  gates = await seedGateWorkflows(atlas.origin, adminToken);
  // `ALL_KINDS_GRAPH` names these two roles; Atlas refuses a role no worker can serve.
  await seedRoleWorkers(atlas.origin, adminToken, ["researcher", "manager"]);
}, 60_000);

afterAll(() => {
  const output = atlas?.logs() ?? "";
  if (output.trim()) {
    console.log(`--- Atlas server output ---\n${output}`);
  }
  atlas?.stop();
  resetServerEnvCache();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parses a fixture, failing the test with the parser's own reason rather than a type error. */
function graphOf(raw: unknown): WorkflowGraph {
  const parsed = parseWorkflowGraph(raw);
  if (!parsed.ok) throw new Error(`the editor refused a graph it must accept: ${parsed.reason}`);
  return parsed.value;
}

function policyOf(raw: unknown): WorkflowPolicy {
  const parsed = parseWorkflowPolicy(raw);
  if (!parsed.ok) throw new Error(`the editor refused a policy it must accept: ${parsed.reason}`);
  return parsed.value;
}

/**
 * Polls a real Atlas row until `done`, bounded by a deadline.
 *
 * The alternative — sleeping for a guessed duration and then asserting — is how a suite starts
 * passing for the wrong reason on a fast machine and failing on a loaded one.
 */
async function until<T>(
  what: string,
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  describeValue: (value: T) => string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!done(last)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last saw ${describeValue(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    last = await probe();
  }
  return last;
}

/** Atlas's terminal run states (`atlas/workflows.py:604-611`). */
const TERMINAL_RUN_STATES = ["succeeded", "failed", "cancelled"];

/**
 * `timeoutMs` exists so a test that polls twice stays inside the contract project's 30s
 * `testTimeout`. Two default 15s waits can only overrun it, and an overrun surfaces as an opaque
 * vitest timeout instead of this helper's "last saw state X" message.
 */
async function runInState(
  runId: string,
  states: string[],
  timeoutMs?: number,
): Promise<AtlasWorkflowRun> {
  const detail = await until(
    `run ${runId} to reach one of ${states.join("/")}`,
    () => atlasGetWorkflowRun(adminToken, runId),
    (value) => states.includes(value.run.state),
    (value) => `state ${value.run.state}`,
    timeoutMs,
  );
  return detail.run;
}

/** Half the default, so two sequential waits still fit inside the 30s test timeout. */
const HALF_BUDGET_MS = 7_000;

let uniqueCounter = 0;
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix} ${uniqueCounter}`;
}

async function createFrom(
  raw: unknown,
  rawPolicy: unknown = {},
  name = uniqueName("Contract mutation"),
) {
  return atlasCreateWorkflow(adminToken, {
    name,
    graph: serializeWorkflowGraph(graphOf(raw)),
    policy: serializeWorkflowPolicy(policyOf(rawPolicy)),
  });
}

function atlasErrorFrom(error: unknown): AtlasError {
  if (!(error instanceof AtlasError)) {
    throw new Error(`expected an AtlasError, got ${String(error)}`);
  }
  return error;
}

describe.skipIf(!available)("Atlas mutation contract", () => {
  // -------------------------------------------------------------------------
  // A. Graph round trip. The entry requirement: what the editor sends is what Atlas keeps.
  // -------------------------------------------------------------------------
  describe("graph round trip", () => {
    /**
     * The single test that proves the vocabulary is real. Nothing short of Atlas accepting this
     * document establishes that all four node kinds and all six condition types exist as the
     * editor models them — a unit round trip only proves the parser agrees with the serializer.
     */
    it("accepts every node kind and condition type, and returns the graph byte-identical", async () => {
      const sent = serializeWorkflowGraph(graphOf(ALL_KINDS_GRAPH));
      const sentPolicy = serializeWorkflowPolicy(policyOf(ALL_KINDS_POLICY));

      const created = await atlasCreateWorkflow(adminToken, {
        name: "All kinds",
        description: "Every native node kind and every condition type.",
        graph: sent,
        policy: sentPolicy,
      });
      expect(created.id.startsWith("wfd_")).toBe(true);

      const fetched = await atlasGetWorkflow(adminToken, created.id);
      expect(fetched.graph).toEqual(sent);

      const reparsed = graphOf(fetched.graph);
      expect(serializeWorkflowGraph(reparsed)).toEqual(sent);
    });

    it("keeps every policy key ALL_KINDS_POLICY sets, at its documented maximum", async () => {
      const sentPolicy = serializeWorkflowPolicy(policyOf(ALL_KINDS_POLICY));
      const created = await atlasCreateWorkflow(adminToken, {
        name: uniqueName("Policy round trip"),
        graph: serializeWorkflowGraph(graphOf(ALL_KINDS_GRAPH)),
        policy: sentPolicy,
      });

      const fetched = await atlasGetWorkflow(adminToken, created.id);
      for (const [key, value] of Object.entries(ALL_KINDS_POLICY)) {
        expect(fetched.policy[key]).toBe(value);
      }
      expect(serializeWorkflowPolicy(policyOf(fetched.policy))).toEqual(sentPolicy);
    });

    it("round-trips the smallest graph Atlas accepts", async () => {
      const sent = serializeWorkflowGraph(graphOf(MINIMAL_GRAPH));
      const created = await atlasCreateWorkflow(adminToken, {
        name: uniqueName("Minimal"),
        graph: sent,
        policy: {},
      });

      const fetched = await atlasGetWorkflow(adminToken, created.id);
      expect(serializeWorkflowGraph(graphOf(fetched.graph))).toEqual(sent);
      // An absent `policy` decodes to `{}`, not null (`atlas/db.py` decode_json default).
      expect(fetched.policy).toEqual({});
    });

    it("round-trips edge push_files together with the file_handoff opt-in that permits it", async () => {
      const sent = serializeWorkflowGraph(graphOf(FILE_HANDOFF_GRAPH));
      const sentPolicy = serializeWorkflowPolicy(policyOf(FILE_HANDOFF_POLICY));
      const created = await atlasCreateWorkflow(adminToken, {
        name: uniqueName("File handoff"),
        graph: sent,
        policy: sentPolicy,
      });

      const fetched = await atlasGetWorkflow(adminToken, created.id);
      expect(fetched.graph).toEqual(sent);
      expect(fetched.policy).toEqual({ file_handoff: true });
      expect(serializeWorkflowGraph(graphOf(fetched.graph))).toEqual(sent);
    });
  });

  // -------------------------------------------------------------------------
  // B. Fail closed.
  // -------------------------------------------------------------------------
  describe("fail closed", () => {
    it.each(FAIL_CLOSED_GRAPHS)("refuses a graph with $why", ({ graph }) => {
      const parsed = parseWorkflowGraph(graph);
      expect(parsed.ok).toBe(false);
    });

    /**
     * The half that matters, and the only one a unit test cannot reach.
     *
     * Atlas's `validate_workflow_graph` never inspects unknown node fields
     * (`atlas/workflows.py:149-233`), so Atlas stores documents this editor must refuse. The
     * dangerous outcome is not the refusal — it is an editor that loads such a graph, drops the
     * field it did not understand, and PUTs the remainder back. Both halves are asserted here:
     * Atlas really accepted it, and the parser really refuses it.
     */
    it("refuses to edit a stored graph carrying a node field Atlas ignores", async () => {
      const created = await atlasCreateWorkflow(adminToken, {
        name: uniqueName("Unknown node field"),
        graph: {
          start: "a",
          nodes: [
            { id: "a", type: "worker", prompt: "Do the thing.", retries: 3, ui_colour: "#ff0000" },
          ],
          edges: [],
        },
        policy: {},
      });

      const fetched = await atlasGetWorkflow(adminToken, created.id);
      const storedNode = (fetched.graph.nodes ?? [])[0] as Record<string, unknown>;
      expect(storedNode.retries).toBe(3);

      const parsed = parseWorkflowGraph(fetched.graph);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error("unreachable");
      expect(parsed.reason).toContain("retries");
      expect(parsed.reason).toContain("ui_colour");
    });

    it("refuses the workflow the read fixture itself seeds, because Atlas let a label through", async () => {
      // `seedAtlas` writes `label` on a *worker* node; Atlas has no such field on one.
      const fetched = await atlasGetWorkflow(adminToken, seeded!.workflowId);
      const parsed = parseWorkflowGraph(fetched.graph);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error("unreachable");
      expect(parsed.reason).toContain("label");
    });
  });

  // -------------------------------------------------------------------------
  // C. Atlas rejects what our validator rejects.
  // -------------------------------------------------------------------------
  interface RejectedCaseBase {
    why: string;
    graph: Record<string, unknown>;
    policy: Record<string, unknown>;
    /** A distinctive fragment of Atlas's own message, so a reworded rule is noticed here. */
    atlasMessage: string;
  }

  /**
   * Where this repository stops it: the parser's closed vocabulary, or the validator.
   *
   * The validator arm carries `localMessage` — a fragment of *this* repository's own wording —
   * because "some issue was raised" is not the claim under test. A validator that dropped the
   * rule and happened to flag something unrelated would still produce a non-empty list, which is
   * exactly the drift this file exists to catch. The parser arm has no equivalent: it returns a
   * single free-form reason and the case above already asserts on it.
   */
  type RejectedCase = RejectedCaseBase &
    ({ refusedBy: "parser" } | { refusedBy: "validator"; localMessage: string });

  const REJECTED_CASES: RejectedCase[] = [
    {
      why: "an edge leaving a manager without manager_selected",
      graph: {
        start: "m",
        nodes: [
          { id: "m", type: "manager", schema: "manager_decision_v1" },
          { id: "b", type: "worker", prompt: "Next." },
        ],
        edges: [{ from: "m", to: "b", condition: { type: "always" } }],
      },
      policy: {},
      refusedBy: "validator",
      localMessage: "An edge from a manager must use the manager_selected condition.",
      atlasMessage: "requires manager_selected condition",
    },
    {
      why: "a manager_selected target that is not the edge's own target",
      graph: {
        start: "m",
        nodes: [
          { id: "m", type: "manager", schema: "manager_decision_v1" },
          { id: "b", type: "worker", prompt: "B." },
          { id: "c", type: "worker", prompt: "C." },
        ],
        edges: [{ from: "m", to: "b", condition: { type: "manager_selected", target: "c" } }],
      },
      policy: {},
      refusedBy: "validator",
      localMessage: "manager_selected target must be the edge's own target node.",
      atlasMessage: "manager_selected target must match edge target",
    },
    {
      why: "a human_selected choice the gate never declared",
      graph: {
        start: "g",
        nodes: [
          { id: "g", type: "human_gate", choices: [{ id: "go", label: "Go" }] },
          { id: "b", type: "worker", prompt: "After." },
        ],
        edges: [{ from: "g", to: "b", condition: { type: "human_selected", choice: "stop" } }],
      },
      policy: {},
      refusedBy: "validator",
      localMessage: "The source gate does not declare the choice stop.",
      atlasMessage: "human_selected choice is not declared by source gate",
    },
    {
      why: "a quorum larger than the distinct incoming edge count",
      graph: {
        start: "a",
        nodes: [
          { id: "a", type: "worker", prompt: "One." },
          { id: "j", type: "join", mode: "quorum", quorum: 2 },
        ],
        edges: [{ from: "a", to: "j", condition: { type: "always" } }],
      },
      policy: {},
      refusedBy: "validator",
      localMessage: "Quorum 2 exceeds the 1 distinct upstream node(s)",
      atlasMessage: "quorum exceeds distinct incoming upstream count",
    },
    {
      why: "a cycle with neither a max_iterations_below edge nor policy.max_iterations",
      graph: {
        start: "a",
        nodes: [
          { id: "a", type: "worker", prompt: "A." },
          { id: "b", type: "worker", prompt: "B." },
        ],
        edges: [
          { from: "a", to: "b", condition: { type: "always" } },
          { from: "b", to: "a", condition: { type: "always" } },
        ],
      },
      policy: {},
      refusedBy: "validator",
      localMessage: "This graph loops.",
      atlasMessage: "workflow graph has a cycle",
    },
    {
      why: "push_files on an edge without the file_handoff policy opt-in",
      graph: FILE_HANDOFF_GRAPH as unknown as Record<string, unknown>,
      policy: {},
      refusedBy: "validator",
      localMessage: "Pushing files on an edge requires policy.file_handoff.",
      atlasMessage: "push_files requires policy.file_handoff=true",
    },
    {
      why: "a policy value above its documented maximum",
      graph: MINIMAL_GRAPH as unknown as Record<string, unknown>,
      policy: { max_jobs: 101 },
      refusedBy: "validator",
      localMessage: "max_jobs must be a whole number between 1 and 100.",
      atlasMessage: "workflow policy max_jobs must be an integer between 1 and 100",
    },
    {
      why: "a node type Atlas does not have",
      graph: {
        start: "a",
        nodes: [{ id: "a", type: "condition", expr: "payload.ok" }],
        edges: [],
      },
      policy: {},
      refusedBy: "parser",
      atlasMessage: "uses unsupported type: condition",
    },
    {
      why: "an edge condition type Atlas does not have",
      graph: {
        start: "a",
        nodes: [
          { id: "a", type: "worker", prompt: "A." },
          { id: "b", type: "worker", prompt: "B." },
        ],
        edges: [{ from: "a", to: "b", condition: { type: "expression", expr: "x == 1" } }],
      },
      policy: {},
      refusedBy: "parser",
      atlasMessage: "uses unsupported condition: expression",
    },
  ];

  describe("Atlas rejects what this editor rejects", () => {
    it.each(REJECTED_CASES)("$why", async (testCase) => {
      const parsed = parseWorkflowGraph(testCase.graph);
      if (testCase.refusedBy === "parser") {
        // An unknown type never reaches `validateWorkflow`: there is no semantic model to
        // validate, which is precisely the fail-closed rule.
        expect(parsed.ok).toBe(false);
      } else {
        if (!parsed.ok) throw new Error(`the parser refused too early: ${parsed.reason}`);
        const issues = validateWorkflow(parsed.value, policyOf(testCase.policy));
        // The rule under test specifically — not merely "something was flagged".
        expect(issues.map((issue) => issue.message)).toEqual(
          expect.arrayContaining([expect.stringContaining(testCase.localMessage)]),
        );
      }

      const error = atlasErrorFrom(
        await atlasCreateWorkflow(adminToken, {
          name: uniqueName("Rejected"),
          graph: testCase.graph,
          policy: testCase.policy,
        }).catch((e: unknown) => e),
      );
      expect(error.kind).toBe("validation");
      expect(error.status).toBe(400);
      expect(error.fromAtlas).toBe(true);
      expect(error.message).toContain(testCase.atlasMessage);
    });
  });

  // -------------------------------------------------------------------------
  // D. Workflow CRUD.
  // -------------------------------------------------------------------------
  describe("workflow CRUD", () => {
    it("round-trips, edits, and explicitly clears a nullable default reply", async () => {
      const created = await atlasCreateWorkflow(adminToken, {
        name: uniqueName("Default reply"),
        graph: serializeWorkflowGraph(graphOf(MINIMAL_GRAPH)),
        policy: {},
        default_reply: { mode: "none", correlation_id: "initial", x_extension: "keep" },
      });
      expect(created.default_reply).toEqual({
        mode: "none",
        correlation_id: "initial",
        x_extension: "keep",
      });

      const edited = await atlasUpdateWorkflow(adminToken, created.id, {
        name: created.name,
        graph: serializeWorkflowGraph(graphOf(created.graph)),
        policy: created.policy,
        default_reply: { ...created.default_reply, correlation_id: "edited" },
        expected_version: created.version,
      });
      expect(edited.version).toBe(created.version + 1);
      expect(edited.default_reply).toEqual({
        mode: "none",
        correlation_id: "edited",
        x_extension: "keep",
      });

      const cleared = await atlasUpdateWorkflow(adminToken, created.id, {
        name: edited.name,
        graph: serializeWorkflowGraph(graphOf(edited.graph)),
        policy: edited.policy,
        default_reply: null,
        expected_version: edited.version,
      });
      expect(cleared.version).toBe(edited.version + 1);
      expect(cleared.default_reply).toBeNull();
    });

    it("inherits the stored reply into runs and lets a run-level reply win", async () => {
      const created = await atlasCreateWorkflow(adminToken, {
        name: uniqueName("Inherited reply"),
        graph: serializeWorkflowGraph(graphOf(MINIMAL_GRAPH)),
        policy: {},
        default_reply: { mode: "none", correlation_id: "workflow-default" },
      });
      const inherited = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: created.id,
        input: {},
      });
      expect(inherited.input._meta).toEqual({
        reply: { mode: "none", correlation_id: "workflow-default" },
      });

      const overridden = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: created.id,
        input: { _meta: { reply: { mode: "none", correlation_id: "run-override" } } },
      });
      expect(overridden.input._meta).toEqual({
        reply: { mode: "none", correlation_id: "run-override" },
      });
    });

    it("inherits a workflow default through a manual trigger", async () => {
      const created = await atlasCreateWorkflow(adminToken, {
        name: uniqueName("Trigger reply"),
        graph: serializeWorkflowGraph(graphOf(MINIMAL_GRAPH)),
        policy: {},
        default_reply: { mode: "none", correlation_id: "trigger-default" },
      });
      const trigger = await atlasCreateWorkflowTrigger(adminToken, {
        workflowDefinitionId: created.id,
        name: uniqueName("Manual reply trigger"),
        type: "manual",
        enabled: true,
        config: {},
      });
      const fired = await atlasFireWorkflowTrigger(adminToken, trigger.id, {
        payload: { from: "trigger" },
      });
      expect((fired.run as Record<string, unknown>).input).toMatchObject({
        _meta: { reply: { mode: "none", correlation_id: "trigger-default" } },
      });
      await atlasDeleteWorkflowTrigger(adminToken, trigger.id);
    });

    it("returns one success and one 409 for concurrent expected_version saves", async () => {
      const created = await createFrom(MINIMAL_GRAPH, {}, uniqueName("Concurrent"));
      const update = (name: string) =>
        atlasUpdateWorkflow(adminToken, created.id, {
          name,
          graph: serializeWorkflowGraph(graphOf(created.graph)),
          policy: created.policy,
          expected_version: created.version,
        });
      const results = await Promise.allSettled([update("writer one"), update("writer two")]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
        kind: "conflict",
        status: 409,
      });
    });

    it("rejects default replies that fail the outbound allowlist on create and update", async () => {
      const createError = atlasErrorFrom(
        await atlasCreateWorkflow(adminToken, {
          name: uniqueName("Blocked default"),
          graph: serializeWorkflowGraph(graphOf(MINIMAL_GRAPH)),
          policy: {},
          default_reply: { mode: "webhook", callback_url: "https://not-allowlisted.example/hook" },
        }).catch((error: unknown) => error),
      );
      expect(createError.kind).toBe("validation");

      const created = await createFrom(MINIMAL_GRAPH, {}, uniqueName("Update blocked default"));
      const updateError = atlasErrorFrom(
        await atlasUpdateWorkflow(adminToken, created.id, {
          name: created.name,
          graph: serializeWorkflowGraph(graphOf(created.graph)),
          policy: created.policy,
          default_reply: { mode: "webhook", callback_url: "https://not-allowlisted.example/hook" },
          expected_version: created.version,
        }).catch((error: unknown) => error),
      );
      expect(updateError.kind).toBe("validation");
    });

    it("updates a definition in place with the atomic version token", async () => {
      const created = await createFrom(MINIMAL_GRAPH, {}, "Before rename");
      const sent = serializeWorkflowGraph(graphOf(ALL_KINDS_GRAPH));
      const updated = await atlasUpdateWorkflow(adminToken, created.id, {
        name: "After rename",
        description: "Renamed by the mutation contract test.",
        graph: sent,
        policy: serializeWorkflowPolicy(policyOf(ALL_KINDS_POLICY)),
        expected_version: created.version,
      });

      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe("After rename");
      expect(updated.graph).toEqual(sent);

      const fetched = await atlasGetWorkflow(adminToken, created.id);
      expect(fetched.updated_at).toBe(updated.updated_at);
      expect(fetched.created_at).toBe(created.created_at);
      expect(fetched.description).toBe("Renamed by the mutation contract test.");
      expect(fetched.version).toBe(created.version + 1);
    });

    it("validates a saved definition against a candidate graph and answers ok", async () => {
      const created = await createFrom(MINIMAL_GRAPH);
      const candidate = referenceGraph(seeded!.workerId, seeded!.workspaceId);

      await expect(
        atlasValidateWorkflow(adminToken, created.id, {
          graph: serializeWorkflowGraph(graphOf(candidate)),
          policy: {},
        }),
      ).resolves.toBeUndefined();
    });

    /**
     * The reason this endpoint exists at all: `validate_workflow_references`
     * (`atlas/workflows.py:304`) resolves `worker_id` against Atlas's own tables. No client can
     * reproduce that check, so local validation must *not* claim the graph is fine.
     */
    it("returns Atlas's own message for a reference only Atlas can resolve", async () => {
      const created = await createFrom(MINIMAL_GRAPH);
      const candidate = referenceGraph("wrk_does_not_exist", seeded!.workspaceId);
      const graph = serializeWorkflowGraph(graphOf(candidate));

      // Local validation is silent here, by design — this is the gap Atlas fills.
      expect(validateWorkflow(graphOf(candidate), {})).toEqual([]);

      const error = atlasErrorFrom(
        await atlasValidateWorkflow(adminToken, created.id, { graph, policy: {} }).catch(
          (e: unknown) => e,
        ),
      );
      expect(error.kind).toBe("validation");
      expect(error.status).toBe(400);
      expect(error.message).toContain("references unknown worker_id: wrk_does_not_exist");
    });

    it("raises not_found when validating against a workflow id that does not exist", async () => {
      const error = atlasErrorFrom(
        await atlasValidateWorkflow(adminToken, "wfd_does_not_exist", {
          graph: serializeWorkflowGraph(graphOf(MINIMAL_GRAPH)),
          policy: {},
        }).catch((e: unknown) => e),
      );
      expect(error.kind).toBe("not_found");
      expect(error.status).toBe(404);
    });

    it("deletes a definition, after which reading and re-deleting are both not_found", async () => {
      const created = await createFrom(MINIMAL_GRAPH);

      await expect(atlasDeleteWorkflow(adminToken, created.id)).resolves.toBeUndefined();

      const read = atlasErrorFrom(
        await atlasGetWorkflow(adminToken, created.id).catch((e: unknown) => e),
      );
      expect(read.kind).toBe("not_found");

      const again = atlasErrorFrom(
        await atlasDeleteWorkflow(adminToken, created.id).catch((e: unknown) => e),
      );
      expect(again.kind).toBe("not_found");
    });

    it("refuses a viewer's write with 403 while its reads still succeed", async () => {
      const error = atlasErrorFrom(
        await atlasCreateWorkflow(viewerToken, {
          name: uniqueName("Viewer"),
          graph: serializeWorkflowGraph(graphOf(MINIMAL_GRAPH)),
          policy: {},
        }).catch((e: unknown) => e),
      );
      expect(error.kind).toBe("forbidden");
      expect(error.status).toBe(403);

      await expect(atlasGetWorkflow(viewerToken, seeded!.workflowId)).resolves.toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // E. Run lifecycle.
  // -------------------------------------------------------------------------
  describe("run lifecycle", () => {
    it("starts a run that gets a real Atlas id and is immediately readable by it", async () => {
      const run = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
        input: {},
      });

      expect(run.id.startsWith("wfr_")).toBe(true);
      expect(run.workflow_definition_id).toBe(seeded!.workflowId);

      const detail = await atlasGetWorkflowRun(adminToken, run.id);
      expect(detail.run.id).toBe(run.id);
      // The graph is snapshotted onto the run, so a later edit cannot rewrite history.
      expect(detail.run.graph_snapshot).toBeTruthy();
    });

    it("rejects a start against a workflow id that does not exist", async () => {
      const error = atlasErrorFrom(
        await atlasStartWorkflowRun(adminToken, {
          workflowDefinitionId: "wfd_does_not_exist",
        }).catch((e: unknown) => e),
      );
      expect(error.kind).toBe("validation");
      expect(error.message).toContain("Unknown workflow_definition_id");
    });

    /**
     * The seeded worker is unroutable, so this run fails on its first node. What is
     * deterministic is the *destination*, not how long it takes to get there — hence the poll.
     */
    it("reports Atlas's literal refusals for pause and resume once a run is terminal", async () => {
      const started = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
      });
      const settled = await runInState(started.id, TERMINAL_RUN_STATES);
      expect(settled.state).toBe("failed");
      expect(settled.error).toBeTruthy();

      const pause = atlasErrorFrom(
        await atlasRunAction(adminToken, started.id, "pause").catch((e: unknown) => e),
      );
      expect(pause.status).toBe(400);
      expect(pause.message).toBe(`workflow run ${started.id} cannot be paused from failed`);

      const resume = atlasErrorFrom(
        await atlasRunAction(adminToken, started.id, "resume").catch((e: unknown) => e),
      );
      expect(resume.message).toBe(`workflow run ${started.id} cannot be resumed from failed`);
    });

    it("treats cancelling an already-terminal run as a no-op that returns it unchanged", async () => {
      const started = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
      });
      const settled = await runInState(started.id, TERMINAL_RUN_STATES);

      const cancelled = await atlasRunAction(adminToken, started.id, "cancel");
      expect(cancelled.state).toBe(settled.state);
      expect(cancelled.finished_at).toBe(settled.finished_at);
    });

    /**
     * The one non-terminal state reachable without a worker, and therefore the only place the
     * cancel *transition* — as opposed to its no-op path — can be observed.
     */
    it("cancels a run parked at a human gate, and then refuses to resume it", async () => {
      const started = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: gates!.plainGateWorkflowId,
      });
      const parked = await runInState(started.id, ["waiting_for_human"]);
      expect(parked.state).toBe("waiting_for_human");

      const pause = atlasErrorFrom(
        await atlasRunAction(adminToken, started.id, "pause").catch((e: unknown) => e),
      );
      expect(pause.message).toBe(
        `workflow run ${started.id} cannot be paused from waiting_for_human`,
      );

      const cancelled = await atlasRunAction(adminToken, started.id, "cancel");
      expect(cancelled.state).toBe("cancelled");
      expect(cancelled.finished_at).toBeTruthy();

      const resume = atlasErrorFrom(
        await atlasRunAction(adminToken, started.id, "resume").catch((e: unknown) => e),
      );
      expect(resume.message).toBe(`workflow run ${started.id} cannot be resumed from cancelled`);

      // Cancelling the run must also close the approval it was waiting on.
      const approvals = await atlasListApprovals(adminToken, { runId: started.id, limit: 25 });
      expect(approvals).toHaveLength(1);
      expect(approvals[0]!.state).not.toBe("pending");
    });

    it("answers an action on an unknown run id with 400, not 404", async () => {
      const error = atlasErrorFrom(
        await atlasRunAction(adminToken, "wfr_does_not_exist", "cancel").catch((e: unknown) => e),
      );
      expect(error.kind).toBe("validation");
      expect(error.status).toBe(400);
      expect(error.message).toBe("Unknown workflow_run_id: wfr_does_not_exist");
    });

    /**
     * NOT COVERED, deliberately: the successful `pause` → `resume` pair.
     *
     * Both require the run to be observably `running`, which needs a worker that holds the
     * connection open. Every worker in this harness is unroutable — by design, so no test can
     * dial anything — so a run passes through `running` faster than a client can act on it.
     * Asserting it anyway would mean racing the executor, which is exactly the flake this file
     * refuses to introduce. The same applies to `resume(retry_interrupted)`, which needs a run
     * left in `recovery_required` by an Atlas restart mid-node.
     */
  });

  // -------------------------------------------------------------------------
  // F. Triggers.
  // -------------------------------------------------------------------------
  describe("triggers", () => {
    const TRIGGER_CONFIGS: Array<{ type: string; config: Record<string, unknown> }> = [
      { type: "manual", config: {} },
      { type: "schedule", config: { interval_minutes: 15 } },
      { type: "webhook", config: { secret_hint: "open config, so any key is legal" } },
      { type: "workflow_run_completed", config: { state: "succeeded" } },
      { type: "artifact_created", config: { key: "report" } },
      { type: "worker_status_changed", config: { status: "online" } },
    ];

    it.each(TRIGGER_CONFIGS)(
      "creates a $type trigger and reads it back",
      async ({ type, config }) => {
        const created = await atlasCreateWorkflowTrigger(adminToken, {
          workflowDefinitionId: seeded!.workflowId,
          name: `${type} trigger`,
          type,
          enabled: true,
          config,
        });

        expect(created.id.startsWith("wtr_")).toBe(true);
        expect(created.type).toBe(type);
        expect(created.config).toEqual(config);
        // Only a schedule carries a next fire time (`atlas/workflows.py:1855-1856`).
        expect(created.next_fire_at === null).toBe(type !== "schedule");

        const listed = await atlasListWorkflowTriggers(adminToken, {
          workflowDefinitionId: seeded!.workflowId,
          limit: 100,
        });
        expect(listed.some((trigger) => trigger.id === created.id)).toBe(true);

        await atlasDeleteWorkflowTrigger(adminToken, created.id);
      },
    );

    it("returns enabled as SQLite's integer, which the view model coerces to a boolean", async () => {
      const created = await atlasCreateWorkflowTrigger(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
        name: uniqueName("Enabled shape"),
        type: "manual",
        enabled: true,
        config: {},
      });

      // Not `true`: the column is INTEGER, so a client testing `enabled === true` reads false.
      expect(created.enabled).toBe(1);
      expect(typeof created.enabled).toBe("number");
      expect(toTriggerView(created).enabled).toBe(true);

      const disabled = await atlasUpdateWorkflowTrigger(adminToken, created.id, { enabled: false });
      expect(disabled.enabled).toBe(0);
      expect(toTriggerView(disabled).enabled).toBe(false);

      await atlasDeleteWorkflowTrigger(adminToken, created.id);
    });

    it("disables a schedule without disturbing the slot it already holds", async () => {
      // Half a day out, whatever the clock says when this runs: a daily time near "now" could
      // land within the 15-minute interval used below and make the comparison meaningless.
      const dailyTime = `${String((new Date().getHours() + 12) % 24).padStart(2, "0")}:30`;
      const created = await atlasCreateWorkflowTrigger(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
        name: uniqueName("Daily"),
        type: "schedule",
        enabled: true,
        config: { daily_time: dailyTime },
      });
      expect(created.next_fire_at).toBeTruthy();

      // `atlas/app.py:802-806` recomputes next_fire_at only when the body carries type/config,
      // which is why enable/disable is a separate call in this client.
      const disabled = await atlasUpdateWorkflowTrigger(adminToken, created.id, { enabled: false });
      expect(disabled.enabled).toBe(0);
      expect(disabled.next_fire_at).toBe(created.next_fire_at);
      expect(disabled.config).toEqual({ daily_time: dailyTime });

      const rescheduled = await atlasUpdateWorkflowTrigger(adminToken, created.id, {
        type: "schedule",
        config: { interval_minutes: 15 },
      });
      expect(rescheduled.next_fire_at).not.toBe(created.next_fire_at);
      const dueInMs = new Date(rescheduled.next_fire_at!).getTime() - Date.now();
      expect(dueInMs).toBeLessThanOrEqual(16 * 60_000);

      await atlasDeleteWorkflowTrigger(adminToken, created.id);
    });

    /**
     * Atlas accepts a schedule carrying both keys and silently prefers `interval_minutes`
     * (`atlas/workflows.py:1860-1891`), while the published trigger schema declares them a
     * `oneOf`. This asserts the drift itself, which is what makes the client-side refusal in
     * `acceptTriggerConfig` (`src/lib/atlas-mutations.functions.ts`) necessary: without it a
     * user could save a daily time that would never take effect.
     *
     * NOT COVERED here: that refusal firing. It lives inside a `createServerFn` validator, and
     * a server function cannot be executed outside a TanStack Start request context — calling
     * it from a test runs the *client* half, which would try to make a network request. It is
     * not separately exported, so there is nothing this file can import and call.
     */
    it("shows Atlas silently preferring interval_minutes when a schedule carries both keys", async () => {
      // Again half a day out, so "the interval won" is distinguishable from "the daily time won".
      const dailyTime = `${String((new Date().getHours() + 12) % 24).padStart(2, "0")}:30`;
      const config = { interval_minutes: 15, daily_time: dailyTime };
      const created = await atlasCreateWorkflowTrigger(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
        name: uniqueName("Ambiguous schedule"),
        type: "schedule",
        enabled: true,
        config,
      });

      expect(created.config).toEqual(config);
      const dueInMs = new Date(created.next_fire_at!).getTime() - Date.now();
      expect(dueInMs).toBeLessThanOrEqual(16 * 60_000);
      expect(toTriggerView(created).summary).toBe("Every 15 minute(s)");

      await atlasDeleteWorkflowTrigger(adminToken, created.id);
    });

    it("rejects an unknown config key on a closed-config type with its literal message", async () => {
      const error = atlasErrorFrom(
        await atlasCreateWorkflowTrigger(adminToken, {
          workflowDefinitionId: seeded!.workflowId,
          name: uniqueName("Typo"),
          type: "artifact_created",
          enabled: true,
          config: { kee: "report" },
        }).catch((e: unknown) => e),
      );
      expect(error.kind).toBe("validation");
      expect(error.status).toBe(400);
      expect(error.message).toBe(
        "unknown workflow trigger config key(s) for artifact_created: kee",
      );
    });

    it("keeps an open config open for the types whose schema allows any key", async () => {
      const created = await atlasCreateWorkflowTrigger(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
        name: uniqueName("Open config"),
        type: "webhook",
        enabled: true,
        config: { anything: "goes", nested: { ok: true } },
      });
      expect(created.config).toEqual({ anything: "goes", nested: { ok: true } });

      await atlasDeleteWorkflowTrigger(adminToken, created.id);
    });

    it("rejects a trigger for a workflow that does not exist", async () => {
      const error = atlasErrorFrom(
        await atlasCreateWorkflowTrigger(adminToken, {
          workflowDefinitionId: "wfd_does_not_exist",
          name: uniqueName("Orphan"),
          type: "manual",
          enabled: true,
          config: {},
        }).catch((e: unknown) => e),
      );
      expect(error.message).toBe("Unknown workflow_definition_id: wfd_does_not_exist");
    });

    it("deletes a trigger, and a second delete is not_found", async () => {
      const created = await atlasCreateWorkflowTrigger(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
        name: uniqueName("Doomed"),
        type: "manual",
        enabled: true,
        config: {},
      });

      await expect(atlasDeleteWorkflowTrigger(adminToken, created.id)).resolves.toBeUndefined();

      const listed = await atlasListWorkflowTriggers(adminToken, { limit: 100 });
      expect(listed.some((trigger) => trigger.id === created.id)).toBe(false);

      const again = atlasErrorFrom(
        await atlasDeleteWorkflowTrigger(adminToken, created.id).catch((e: unknown) => e),
      );
      expect(again.kind).toBe("not_found");
    });

    /**
     * The only place the *shape* of a fire response is pinned. Atlas answers 202 with the trigger
     * service's bare result and no row envelope (`atlas/app.py:780`), which is why the client
     * returns an unguarded `Record` — so without this test nothing would notice a renamed key
     * until the trigger page read `undefined`.
     */
    it("fires a manual trigger and answers with trigger, event, and the run it started", async () => {
      const created = await atlasCreateWorkflowTrigger(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
        name: uniqueName("Fireable"),
        type: "manual",
        enabled: true,
        config: {},
      });

      const payload = { source: "contract test" };
      const result = await atlasFireWorkflowTrigger(adminToken, created.id, { payload });
      expect(Object.keys(result).sort()).toEqual(["event", "run", "trigger"]);

      const trigger = result.trigger as Record<string, unknown>;
      expect(trigger.id).toBe(created.id);
      expect(trigger.last_fired_at).toBeTruthy();
      // Firing a manual trigger schedules nothing; only a schedule holds a next slot.
      expect(trigger.next_fire_at).toBeNull();

      const event = result.event as Record<string, unknown>;
      expect(String(event.id).startsWith("wte_")).toBe(true);
      expect(event.state).toBe("started");
      expect(event.payload).toEqual(payload);
      expect(event.error).toBeNull();

      const run = result.run as Record<string, unknown>;
      expect(String(run.id).startsWith("wfr_")).toBe(true);
      expect(run.workflow_definition_id).toBe(seeded!.workflowId);
      expect(event.run_id).toBe(run.id);
      // The fired payload becomes the run's input verbatim (`atlas/workflows.py:427`), which is
      // what makes "run it now with this input" a real capability rather than a start button.
      expect(run.input).toEqual(payload);

      await atlasDeleteWorkflowTrigger(adminToken, created.id);
    });

    /** Three of the six types exist only to be fired by Atlas itself; the UI must not offer it. */
    it("refuses to fire an event-driven trigger with Atlas's literal message", async () => {
      const created = await atlasCreateWorkflowTrigger(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
        name: uniqueName("Event driven"),
        type: "workflow_run_completed",
        enabled: true,
        config: { state: "succeeded" },
      });

      const error = atlasErrorFrom(
        await atlasFireWorkflowTrigger(adminToken, created.id).catch((e: unknown) => e),
      );
      expect(error.kind).toBe("validation");
      expect(error.status).toBe(400);
      expect(error.message).toBe("workflow_run_completed triggers are fired by Atlas events");

      await atlasDeleteWorkflowTrigger(adminToken, created.id);
    });
  });

  // -------------------------------------------------------------------------
  // G. Workers and workspaces.
  // -------------------------------------------------------------------------
  describe("workers and workspaces", () => {
    /**
     * Dead like the seeded worker, but a *different* URL — see the upsert conflict rule.
     *
     * The discard port carries the "nothing listens here" guarantee; an ordinary high port would
     * only be free until a developer ran something on it. Distinct loopback *hosts* keep these
     * apart from each other and from `UNREACHABLE_WORKER_URL`, because the conflict is resolved
     * on the whole `base_url` string.
     */
    const workerUrl = (suffix: number) => `http://127.0.0.${10 + suffix}:9`;

    it("upserts a worker on base_url rather than creating a second row", async () => {
      const url = workerUrl(1);
      expect(url).not.toBe(UNREACHABLE_WORKER_URL);
      const before = await atlasListWorkers(adminToken);

      const first = await atlasUpsertWorker(adminToken, {
        name: "Upsert target",
        base_url: url,
        role: "reporter",
        tags: ["one"],
      });
      const second = await atlasUpsertWorker(adminToken, {
        name: "Renamed in place",
        base_url: url,
        role: "analyst",
        tags: ["two"],
      });

      expect(second.id).toBe(first.id);
      expect(second.name).toBe("Renamed in place");
      expect(second.role).toBe("analyst");
      expect(second.tags).toEqual(["two"]);
      expect(second.created_at).toBe(first.created_at);

      const after = await atlasListWorkers(adminToken);
      expect(after.length).toBe(before.length + 1);
      expect(after.filter((worker) => worker.base_url === url)).toHaveLength(1);

      await atlasDeleteWorker(adminToken, first.id);
    });

    it("never returns a worker token, and keeps a stored one when the write omits it", async () => {
      const created = await atlasUpsertWorker(adminToken, {
        name: "Credentialed",
        base_url: workerUrl(2),
        token: "worker-secret-do-not-echo",
      });

      expect(created).not.toHaveProperty("token");
      expect(created.token_set).toBe(true);
      expect(JSON.stringify(created)).not.toContain("worker-secret-do-not-echo");

      // A blank token is what lets the UI rename a worker without handling its secret.
      const renamed = await atlasUpsertWorker(adminToken, {
        name: "Credentialed, renamed",
        base_url: workerUrl(2),
      });
      expect(renamed.id).toBe(created.id);
      expect(renamed.token_set).toBe(true);
      expect(renamed).not.toHaveProperty("token");

      await atlasDeleteWorker(adminToken, created.id);
    });

    it("upserts a workspace on (worker_id, workspace_key) rather than duplicating it", async () => {
      const worker = await atlasUpsertWorker(adminToken, {
        name: "Workspace host",
        base_url: workerUrl(3),
      });
      const before = await atlasListWorkspaces(adminToken);

      const first = await atlasUpsertWorkspace(adminToken, {
        worker_id: worker.id,
        workspace_key: "shared-key",
        workspace_dir: "/tmp/first",
        company: "First Co",
      });
      const second = await atlasUpsertWorkspace(adminToken, {
        worker_id: worker.id,
        workspace_key: "shared-key",
        workspace_dir: "/tmp/second",
        company: "Second Co",
      });

      expect(second.id).toBe(first.id);
      expect(second.workspace_dir).toBe("/tmp/second");
      expect(second.company).toBe("Second Co");
      expect(second.created_at).toBe(first.created_at);

      const after = await atlasListWorkspaces(adminToken);
      expect(after.length).toBe(before.length + 1);

      await atlasDeleteWorker(adminToken, worker.id);
    });

    it("cascades a worker's workspaces when the worker is deleted", async () => {
      const worker = await atlasUpsertWorker(adminToken, {
        name: "Cascade source",
        base_url: workerUrl(4),
      });
      const one = await atlasUpsertWorkspace(adminToken, {
        worker_id: worker.id,
        workspace_key: "cascade-a",
        workspace_dir: "/tmp/cascade-a",
      });
      const two = await atlasUpsertWorkspace(adminToken, {
        worker_id: worker.id,
        workspace_key: "cascade-b",
        workspace_dir: "/tmp/cascade-b",
      });

      await atlasDeleteWorker(adminToken, worker.id);

      // `workspaces.worker_id … ON DELETE CASCADE` (`atlas/db.py:211`) — the rows are gone, not
      // orphaned, which is the consequence the UI has to disclose before asking to confirm.
      const remaining = await atlasListWorkspaces(adminToken);
      expect(remaining.some((workspace) => workspace.worker_id === worker.id)).toBe(false);
      for (const workspaceId of [one.id, two.id]) {
        const error = atlasErrorFrom(
          await atlasGetWorkspace(adminToken, workspaceId).catch((e: unknown) => e),
        );
        expect(error.kind).toBe("not_found");
      }
    });

    it("blocks deleting a worker that has job history, to preserve the audit trail", async () => {
      const error = atlasErrorFrom(
        await atlasDeleteWorker(adminToken, seeded!.workerId).catch((e: unknown) => e),
      );
      expect(error.kind).toBe("validation");
      expect(error.message).toContain("job(s) in history; deletion is blocked");

      // The worker the read fixtures depend on is still there.
      await expect(atlasListWorkers(adminToken)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: seeded!.workerId })]),
      );
    });

    it("deletes a workspace on its own without touching its worker", async () => {
      const worker = await atlasUpsertWorker(adminToken, {
        name: "Keeps its worker",
        base_url: workerUrl(5),
      });
      const workspace = await atlasUpsertWorkspace(adminToken, {
        worker_id: worker.id,
        workspace_key: "solo",
        workspace_dir: "/tmp/solo",
      });

      await expect(atlasDeleteWorkspace(adminToken, workspace.id)).resolves.toBeUndefined();
      await expect(atlasGetWorkspace(adminToken, workspace.id)).rejects.toThrow(AtlasError);
      const workers = await atlasListWorkers(adminToken);
      expect(workers.some((row) => row.id === worker.id)).toBe(true);

      await atlasDeleteWorker(adminToken, worker.id);
    });

    it("rejects a worker base_url that is not http(s)", async () => {
      const error = atlasErrorFrom(
        await atlasUpsertWorker(adminToken, {
          name: "Bad scheme",
          base_url: "file:///etc/passwd",
        }).catch((e: unknown) => e),
      );
      expect(error.kind).toBe("validation");
      expect(error.message).toBe("worker base_url must be an http(s) URL");
    });

    /**
     * Atlas's permission asymmetry, which admin-versus-viewer cannot express.
     *
     * `_required_permission` (`atlas/app.py:1207-1211`) demands `admin` for every non-poll write
     * under `/api/workers`, while `/api/workspaces` matches no branch and falls through to
     * `resources.manage` — and `ROLE_PERMISSIONS` (`atlas/app.py:70-73`) grants operator the
     * second but not the first. One page therefore has to disable half its actions for an
     * operator and leave the other half enabled, so the split is a contract fact, not a detail.
     */
    it("lets an operator manage workspaces while refusing it every worker mutation", async () => {
      const worker = await atlasUpsertWorker(adminToken, {
        name: "Operator subject",
        base_url: workerUrl(6),
      });

      const created = atlasErrorFrom(
        await atlasUpsertWorker(operatorToken, {
          name: "Operator's own",
          base_url: workerUrl(7),
        }).catch((e: unknown) => e),
      );
      expect(created.kind).toBe("forbidden");
      expect(created.status).toBe(403);

      const removed = atlasErrorFrom(
        await atlasDeleteWorker(operatorToken, worker.id).catch((e: unknown) => e),
      );
      expect(removed.kind).toBe("forbidden");
      expect(removed.status).toBe(403);

      // The same actor, on the same fleet page: the workspace half is permitted end to end.
      const workspace = await atlasUpsertWorkspace(operatorToken, {
        worker_id: worker.id,
        workspace_key: "operator-owned",
        workspace_dir: "/tmp/operator-owned",
      });
      expect(workspace.worker_id).toBe(worker.id);
      await expect(atlasDeleteWorkspace(operatorToken, workspace.id)).resolves.toBeUndefined();

      // A 403 that still wrote the row would be the worst outcome of the three.
      const workers = await atlasListWorkers(adminToken);
      expect(workers.some((row) => row.base_url === workerUrl(7))).toBe(false);
      expect(workers.some((row) => row.id === worker.id)).toBe(true);

      await atlasDeleteWorker(adminToken, worker.id);
    });
  });

  // -------------------------------------------------------------------------
  // H. Approvals and deliveries.
  // -------------------------------------------------------------------------
  describe("approvals", () => {
    it("lists a real pending approval under the documented envelope, and the mapper takes it", async () => {
      const started = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: gates!.plainGateWorkflowId,
      });
      await runInState(started.id, ["waiting_for_human"]);

      const approvals = await atlasListApprovals(adminToken, { runId: started.id, limit: 25 });
      expect(approvals).toHaveLength(1);

      const approval = approvals[0]!;
      expect(approval.id.startsWith("apr_")).toBe(true);
      expect(approval.run_id).toBe(started.id);
      expect(approval.node_key).toBe("gate");
      expect(approval.state).toBe("pending");

      const view = toApprovalView(approval);
      expect(view.label).toBe("Sign off");
      expect(view.reason).toBe("A person confirms before the run ends.");
      expect(view.choices).toEqual([]);
      expect(view.selectedChoice).toBeNull();
      expect(view.decidedAt).toBe("—");

      // The same row also arrives embedded in the run detail, which is where the UI reads it.
      const detail = await atlasGetWorkflowRun(adminToken, started.id);
      expect(detail.approvals.map((row) => row.id)).toEqual([approval.id]);

      await atlasRunAction(adminToken, started.id, "cancel");
    });

    it("filters the approvals list by state", async () => {
      const started = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: gates!.plainGateWorkflowId,
      });
      await runInState(started.id, ["waiting_for_human"]);

      const pending = await atlasListApprovals(adminToken, { state: "pending", limit: 100 });
      expect(pending.some((row) => row.run_id === started.id)).toBe(true);
      expect(pending.every((row) => row.state === "pending")).toBe(true);

      const rejected = await atlasListApprovals(adminToken, { state: "rejected", limit: 100 });
      expect(rejected.some((row) => row.run_id === started.id)).toBe(false);

      await atlasRunAction(adminToken, started.id, "cancel");
    });

    it("approves a gate with no choices and lets the run finish", async () => {
      const started = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: gates!.plainGateWorkflowId,
      });
      await runInState(started.id, ["waiting_for_human"], HALF_BUDGET_MS);
      const [approval] = await atlasListApprovals(adminToken, { runId: started.id, limit: 25 });

      const decided = await atlasDecideApproval(adminToken, approval!.id, { kind: "approve" });
      expect(decided.approval.state).toBe("approved");
      expect(decided.approval.decided_at).toBeTruthy();
      expect(decided.run.id).toBe(started.id);
      expect(toApprovalView(decided.approval).state.label).toBe("approved");

      // The gate has no outgoing edge, so approving it is what completes the run.
      const finished = await runInState(started.id, TERMINAL_RUN_STATES, HALF_BUDGET_MS);
      expect(finished.state).toBe("succeeded");

      const again = atlasErrorFrom(
        await atlasDecideApproval(adminToken, approval!.id, { kind: "approve" }).catch(
          (e: unknown) => e,
        ),
      );
      expect(again.message).toBe(`approval ${approval!.id} already approved`);
    });

    it("routes a gate that declares choices, and refuses a bare approve on one", async () => {
      const started = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: gates!.branchingGateWorkflowId,
      });
      await runInState(started.id, ["waiting_for_human"], HALF_BUDGET_MS);
      const [approval] = await atlasListApprovals(adminToken, { runId: started.id, limit: 25 });
      expect(toApprovalView(approval!).choices).toEqual([
        { id: "go", label: "Continue" },
        { id: "stop", label: "Stop here" },
      ]);

      const bareApprove = atlasErrorFrom(
        await atlasDecideApproval(adminToken, approval!.id, { kind: "approve" }).catch(
          (e: unknown) => e,
        ),
      );
      expect(bareApprove.message).toBe("approval requires a branch choice");

      const unknownChoice = atlasErrorFrom(
        await atlasDecideApproval(adminToken, approval!.id, {
          kind: "choose",
          choice: "sideways",
        }).catch((e: unknown) => e),
      );
      expect(unknownChoice.message).toBe("unknown approval choice: sideways");

      const decided = await atlasDecideApproval(adminToken, approval!.id, {
        kind: "choose",
        choice: "go",
      });
      expect(decided.approval.state).toBe("chosen");
      expect(decided.approval.selected_choice).toBe("go");

      // `human_selected` routed the run into the second gate, which parks it again.
      await runInState(started.id, ["waiting_for_human"], HALF_BUDGET_MS);
      const next = await atlasListApprovals(adminToken, {
        runId: started.id,
        state: "pending",
        limit: 25,
      });
      expect(next).toHaveLength(1);
      expect(next[0]!.node_key).toBe("confirm");

      await atlasRunAction(adminToken, started.id, "cancel");
    });

    it("refuses choose on a gate that declares no choices", async () => {
      const started = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: gates!.plainGateWorkflowId,
      });
      await runInState(started.id, ["waiting_for_human"]);
      const [approval] = await atlasListApprovals(adminToken, { runId: started.id, limit: 25 });

      const error = atlasErrorFrom(
        await atlasDecideApproval(adminToken, approval!.id, {
          kind: "choose",
          choice: "go",
        }).catch((e: unknown) => e),
      );
      expect(error.message).toBe("approval does not declare branch choices");

      await atlasRunAction(adminToken, started.id, "cancel");
    });

    it("rejects a gate, which fails the run with the rejection as its error", async () => {
      const started = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: gates!.plainGateWorkflowId,
      });
      await runInState(started.id, ["waiting_for_human"]);
      const [approval] = await atlasListApprovals(adminToken, { runId: started.id, limit: 25 });

      const decided = await atlasDecideApproval(adminToken, approval!.id, { kind: "reject" });
      expect(decided.approval.state).toBe("rejected");
      expect(decided.run.state).toBe("failed");
      expect(decided.run.error).toBe("human approval rejected at gate");
    });

    it("answers a decision on an unknown approval id with 400", async () => {
      const error = atlasErrorFrom(
        await atlasDecideApproval(adminToken, "apr_does_not_exist", { kind: "approve" }).catch(
          (e: unknown) => e,
        ),
      );
      expect(error.status).toBe(400);
      expect(error.message).toBe("Unknown approval_id: apr_does_not_exist");
    });
  });

  describe("deliveries", () => {
    /**
     * Named for what it asserts: the emptiness, not the envelope. Nothing in this harness can
     * produce a delivery row (see the note below), so this pins the *reason* the mapper is left
     * unproven rather than pretending to cover it. The envelope is asserted implicitly — the
     * client unwraps `{deliveries: […]}` and throws on any other shape — but a list that is empty
     * only because of declaration order could never establish it on its own.
     */
    it("has no delivery rows to list, because this harness cannot produce one", async () => {
      const deliveries = await atlasListDeliveries(adminToken, { limit: 25 });
      expect(deliveries).toEqual([]);
    });

    it("refuses to deliver a run that has not completed", async () => {
      const started = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: gates!.plainGateWorkflowId,
      });
      await runInState(started.id, ["waiting_for_human"]);

      const error = atlasErrorFrom(
        await atlasDeliverRun(adminToken, started.id).catch((e: unknown) => e),
      );
      expect(error.kind).toBe("validation");
      expect(error.message).toBe("workflow run has not completed yet");

      await atlasRunAction(adminToken, started.id, "cancel");
    });

    it("refuses to deliver a completed run that carries no reply address", async () => {
      const started = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
      });
      await runInState(started.id, TERMINAL_RUN_STATES);

      const error = atlasErrorFrom(
        await atlasDeliverRun(adminToken, started.id).catch((e: unknown) => e),
      );
      expect(error.message).toBe("workflow run has no _meta.reply.callback_url configured");
    });

    /**
     * Why no delivery row exists to map: Atlas refuses, at run *start*, any input asking for a
     * webhook reply while `ATLAS_OUTBOUND_ALLOWLIST` is empty — which it is here, because the
     * isolated instance deliberately configures nothing that can reach the network. That is
     * asserted rather than assumed, so this gap cannot quietly become "the feature is broken".
     *
     * NOT COVERED as a result: `toDeliveryView` against a real Atlas row, and the retry of a
     * real delivery. Covering them needs an allowlisted callback receiver, which is a harness
     * change (`tests/contract/atlas-instance.ts`), not a test change.
     */
    it("refuses at start a run whose input requests an undeliverable webhook reply", async () => {
      const error = atlasErrorFrom(
        await atlasStartWorkflowRun(adminToken, {
          workflowDefinitionId: gates!.plainGateWorkflowId,
          input: {
            _meta: { reply: { mode: "webhook", callback_url: "https://example.invalid/hook" } },
          },
        }).catch((e: unknown) => e),
      );
      expect(error.kind).toBe("validation");
      expect(error.message).toBe(
        "_meta.reply.callback_url is not deliverable: outbound delivery is disabled (ATLAS_OUTBOUND_ALLOWLIST is empty)",
      );
    });

    /**
     * Unlike every other unknown id on a mutation route, this one is a 404: the handler looks
     * the delivery up itself and raises `FileNotFoundError` before the service ever runs
     * (`atlas/app.py:839-841`), so the service's own "Unknown delivery_id" message is
     * unreachable from the API. A UI that expected a validation message here would render an
     * error toast where it should render "not found".
     */
    it("answers a retry of an unknown delivery id with 404, not a validation error", async () => {
      const error = atlasErrorFrom(
        await atlasRetryDelivery(adminToken, "dlv_does_not_exist").catch((e: unknown) => e),
      );
      expect(error.kind).toBe("not_found");
      expect(error.status).toBe(404);
      expect(error.fromAtlas).toBe(true);
      expect(error.message).toBe("not found");
    });
  });

  // -------------------------------------------------------------------------
  // I. Jobs.
  // -------------------------------------------------------------------------
  describe("jobs", () => {
    /** Atlas's terminal job states — the set `mark_cancel_requested` refuses to overwrite. */
    const TERMINAL_JOB_STATES = ["succeeded", "failed", "cancelled"];

    /**
     * The seeded job dials the dead seeded worker, so it settles almost at once — which is what
     * makes the *no-op* half of cancel deterministic. Cancelling it changes nothing, so the row
     * the read fixtures depend on survives this test untouched.
     */
    it("treats cancelling an already-terminal job as a no-op that returns the row unchanged", async () => {
      const settled = await until(
        `job ${seeded!.jobId} to settle`,
        () => atlasGetJob(adminToken, seeded!.jobId),
        (value) => TERMINAL_JOB_STATES.includes(value.state),
        (value) => `state ${value.state}`,
      );

      // The call is itself the envelope assertion: the client unwraps `{job: …}`
      // (`atlas/app.py:519`) and throws on any other shape.
      const cancelled = await atlasCancelJob(adminToken, seeded!.jobId);

      expect(cancelled.id).toBe(seeded!.jobId);
      expect(cancelled.state).toBe(settled.state);
      expect(cancelled.finished_at).toBe(settled.finished_at);
      expect(cancelled.updated_at).toBe(settled.updated_at);
      // The UPDATE excludes terminal rows (`atlas/db.py:2410-2414`), so the flag stays down —
      // a UI that rendered "cancelling…" off a 200 here would be lying about a settled job.
      expect(cancelled.cancel_requested).toBe(0);
    });

    it("answers a cancel on an unknown job id with 400, not 404", async () => {
      const error = atlasErrorFrom(
        await atlasCancelJob(adminToken, "job_does_not_exist").catch((e: unknown) => e),
      );
      expect(error.kind).toBe("validation");
      expect(error.status).toBe(400);
      expect(error.message).toBe("Unknown job_id: job_does_not_exist");
    });

    /**
     * NOT COVERED, deliberately: the cancel *transition*.
     *
     * A live job goes to the literal state `cancel_requested` — never `cancelled` — because
     * `atlas/db.py:2412` writes the flag and that state in one UPDATE. Observing it needs a job
     * that is still live when the cancel lands, which needs a worker holding a connection open;
     * every worker here is dead by design, so a job settles in milliseconds. This is the same
     * missing piece that leaves the successful pause/resume pair uncovered above, and racing the
     * executor for it is exactly the flake this file refuses to introduce.
     */
  });
});

describe.skipIf(available)("Atlas mutation contract (skipped)", () => {
  it("reports that no Atlas checkout was available", () => {
    expect(available).toBe(false);
  });
});
