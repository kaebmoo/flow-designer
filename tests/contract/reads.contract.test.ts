/**
 * Read-path contract tests against a REAL Atlas instance.
 *
 * These are the only tests that can prove the Phase 2 read client matches Atlas's actual wire
 * behaviour. A mocked response would merely re-assert the shape this repository already
 * believes in — including the several places where Atlas's code and its OpenAPI document
 * disagree, and where the code is what ships.
 *
 * The instance is isolated: temp database, ephemeral port, own secret key. No developer or
 * production Atlas data is touched, and the Atlas checkout is only read.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AtlasError,
  atlasGetJob,
  atlasGetMetrics,
  atlasGetWorkflow,
  atlasGetWorkflowRun,
  atlasListJobs,
  atlasListRunEvents,
  atlasListWorkers,
  atlasListWorkflowRuns,
  atlasListWorkflows,
  atlasListWorkspaces,
  atlasLogin,
} from "@/lib/atlas-api.server";
import {
  toJobListView,
  toMetricsView,
  toRunDetailView,
  toRunEventPageView,
  toWorkerView,
  toWorkflowDetailView,
  toWorkspaceView,
} from "@/lib/atlas-mappers";
import { resetServerEnvCache } from "@/lib/env.server";
import {
  ADMIN_CREDENTIALS,
  VIEWER_CREDENTIALS,
  atlasAvailable,
  startIsolatedAtlas,
  type AtlasInstance,
} from "./atlas-instance";
import { seedAtlas, type SeededAtlas } from "./atlas-seed";

const available = atlasAvailable();
let atlas: AtlasInstance | undefined;
let adminToken = "";
let viewerToken = "";
let seeded: SeededAtlas | undefined;

beforeAll(async () => {
  if (!available) return;
  atlas = await startIsolatedAtlas();

  process.env.ATLAS_API_ORIGIN = atlas.origin;
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "d".repeat(32);
  process.env.NODE_ENV = "test";
  resetServerEnvCache();

  adminToken = (await atlasLogin(ADMIN_CREDENTIALS)).token;
  viewerToken = (await atlasLogin(VIEWER_CREDENTIALS)).token;
  seeded = await seedAtlas(atlas.origin, adminToken);
}, 60_000);

afterAll(() => {
  const output = atlas?.logs() ?? "";
  if (output.trim()) {
    console.log(`--- Atlas server output ---\n${output}`);
  }
  atlas?.stop();
  resetServerEnvCache();
});

describe.skipIf(!available)("Atlas read contract", () => {
  describe("metrics", () => {
    it("returns the aggregate envelope and maps it to totals", async () => {
      const metrics = await atlasGetMetrics(adminToken);

      expect(typeof metrics.version).toBe("string");
      expect(typeof metrics.time).toBe("string");
      expect(typeof metrics.workflow_definitions).toBe("number");

      const view = toMetricsView(metrics);
      // One worker, one workflow, one run, and one job were seeded through Atlas's own API.
      expect(view.workersTotal).toBe(1);
      expect(view.workflowDefinitions).toBe(1);
      expect(view.runsTotal).toBeGreaterThanOrEqual(1);
      expect(view.jobsTotal).toBeGreaterThanOrEqual(1);
    });

    /**
     * The `GROUP BY` maps omit states with no rows (`atlas/db.py:757-762`), so a client that
     * indexed them directly would read `undefined` where it expected a count.
     */
    it("omits states that have no rows, and the mapper still totals correctly", async () => {
      const metrics = await atlasGetMetrics(adminToken);
      expect(metrics.workers.succeeded).toBeUndefined();

      const view = toMetricsView(metrics);
      expect(view.workersOnline).toBe(0);
      expect(Number.isNaN(view.workersOnline)).toBe(false);
    });
  });

  describe("workers", () => {
    it("returns the seeded worker and never includes its token", async () => {
      const workers = await atlasListWorkers(adminToken);
      expect(workers).toHaveLength(1);

      const worker = workers[0]!;
      expect(worker.id).toBe(seeded!.workerId);
      expect(worker.name).toBe("Contract Worker");
      expect(worker.tags).toEqual(["contract", "seeded"]);
      // `_public_worker` (atlas/app.py:1226-1230) pops the token and substitutes a boolean.
      expect(worker).not.toHaveProperty("token");
      expect(typeof worker.token_set).toBe("boolean");
    });

    /**
     * A never-polled worker is `unknown` with a null `last_seen_at` and an empty `agent_info`
     * — not offline, and not a fabricated version string.
     */
    it("reports a never-polled worker honestly through the mapper", async () => {
      const [worker] = await atlasListWorkers(adminToken);
      const view = toWorkerView(worker!);

      expect(view.status.label).toBe("unknown");
      expect(view.status.tone).toBe("muted");
      expect(view.agentVersion).toBeNull();
      expect(view.lastSeenAt).toBe("—");
    });
  });

  describe("workspaces", () => {
    it("joins the worker name and status onto each list row", async () => {
      const workspaces = await atlasListWorkspaces(adminToken);
      expect(workspaces).toHaveLength(1);

      const view = toWorkspaceView(workspaces[0]!);
      expect(view.workspaceKey).toBe("contract-ws");
      expect(view.workspaceDir).toBe("/tmp/contract-ws");
      expect(view.company).toBe("Contract Co");
      expect(view.workerName).toBe("Contract Worker");
      expect(view.workerStatus.label).toBe("unknown");
    });
  });

  describe("workflows", () => {
    it("lists the seeded definition with its graph", async () => {
      const workflows = await atlasListWorkflows(adminToken, { limit: 25 });
      expect(workflows).toHaveLength(1);
      expect(workflows[0]!.id).toBe(seeded!.workflowId);
      // `status` exists on a definition; `enabled` does not (that is a trigger column).
      expect(typeof workflows[0]!.status).toBe("string");
      expect(workflows[0]).not.toHaveProperty("enabled");
    });

    it("resolves a definition by id and maps its graph to read-only rows", async () => {
      const workflow = await atlasGetWorkflow(adminToken, seeded!.workflowId);
      const view = toWorkflowDetailView(workflow);

      expect(view.name).toBe("Contract Workflow");
      expect(view.startNodeId).toBe("n1");
      expect(view.graphNodes).toEqual([
        { id: "n1", type: "worker", label: "Reporter", isStart: true },
      ]);
      expect(view.graphEdges).toEqual([]);
      expect(view.policy.map((p) => p.key)).toContain("max_jobs");
    });

    it("raises not_found — not a generic failure — for an unknown id", async () => {
      const error = await atlasGetWorkflow(adminToken, "wfd_does_not_exist").catch((e) => e);
      expect(error).toBeInstanceOf(AtlasError);
      expect(error.kind).toBe("not_found");
      expect(error.status).toBe(404);
    });

    /**
     * Pins Atlas's clamp as a *contract fact*, by asserting on the wire rather than on the
     * result.
     *
     * Asserting only that `limit: 0` still returns rows would pass with the client's clamp
     * removed, because Atlas clamps `0` to `1` itself (`atlas/app.py:79-87`) — a test that
     * cannot fail. What actually matters is that the client and Atlas agree on the window that
     * was applied, so this checks the value that left the client and the rows that came back.
     */
    it("sends a clamped limit on the wire and Atlas honours exactly that window", async () => {
      const urls: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        return realFetch(input, init);
      }) as typeof fetch;

      try {
        await expect(atlasListWorkflows(adminToken, { limit: 0 })).resolves.toHaveLength(1);
        await expect(atlasListWorkflows(adminToken, { limit: 10_001 })).resolves.toHaveLength(1);
      } finally {
        globalThis.fetch = realFetch;
      }

      expect(new URL(urls[0]!).searchParams.get("limit")).toBe("1");
      expect(new URL(urls[1]!).searchParams.get("limit")).toBe("10000");
    });
  });

  describe("workflow runs", () => {
    it("lists runs under the `runs` envelope key, newest first", async () => {
      const runs = await atlasListWorkflowRuns(adminToken, { limit: 25 });
      expect(runs.length).toBeGreaterThanOrEqual(1);
      expect(runs.some((r) => r.id === seeded!.runId)).toBe(true);
    });

    it("filters by workflow_definition_id, the one filter Atlas supports here", async () => {
      const mine = await atlasListWorkflowRuns(adminToken, {
        limit: 25,
        workflowDefinitionId: seeded!.workflowId,
      });
      expect(mine.length).toBeGreaterThanOrEqual(1);

      const none = await atlasListWorkflowRuns(adminToken, {
        limit: 25,
        workflowDefinitionId: "wfd_nothing_matches",
      });
      expect(none).toEqual([]);
    });

    /**
     * Every list row carries the full snapshotted graph because the query is `SELECT *`
     * (`atlas/db.py:1178`). The mapper must drop it, or a page of runs ships several graphs'
     * worth of JSON to a browser that renders none of it.
     */
    it("returns graph snapshots on list rows, and the view model drops them", async () => {
      const [run] = await atlasListWorkflowRuns(adminToken, { limit: 25 });
      expect(run).toHaveProperty("graph_snapshot");

      const view = toRunDetailView({ run: run!, nodes: [], edges: [], approvals: [] });
      expect(view.run).not.toHaveProperty("graph_snapshot");
      expect(view.run).not.toHaveProperty("policy_snapshot");
    });

    it("returns run, nodes, edges, and approvals for a run by id", async () => {
      const detail = await atlasGetWorkflowRun(adminToken, seeded!.runId);

      expect(detail.run.id).toBe(seeded!.runId);
      expect(Array.isArray(detail.nodes)).toBe(true);
      expect(Array.isArray(detail.edges)).toBe(true);
      expect(Array.isArray(detail.approvals)).toBe(true);

      const view = toRunDetailView(detail);
      expect(view.run.id).toBe(seeded!.runId);
      // Well under Atlas's silent 100-approval cap, so no truncation is claimed.
      expect(view.approvalsMayBeTruncated).toBe(false);
    });

    it("raises not_found for an unknown run id", async () => {
      const error = await atlasGetWorkflowRun(adminToken, "wfr_does_not_exist").catch((e) => e);
      expect(error.kind).toBe("not_found");
    });

    it("walks persisted run events with an exclusive cursor page", async () => {
      let page = await atlasListRunEvents(adminToken, seeded!.runId, { limit: 1 });
      for (let attempt = 0; page.events.length === 0 && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        page = await atlasListRunEvents(adminToken, seeded!.runId, { limit: 1 });
      }

      expect(page.after).toBe(0);
      expect(page.next_after).toBe(page.events.at(-1)?.seq ?? 0);
      expect(typeof page.has_more).toBe("boolean");
      const view = toRunEventPageView(page);
      expect(view.events.map((event) => event.seq)).toEqual(
        [...view.events].sort((left, right) => left.seq - right.seq).map((event) => event.seq),
      );

      if (page.events.length > 0) {
        const next = await atlasListRunEvents(adminToken, seeded!.runId, {
          limit: 1,
          after: page.next_after,
        });
        expect(next.after).toBe(page.next_after);
        expect(next.events.every((event) => event.seq > page.next_after)).toBe(true);
      }
    });
  });

  describe("jobs", () => {
    it("joins worker name and workspace key onto list rows", async () => {
      const jobs = await atlasListJobs(adminToken, { limit: 25 });
      expect(jobs.length).toBeGreaterThanOrEqual(1);

      const seededJob = jobs.find((j) => j.id === seeded!.jobId)!;
      const view = toJobListView(seededJob);
      expect(view.workerName).toBe("Contract Worker");
      expect(view.workspaceKey).toBe("contract-ws");
      expect(view.prompt).toBe("Contract fixture job.");
    });

    /**
     * The by-id route is a plain `SELECT *` with no join (`atlas/db.py:2600-2603`), so the two
     * responses genuinely differ. A client that assumed one shape would render "undefined".
     */
    it("returns the un-joined row by id, without worker_name or workspace_key", async () => {
      const job = await atlasGetJob(adminToken, seeded!.jobId);
      expect(job.id).toBe(seeded!.jobId);
      expect(job).not.toHaveProperty("worker_name");
      expect(job).not.toHaveProperty("workspace_key");
    });

    it("raises not_found for an unknown job id", async () => {
      const error = await atlasGetJob(adminToken, "job_does_not_exist").catch((e) => e);
      expect(error.kind).toBe("not_found");
    });
  });

  describe("authorization", () => {
    /**
     * Every read in Phase 2 needs only the `read` permission (`atlas/app.py:1195`), so a
     * viewer must see all of them. If this ever fails, the UI is about to hide data from a
     * role Atlas actually allows.
     */
    it("lets a viewer perform every Phase 2 read", async () => {
      await expect(atlasGetMetrics(viewerToken)).resolves.toBeTruthy();
      await expect(atlasListWorkers(viewerToken)).resolves.toHaveLength(1);
      await expect(atlasListWorkspaces(viewerToken)).resolves.toHaveLength(1);
      await expect(atlasListWorkflows(viewerToken, { limit: 25 })).resolves.toHaveLength(1);
      await expect(atlasGetWorkflow(viewerToken, seeded!.workflowId)).resolves.toBeTruthy();
      await expect(atlasListWorkflowRuns(viewerToken, { limit: 25 })).resolves.toBeTruthy();
      await expect(atlasGetWorkflowRun(viewerToken, seeded!.runId)).resolves.toBeTruthy();
      await expect(atlasListJobs(viewerToken, { limit: 25 })).resolves.toBeTruthy();
      await expect(atlasGetJob(viewerToken, seeded!.jobId)).resolves.toBeTruthy();
    });

    it("rejects an unauthenticated read with 401, not 403", async () => {
      const error = await atlasListWorkers("not-a-real-token").catch((e) => e);
      expect(error).toBeInstanceOf(AtlasError);
      expect(error.kind).toBe("unauthorized");
      expect(error.status).toBe(401);
    });

    /**
     * 403 must stay distinct from 401 on a real read path. `/api/users` requires `admin` even
     * for GET (`atlas/app.py:1185-1186`), so a viewer is authenticated yet forbidden — which
     * is exactly the case Phase 1 could not exercise in a rendered screen.
     */
    it("distinguishes forbidden from unauthorized on an admin-only read", async () => {
      const forbidden = await fetch(`${atlas!.origin}/api/users`, {
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(forbidden.status).toBe(403);

      const unauthenticated = await fetch(`${atlas!.origin}/api/users`);
      expect(unauthenticated.status).toBe(401);
    });
  });

  describe("no bearer leaks into a URL", () => {
    it("keeps the token in the Authorization header for a read with query parameters", async () => {
      const calls: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        return realFetch(input, init);
      }) as typeof fetch;

      try {
        await atlasListWorkflowRuns(adminToken, {
          limit: 5,
          workflowDefinitionId: seeded!.workflowId,
        });
      } finally {
        globalThis.fetch = realFetch;
      }

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("limit=5");
      expect(calls[0]).not.toContain(adminToken);
      expect(calls[0]).not.toContain("token=");
    });
  });
});

describe.skipIf(available)("Atlas read contract (skipped)", () => {
  it("reports that no Atlas checkout was available", () => {
    expect(available).toBe(false);
  });
});
