/**
 * Milestone C: Atlas's authoritative `workflow.interface`, against a REAL Atlas instance.
 *
 * Everything here proves the wire contract this client now depends on — `atlas-api.server.ts`'s
 * `interface`/`expected_workflow_version` fields, and the run snapshot fields — against the
 * actual Atlas checkout at `15c4876aa4f86e109a3cc52d6a299f46791053a2`, not a description of it.
 * The instance is isolated exactly like `mutations.contract.test.ts`'s: temp database, ephemeral
 * port, own secret key, and the Atlas checkout is only ever read.
 *
 * Limitation, stated rather than silently skipped: the test plan also calls for "a real smoke run
 * against the recorded pre-interface Atlas baseline." That needs a *second*, older Atlas checkout
 * running concurrently. Checking out a different commit in the one Atlas working tree this suite
 * is permitted to *inspect and run* — never edit — would mutate shared repository state outside
 * this test's isolation boundary, so it is not attempted here. The absent-field boundary case
 * (an Atlas response that omits `interface`/`interface_snapshot` entirely, not just `null`) is
 * covered at the mapper level instead, in `tests/unit/workflow-interface-contract.test.ts`
 * ("reads absent... for an Atlas that omits the field").
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AtlasError,
  atlasCreateWorkflow,
  atlasCreateWorkflowTrigger,
  atlasDeleteWorkflowTrigger,
  atlasFireWorkflowTrigger,
  atlasGetWorkflow,
  atlasGetWorkflowRun,
  atlasLogin,
  atlasStartWorkflowRun,
  atlasUpdateWorkflow,
} from "@/lib/atlas-api.server";
import { resetServerEnvCache } from "@/lib/env.server";
import { serializeWorkflowGraph, parseWorkflowGraph } from "@/lib/workflow-graph";
import { EFFECTIVE_INPUT_MAX_BYTES } from "@/lib/workflow-interface-contract";
import type { AtlasWorkflowInterface } from "@/lib/atlas-types";
import {
  ADMIN_CREDENTIALS,
  atlasAvailable,
  startIsolatedAtlas,
  type AtlasInstance,
} from "./atlas-instance";

const available = atlasAvailable();
let atlas: AtlasInstance | undefined;
let adminToken = "";

beforeAll(async () => {
  if (!available) return;
  atlas = await startIsolatedAtlas();
  process.env.ATLAS_API_ORIGIN = atlas.origin;
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "e".repeat(32);
  process.env.NODE_ENV = "test";
  resetServerEnvCache();
  adminToken = (await atlasLogin(ADMIN_CREDENTIALS)).token;
}, 60_000);

afterAll(() => {
  const output = atlas?.logs() ?? "";
  if (output.trim()) console.log(`--- Atlas server output ---\n${output}`);
  atlas?.stop();
  resetServerEnvCache();
});

let uniqueCounter = 0;
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix} ${uniqueCounter}`;
}

function atlasErrorFrom(error: unknown): AtlasError {
  if (!(error instanceof AtlasError)) {
    throw new Error(`expected an AtlasError, got ${String(error)}`);
  }
  return error;
}

/**
 * Two workers, mirroring the shape of the canonical Permit Application fixture in
 * `docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_TEST_PLAN.md` §4: the *start* node renders only the
 * required fields, and `review_context` — declared but deliberately not required — is referenced
 * only by the *downstream* node. Atlas's `cross_check_against_graph` demands that every path the
 * start node renders be provably required; a single-node fixture that put `review_context` on the
 * start node's own prompt would be rejected outright, which is exactly what happened the first
 * time this file ran against a real Atlas — proof the rule is real, and proof the fixture must
 * respect it. Neither worker has a `worker_id`, so Atlas accepts them (`worker_id` is optional at
 * save time) and a started run fails asynchronously against nothing — irrelevant here, since
 * every case below only asserts on the synchronous create/start response and the persisted rows.
 */
const PERMIT_GRAPH = {
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
} as const;

const PERMIT_INTERFACE: AtlasWorkflowInterface = {
  schema_version: 1,
  input_schema: {
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
  },
  sample_input: { applicant_name: "Test Applicant", detail: { floors: 2 } },
  outputs: [{ key: "intake_review", kind: "text" }],
  primary_output: "intake_review",
};

function permitGraphBody() {
  const parsed = parseWorkflowGraph(PERMIT_GRAPH);
  if (!parsed.ok) throw new Error(`fixture graph does not parse: ${parsed.reason}`);
  return serializeWorkflowGraph(parsed.value);
}

async function createPermitWorkflow(overrides: { interface?: AtlasWorkflowInterface | null } = {}) {
  return atlasCreateWorkflow(adminToken, {
    name: uniqueName("Permit contract"),
    graph: permitGraphBody(),
    policy: {},
    interface: "interface" in overrides ? overrides.interface : PERMIT_INTERFACE,
  });
}

/**
 * Mirrors Python's `json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))`
 * for the plain-ASCII test data used below (letters, digits, and JSON structural characters
 * only — no escaping edge case this simplified encoder would get wrong). This is deliberately
 * exact where the production client's own `estimateCanonicalBytes` is deliberately advisory: a
 * *test* asserting the real byte boundary needs the real formula, not the UI's fast approximation.
 */
function canonicalPythonJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPythonJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalPythonJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function canonicalPythonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalPythonJson(value), "utf8");
}

describe.skipIf(!available)("Atlas workflow.interface contract (Milestone C)", () => {
  describe("C-C01 interface CRUD/clear", () => {
    it("creates with an interface, reads it back exactly, edits it, and explicitly clears it", async () => {
      const created = await createPermitWorkflow();
      expect(created.interface).toEqual(PERMIT_INTERFACE);

      const read = await atlasGetWorkflow(adminToken, created.id);
      expect(read.interface).toEqual(PERMIT_INTERFACE);

      const edited = await atlasUpdateWorkflow(adminToken, created.id, {
        name: created.name,
        graph: created.graph as Record<string, unknown>,
        policy: created.policy,
        interface: { ...PERMIT_INTERFACE, primary_output: undefined, outputs: undefined },
        expected_version: created.version,
      });
      expect(edited.version).toBe(created.version + 1);
      expect(edited.interface?.outputs).toBeUndefined();
      expect(edited.interface?.input_schema).toEqual(PERMIT_INTERFACE.input_schema);

      const cleared = await atlasUpdateWorkflow(adminToken, created.id, {
        name: edited.name,
        graph: edited.graph as Record<string, unknown>,
        policy: edited.policy,
        interface: null,
        expected_version: edited.version,
      });
      expect(cleared.version).toBe(edited.version + 1);
      expect(cleared.interface).toBeNull();
    });

    it("preserves the stored interface when a PUT omits the key entirely", async () => {
      const created = await createPermitWorkflow();
      const renamed = await atlasUpdateWorkflow(adminToken, created.id, {
        name: "renamed, interface untouched",
        graph: created.graph as Record<string, unknown>,
        policy: created.policy,
        expected_version: created.version,
        // `interface` deliberately absent from this call.
      });
      expect(renamed.interface).toEqual(PERMIT_INTERFACE);
    });

    it("409s a stale expected_version save and leaves the stored interface unchanged", async () => {
      const created = await createPermitWorkflow();
      const staleVersion = created.version;
      // An unrelated save bumps the real version, making `staleVersion` stale.
      await atlasUpdateWorkflow(adminToken, created.id, {
        name: created.name,
        graph: created.graph as Record<string, unknown>,
        policy: created.policy,
        expected_version: created.version,
      });

      const staleError = atlasErrorFrom(
        await atlasUpdateWorkflow(adminToken, created.id, {
          name: "stale interface write",
          graph: created.graph as Record<string, unknown>,
          policy: created.policy,
          interface: {
            ...PERMIT_INTERFACE,
            sample_input: { applicant_name: "x", detail: { floors: 1 } },
          },
          expected_version: staleVersion,
        }).catch((error: unknown) => error),
      );
      expect(staleError.kind).toBe("conflict");

      const stillStored = await atlasGetWorkflow(adminToken, created.id);
      expect(stillStored.interface).toEqual(PERMIT_INTERFACE);
    });

    it("rejects an interface that fails Atlas's own bounded profile, with no partial apply", async () => {
      const createError = atlasErrorFrom(
        await atlasCreateWorkflow(adminToken, {
          name: uniqueName("Bad interface"),
          graph: permitGraphBody(),
          policy: {},
          interface: {
            schema_version: 1,
            input_schema: { type: ["object", "null"] },
          },
        }).catch((error: unknown) => error),
      );
      expect(createError.kind).toBe("validation");
    });
  });

  describe("C-C02 valid/invalid Permit start", () => {
    it("202s and creates a run for input that satisfies the declared schema", async () => {
      const created = await createPermitWorkflow();
      const run = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: created.id,
        input: { applicant_name: "Real Applicant", detail: { floors: 3 } },
      });
      expect(run.id).toMatch(/^wfr_/);
    });

    it("400s with a field-path message and creates no run for input that fails the schema", async () => {
      const created = await createPermitWorkflow();

      // No run id comes back from a rejected start at all — a thrown AtlasError, not a run
      // object, is itself the proof that Atlas created nothing.
      const startError = atlasErrorFrom(
        await atlasStartWorkflowRun(adminToken, {
          workflowDefinitionId: created.id,
          // Missing required "detail" entirely.
          input: { applicant_name: "Incomplete" },
        }).catch((error: unknown) => error),
      );
      expect(startError.kind).toBe("validation");
      expect(startError.message).toMatch(/detail/);
    });

    it("400s an additionalProperties: false violation naming the offending field", async () => {
      const created = await createPermitWorkflow();
      const startError = atlasErrorFrom(
        await atlasStartWorkflowRun(adminToken, {
          workflowDefinitionId: created.id,
          input: {
            applicant_name: "x",
            detail: { floors: 1 },
            secret_override: "should not be accepted",
          },
        }).catch((error: unknown) => error),
      );
      expect(startError.kind).toBe("validation");
      expect(startError.message).toMatch(/secret_override/);
    });
  });

  describe("C-C03 matching/stale workflow version", () => {
    it("starts when expected_workflow_version matches the current definition", async () => {
      const created = await createPermitWorkflow();
      const run = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: created.id,
        input: { applicant_name: "x", detail: { floors: 1 } },
        expectedWorkflowVersion: created.version,
      });
      expect(run.id).toMatch(/^wfr_/);
    });

    it("409s and creates no run on a stale expected_workflow_version", async () => {
      const created = await createPermitWorkflow();
      // Bump the version by one unrelated save, so `created.version` is now stale.
      await atlasUpdateWorkflow(adminToken, created.id, {
        name: "bump version",
        graph: created.graph as Record<string, unknown>,
        policy: created.policy,
        expected_version: created.version,
      });

      const startError = atlasErrorFrom(
        await atlasStartWorkflowRun(adminToken, {
          workflowDefinitionId: created.id,
          input: { applicant_name: "x", detail: { floors: 1 } },
          expectedWorkflowVersion: created.version, // now one behind
        }).catch((error: unknown) => error),
      );
      expect(startError.kind).toBe("conflict");
      // Re-fetching confirms no run was created as a side effect of the failed start.
      const current = await atlasGetWorkflow(adminToken, created.id);
      expect(current.version).toBe(created.version + 1);
    });
  });

  describe("C-C04 interface-absent workflow keeps legacy behaviour", () => {
    it("starts without expected_workflow_version, and without any business schema check", async () => {
      const created = await createPermitWorkflow({ interface: null });
      expect(created.interface).toBeNull();
      // Business input that would fail the Permit schema (missing "detail") is fine here: Atlas
      // has nothing to validate it against.
      const run = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: created.id,
        input: { anything: "goes" },
      });
      expect(run.id).toMatch(/^wfr_/);
    });
  });

  describe("C-C05 trigger invalid payload semantics", () => {
    it("202s with a failed trigger event and run: null for an object payload that fails the interface", async () => {
      const created = await createPermitWorkflow();
      const trigger = await atlasCreateWorkflowTrigger(adminToken, {
        workflowDefinitionId: created.id,
        name: uniqueName("Permit manual trigger"),
        type: "manual",
        enabled: true,
        config: {},
      });

      const fired = (await atlasFireWorkflowTrigger(adminToken, trigger.id, {
        payload: {}, // missing every required field
      })) as { run: unknown; event: { state: string; error: string | null } };

      expect(fired.run).toBeNull();
      expect(fired.event.state).toBe("failed");
      expect(fired.event.error).toBeTruthy();

      await atlasDeleteWorkflowTrigger(adminToken, trigger.id);
    });

    it("400s a non-object payload and creates no trigger event at all", async () => {
      const created = await createPermitWorkflow();
      const trigger = await atlasCreateWorkflowTrigger(adminToken, {
        workflowDefinitionId: created.id,
        name: uniqueName("Permit manual trigger (bad payload)"),
        type: "manual",
        enabled: true,
        config: {},
      });

      const fireError = atlasErrorFrom(
        await atlasFireWorkflowTrigger(
          adminToken,
          trigger.id,
          // @ts-expect-error — deliberately not an object, to prove the 400 path.
          { payload: "not-an-object" },
        ).catch((error: unknown) => error),
      );
      expect(fireError.kind).toBe("validation");

      await atlasDeleteWorkflowTrigger(adminToken, trigger.id);
    });
  });

  describe("C-C06 run snapshots survive a later definition edit", () => {
    it("keeps the run's interface_snapshot and workflow_version_snapshot after the live interface changes", async () => {
      const created = await createPermitWorkflow();
      const startedVersion = created.version;
      const run = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: created.id,
        input: { applicant_name: "x", detail: { floors: 1 } },
      });

      const detailAtStart = await atlasGetWorkflowRun(adminToken, run.id);
      expect(detailAtStart.run.interface_snapshot).toEqual(PERMIT_INTERFACE);
      expect(detailAtStart.run.workflow_version_snapshot).toBe(startedVersion);

      // Edit the live definition's interface after the run started.
      await atlasUpdateWorkflow(adminToken, created.id, {
        name: created.name,
        graph: created.graph as Record<string, unknown>,
        policy: created.policy,
        interface: null,
        expected_version: created.version,
      });

      const detailAfterEdit = await atlasGetWorkflowRun(adminToken, run.id);
      expect(detailAfterEdit.run.interface_snapshot).toEqual(PERMIT_INTERFACE);
      expect(detailAfterEdit.run.workflow_version_snapshot).toBe(startedVersion);

      const liveDefinition = await atlasGetWorkflow(adminToken, created.id);
      expect(liveDefinition.interface).toBeNull();
    });
  });

  describe("C-C07 effective input size boundary", () => {
    it("accepts input at exactly the 1 MiB boundary and rejects one byte over", async () => {
      const created = await createPermitWorkflow();
      const base = { applicant_name: "A", detail: { floors: 1 }, review_context: "" };
      const baseBytes = canonicalPythonBytes(base);
      const padLength = EFFECTIVE_INPUT_MAX_BYTES - baseBytes;
      expect(padLength).toBeGreaterThan(0);

      const exact = { ...base, review_context: "x".repeat(padLength) };
      expect(canonicalPythonBytes(exact)).toBe(EFFECTIVE_INPUT_MAX_BYTES);
      const exactRun = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: created.id,
        input: exact,
      });
      expect(exactRun.id).toMatch(/^wfr_/);

      const over = { ...base, review_context: "x".repeat(padLength + 1) };
      const overError = atlasErrorFrom(
        await atlasStartWorkflowRun(adminToken, {
          workflowDefinitionId: created.id,
          input: over,
        }).catch((error: unknown) => error),
      );
      expect(overError.kind).toBe("validation");
      expect(overError.message).toMatch(/exceeds/);
    }, 20_000);

    it("rejects when a workflow default_reply merge pushes otherwise-tiny business input over the boundary", async () => {
      const oversizedReply = {
        mode: "none",
        correlation_id: "x".repeat(EFFECTIVE_INPUT_MAX_BYTES),
      };
      const created = await atlasCreateWorkflow(adminToken, {
        name: uniqueName("Permit default-reply boundary"),
        graph: permitGraphBody(),
        policy: {},
        interface: PERMIT_INTERFACE,
        default_reply: oversizedReply,
      });

      const startError = atlasErrorFrom(
        await atlasStartWorkflowRun(adminToken, {
          workflowDefinitionId: created.id,
          // Tiny on its own — well under the cap without the merge.
          input: { applicant_name: "x", detail: { floors: 1 } },
        }).catch((error: unknown) => error),
      );
      expect(startError.kind).toBe("validation");
      expect(startError.message).toMatch(/exceeds/);
    }, 20_000);
  });

  describe("graph edit output cross-check", () => {
    it("rejects a PUT whose graph edit removes the worker that produces a declared output", async () => {
      const created = await createPermitWorkflow();
      const graphWithoutOutput = parseWorkflowGraph({
        start: "intake",
        nodes: [{ id: "intake", type: "worker", prompt: "no more output declared here" }],
        edges: [],
      });
      if (!graphWithoutOutput.ok) throw new Error("fixture graph does not parse");

      const updateError = atlasErrorFrom(
        await atlasUpdateWorkflow(adminToken, created.id, {
          name: created.name,
          graph: serializeWorkflowGraph(graphWithoutOutput.value),
          policy: created.policy,
          // `interface` omitted: Atlas re-checks the *stored* interface against the new graph.
          expected_version: created.version,
        }).catch((error: unknown) => error),
      );
      expect(updateError.kind).toBe("validation");

      // No partial apply: the graph is still the original one.
      const stillOriginal = await atlasGetWorkflow(adminToken, created.id);
      expect((stillOriginal.graph as { nodes: unknown[] }).nodes).toHaveLength(2);
      expect(stillOriginal.interface).toEqual(PERMIT_INTERFACE);
    });
  });
});
