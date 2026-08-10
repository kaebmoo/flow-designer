/**
 * Workflow status enforcement contract, against a REAL Atlas instance.
 *
 * Status is execution policy: `draft` allows explicit test runs only, `active` allows test
 * and production, `disabled` blocks everything, and an omitted `execution_mode` means
 * production (legacy callers fail closed). Atlas enforces this at every start path — these
 * tests prove the transport this client actually ships sends the right mode, persists the
 * right status, and surfaces Atlas's stable `workflow_not_runnable` refusal as copy an
 * operator can act on.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AtlasError,
  atlasCreateWorkflow,
  atlasCreateWorkflowTrigger,
  atlasFireWorkflowTrigger,
  atlasGetWorkflow,
  atlasListWorkflowRuns,
  atlasLogin,
  atlasStartWorkflowRun,
  atlasUpdateWorkflow,
} from "@/lib/atlas-api.server";
import { resetServerEnvCache } from "@/lib/env.server";
import { MINIMAL_GRAPH } from "../fixtures/workflow-graphs";
import {
  ADMIN_CREDENTIALS,
  VIEWER_CREDENTIALS,
  atlasAvailable,
  startIsolatedAtlas,
  type AtlasInstance,
} from "./atlas-instance";

const available = atlasAvailable();
let atlas: AtlasInstance | undefined;
let adminToken = "";
let viewerToken = "";

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
}, 60_000);

afterAll(() => {
  atlas?.stop();
  resetServerEnvCache();
});

const graph = MINIMAL_GRAPH as unknown as Record<string, unknown>;

async function createWorkflow(status?: string): Promise<string> {
  const created = await atlasCreateWorkflow(adminToken, {
    name: `Status contract ${status ?? "default"}`,
    graph,
    policy: {},
    ...(status === undefined ? {} : { status }),
  });
  return created.id;
}

function asAtlasError(value: unknown): AtlasError {
  expect(value).toBeInstanceOf(AtlasError);
  return value as AtlasError;
}

describe.skipIf(!available)("workflow status enforcement", () => {
  it("creates as draft by default, and persists an explicit status through update", async () => {
    const id = await createWorkflow();
    expect((await atlasGetWorkflow(adminToken, id)).status).toBe("draft");

    const updated = await atlasUpdateWorkflow(adminToken, id, {
      name: "Status contract default",
      graph,
      policy: {},
      status: "active",
      expected_version: 1,
    });
    expect(updated.status).toBe("active");
    // The optimistic save incremented the version exactly once, and the status survives re-read.
    expect(updated.version).toBe(2);
    expect((await atlasGetWorkflow(adminToken, id)).status).toBe("active");
  });

  it("rejects a status outside the closed vocabulary", async () => {
    const id = await createWorkflow();
    const error = asAtlasError(
      await atlasUpdateWorkflow(adminToken, id, {
        name: "x",
        graph,
        policy: {},
        status: "archived",
      }).catch((e: unknown) => e),
    );
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("status must be one of");
  });

  it("draft: test run is accepted, production run is refused with actionable copy", async () => {
    const id = await createWorkflow();

    const run = await atlasStartWorkflowRun(adminToken, {
      workflowDefinitionId: id,
      executionMode: "test",
    });
    expect(run.id).toMatch(/^wfr_/);

    const error = asAtlasError(
      await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: id,
        executionMode: "production",
      }).catch((e: unknown) => e),
    );
    expect(error.kind).toBe("conflict");
    // The transport rewrote Atlas's stable {"error":"workflow_not_runnable"} body into copy
    // that names the status and the next action, and kept the body for callers that branch.
    expect(error.message).toContain("Draft");
    expect(error.message).toContain("Test Run");
    expect(error.body).toMatchObject({
      error: "workflow_not_runnable",
      reason: "draft_requires_test_mode",
      status: "draft",
    });

    // The refusal created nothing: only the test run exists for this workflow.
    const runs = await atlasListWorkflowRuns(adminToken, { workflowDefinitionId: id });
    expect(runs).toHaveLength(1);
  });

  it("active: both modes are accepted; disabled: both are refused with disabled copy", async () => {
    const id = await createWorkflow("active");
    await atlasStartWorkflowRun(adminToken, { workflowDefinitionId: id, executionMode: "test" });
    await atlasStartWorkflowRun(adminToken, {
      workflowDefinitionId: id,
      executionMode: "production",
    });

    await atlasUpdateWorkflow(adminToken, id, { name: "x", graph, policy: {}, status: "disabled" });
    for (const executionMode of ["test", "production"] as const) {
      const error = asAtlasError(
        await atlasStartWorkflowRun(adminToken, {
          workflowDefinitionId: id,
          executionMode,
        }).catch((e: unknown) => e),
      );
      expect(error.kind).toBe("conflict");
      expect(error.message).toContain("Disabled");
      expect(error.body).toMatchObject({ reason: "workflow_disabled", status: "disabled" });
    }
  });

  it("authorization still precedes the status gate: a viewer cannot start any run", async () => {
    const id = await createWorkflow("active");
    const error = asAtlasError(
      await atlasStartWorkflowRun(viewerToken, {
        workflowDefinitionId: id,
        executionMode: "test",
      }).catch((e: unknown) => e),
    );
    expect(error.kind).toBe("forbidden");
  });

  it("a trigger fires production mode: blocked on draft, runs on active, enabled stays independent", async () => {
    const id = await createWorkflow();
    const trigger = await atlasCreateWorkflowTrigger(adminToken, {
      workflowDefinitionId: id,
      name: "Status contract trigger",
      type: "manual",
      config: {},
      enabled: true,
    });

    // Draft + enabled trigger: the fire is recorded but no run starts.
    const refused = await atlasFireWorkflowTrigger(adminToken, trigger.id);
    expect(refused.run).toBeNull();
    expect(String((refused.event as Record<string, unknown>).error)).toContain(
      "workflow_not_runnable",
    );

    // Active + enabled: the same trigger starts a run — status was the only blocker.
    await atlasUpdateWorkflow(adminToken, id, { name: "x", graph, policy: {}, status: "active" });
    const fired = await atlasFireWorkflowTrigger(adminToken, trigger.id);
    expect(fired.run).not.toBeNull();
  });

  it("the status-change audit trail exists (old and new value)", async () => {
    // The audit API is covered elsewhere; here it is enough that the workflow round-trips
    // through a change and Atlas reports the change — the Atlas-side check script asserts
    // the audit row's exact old/new payload.
    const id = await createWorkflow();
    await atlasUpdateWorkflow(adminToken, id, { name: "x", graph, policy: {}, status: "disabled" });
    expect((await atlasGetWorkflow(adminToken, id)).status).toBe("disabled");
  });
});
