/**
 * Phase 5 contract tests against a REAL Atlas instance.
 *
 * Conversations, deliveries, audit, usage, users, and API tokens — the operational surfaces —
 * exercised through the production client operations, with the role matrix asserted against
 * Atlas's own enforcement. Nothing is stubbed; the isolated instance is a temp database on an
 * ephemeral port.
 *
 * The instance runs with `ATLAS_OUTBOUND_ALLOWLIST=127.0.0.1` so a delivery to a dead
 * loopback target is *attempted* (and fails) rather than blocked — the only way to walk a
 * delivery to `failed`. A `blocked` row cannot be manufactured at all against a fixed
 * allowlist (see the deliveries block for why); the fail-closed run-start rejection is
 * asserted in its place.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AtlasError,
  atlasCreateApiToken,
  atlasCreateConversation,
  atlasCreateUser,
  atlasDeleteUser,
  atlasDeliverRun,
  atlasDownloadArtifact,
  atlasExportAuditCsv,
  atlasExportUsageCsv,
  atlasGetArtifact,
  atlasGetUsage,
  atlasGetWorkflowRun,
  atlasListApiTokens,
  atlasListAudit,
  atlasListConversations,
  atlasListDeliveries,
  atlasListRunArtifacts,
  atlasListUsers,
  atlasLogin,
  atlasRenameApiToken,
  atlasRetryDelivery,
  atlasRevokeApiToken,
  atlasStartWorkflowRun,
  atlasUpdateUser,
} from "@/lib/atlas-api.server";
import { resetServerEnvCache } from "@/lib/env.server";
import {
  ADMIN_CREDENTIALS,
  AUDITOR_CREDENTIALS,
  OPERATOR_CREDENTIALS,
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
let operatorToken = "";
let auditorToken = "";
let seeded: SeededAtlas | undefined;

/** Raw fetch for routes the client deliberately has no operation for (proving 404s). */
async function rawRequest(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<Response> {
  return fetch(`${atlas!.origin}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      // The keep-alive desync workaround the production client applies to every POST.
      connection: "close",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function expectAtlasError(promise: Promise<unknown>, kind: AtlasError["kind"]) {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AtlasError);
  expect((thrown as AtlasError).kind).toBe(kind);
  return thrown as AtlasError;
}

async function waitForRunState(runId: string, states: string[], timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await atlasGetWorkflowRun(adminToken, runId);
    if (states.includes(detail.run.state)) return detail.run;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} never reached ${states.join("/")}; at ${detail.run.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

beforeAll(async () => {
  if (!available) return;
  atlas = await startIsolatedAtlas({ ATLAS_OUTBOUND_ALLOWLIST: "127.0.0.1" });

  process.env.ATLAS_API_ORIGIN = atlas.origin;
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "d".repeat(32);
  process.env.NODE_ENV = "test";
  resetServerEnvCache();

  adminToken = (await atlasLogin(ADMIN_CREDENTIALS)).token;
  viewerToken = (await atlasLogin(VIEWER_CREDENTIALS)).token;
  operatorToken = (await atlasLogin(OPERATOR_CREDENTIALS)).token;
  auditorToken = (await atlasLogin(AUDITOR_CREDENTIALS)).token;
  seeded = await seedAtlas(atlas.origin, adminToken);
}, 90_000);

afterAll(() => {
  const output = atlas?.logs() ?? "";
  if (output.trim()) {
    console.log(`--- Atlas server output ---\n${output}`);
  }
  atlas?.stop();
  resetServerEnvCache();
});

describe.skipIf(!available)("Phase 5 operational contract", () => {
  describe("conversations", () => {
    it("any role can read; create requires resources.manage", async () => {
      // Viewer: read yes (plain `read`), create no.
      await atlasListConversations(viewerToken);
      await expectAtlasError(
        atlasCreateConversation(viewerToken, { title: "viewer cannot" }),
        "forbidden",
      );
      // Auditor holds no resources.manage either.
      await expectAtlasError(
        atlasCreateConversation(auditorToken, { title: "auditor cannot" }),
        "forbidden",
      );

      const operatorCreated = await atlasCreateConversation(operatorToken, {
        title: "operator conversation",
        workspace_key: "contract-ws",
        company: "Contract Co",
      });
      expect(operatorCreated.id).toMatch(/^cnv_/);

      const adminCreated = await atlasCreateConversation(adminToken, {
        title: "admin conversation",
      });
      const list = await atlasListConversations(viewerToken);
      const ids = list.map((row) => row.id);
      expect(ids).toContain(operatorCreated.id);
      expect(ids).toContain(adminCreated.id);
    });

    it("has no get-by-id, update, or delete route — the operations 404", async () => {
      const created = await atlasCreateConversation(adminToken, { title: "no detail route" });
      const get = await rawRequest("GET", `/api/conversations/${created.id}`, adminToken);
      expect(get.status).toBe(404);
      const put = await rawRequest("PUT", `/api/conversations/${created.id}`, adminToken, {
        title: "renamed",
      });
      expect(put.status).toBe(404);
      const del = await rawRequest("DELETE", `/api/conversations/${created.id}`, adminToken);
      expect(del.status).toBe(404);
    });

    it(
      "the list is a fixed window of the 100 most recently updated rows",
      { timeout: 120_000 },
      async () => {
        // Three deliberately-old rows, separated by more than Atlas's one-second timestamp
        // resolution so the cutoff between old and new is unambiguous.
        const oldIds: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const row = await atlasCreateConversation(adminToken, { title: `old ${index}` });
          oldIds.push(row.id);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        const newIds: string[] = [];
        for (let index = 0; index < 100; index += 1) {
          const row = await atlasCreateConversation(adminToken, { title: `recent ${index}` });
          newIds.push(row.id);
        }

        const list = await atlasListConversations(adminToken);
        expect(list).toHaveLength(100);
        const listedIds = new Set(list.map((row) => row.id));
        for (const id of newIds) expect(listedIds.has(id)).toBe(true);
        // The older rows (and everything created before them) fell out of the fixed window.
        for (const id of oldIds) expect(listedIds.has(id)).toBe(false);
      },
    );
  });

  describe("artifacts", () => {
    it("has no global artifact list: GET /api/artifacts is not a route", async () => {
      const response = await rawRequest("GET", "/api/artifacts", adminToken);
      expect(response.status).toBe(404);
    });

    it("run-scoped artifacts are readable by any role; content is file_ref-only", async () => {
      // Created through Atlas's own API (workflows.run) — an inline text artifact.
      const created = await rawRequest("POST", "/api/artifacts", adminToken, {
        run_id: seeded!.runId,
        key: "contract_note",
        kind: "text",
        content: "phase 5 contract artifact",
      });
      expect(created.status).toBe(201);
      const artifactId = ((await created.json()) as { artifact: { id: string } }).artifact.id;

      // A viewer reads the run's artifacts — GETs need only `read`.
      const listed = await atlasListRunArtifacts(viewerToken, seeded!.runId);
      expect(listed.map((row) => row.id)).toContain(artifactId);

      const metadata = await atlasGetArtifact(viewerToken, artifactId);
      expect(metadata.kind).toBe("text");
      expect(metadata.content).toBe("phase 5 contract artifact");

      // Bytes exist only for file_ref artifacts; Atlas refuses everything else with a 400.
      await expectAtlasError(atlasDownloadArtifact(viewerToken, artifactId), "validation");

      // A viewer cannot create one: POST /api/artifacts needs workflows.run.
      const refused = await rawRequest("POST", "/api/artifacts", viewerToken, {
        run_id: seeded!.runId,
        key: "viewer_note",
        kind: "text",
        content: "nope",
      });
      expect(refused.status).toBe(403);

      // And with no bearer at all the route is a 401, not a leak.
      const anonymous = await rawRequest("GET", `/api/artifacts/${artifactId}`, null);
      expect(anonymous.status).toBe(401);
    });
  });

  describe("deliveries", () => {
    let failedDeliveryId = "";
    let pendingDeliveryId = "";
    let pendingRunId = "";

    it(
      "a manual delivery attempts an allowlisted dead target and can be retried to failed",
      { timeout: 60_000 },
      async () => {
        // `mode: "none"` (the only modes are webhook|none) so completion does NOT
        // auto-deliver; the manual deliver below is the attempt under test. 127.0.0.1 is
        // allowlisted, port 9 is dead: the attempt is made and refused.
        const run = await atlasStartWorkflowRun(adminToken, {
          workflowDefinitionId: seeded!.workflowId,
          input: {
            _meta: { reply: { mode: "none", callback_url: "http://127.0.0.1:9/contract-hook" } },
          },
        });
        await waitForRunState(run.id, ["failed", "succeeded"]);

        let delivery = await atlasDeliverRun(adminToken, run.id);
        expect(delivery.run_id).toBe(run.id);
        expect(delivery.attempts).toBeGreaterThanOrEqual(1);

        // One bounded manual attempt per retry; walking attempts to max_attempts lands the
        // row in `failed`, Atlas's terminal give-up state.
        for (let index = 0; index < 8 && delivery.status !== "failed"; index += 1) {
          delivery = await atlasRetryDelivery(adminToken, delivery.id);
        }
        expect(delivery.status).toBe("failed");
        failedDeliveryId = delivery.id;

        // Retrying a failed delivery is permitted — 202 with one more bounded attempt.
        const retried = await atlasRetryDelivery(adminToken, delivery.id);
        expect(["failed", "pending"]).toContain(retried.status);
      },
    );

    /**
     * Why no `blocked` delivery is manufactured here: Atlas validates `callback_url` against
     * the outbound allowlist at run *start* and fails closed (`validate_run_input_envelope`,
     * `atlas/workflows.py:94-131`), so with a fixed allowlist no run that could produce a
     * blocked delivery can be created. A row only becomes `blocked` when the allowlist
     * changes between run creation and delivery — a restart-level operation this harness
     * cannot perform mid-suite. The fail-closed rejection below IS that contract.
     */
    it("rejects a non-allowlisted callback_url at run start (fail closed)", async () => {
      const rejection = await expectAtlasError(
        atlasStartWorkflowRun(adminToken, {
          workflowDefinitionId: seeded!.workflowId,
          input: {
            _meta: { reply: { mode: "none", callback_url: "http://127.0.0.9:9/contract-hook" } },
          },
        }),
        "validation",
      );
      expect(rejection.message).toContain("not deliverable");
    });

    it("filters run_id and status server-side", { timeout: 60_000 }, async () => {
      // A second delivery left mid-lifecycle: one attempt, four remaining → `pending`.
      const run = await atlasStartWorkflowRun(adminToken, {
        workflowDefinitionId: seeded!.workflowId,
        input: {
          _meta: { reply: { mode: "none", callback_url: "http://127.0.0.1:9/contract-hook" } },
        },
      });
      await waitForRunState(run.id, ["failed", "succeeded"]);
      const pending = await atlasDeliverRun(adminToken, run.id);
      expect(pending.status).toBe("pending");
      pendingDeliveryId = pending.id;
      pendingRunId = run.id;

      const failed = await atlasListDeliveries(adminToken, { status: "failed" });
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed.every((row) => row.status === "failed")).toBe(true);
      expect(failed.map((row) => row.id)).toContain(failedDeliveryId);
      expect(failed.map((row) => row.id)).not.toContain(pendingDeliveryId);

      const pendingRows = await atlasListDeliveries(adminToken, { status: "pending" });
      expect(pendingRows.map((row) => row.id)).toContain(pendingDeliveryId);

      const byRun = await atlasListDeliveries(adminToken, { runId: pendingRunId });
      expect(byRun).toHaveLength(1);
      expect(byRun[0]!.id).toBe(pendingDeliveryId);
    });

    it("role matrix: auditor reads but cannot retry; viewer cannot even read", async () => {
      const auditorList = await atlasListDeliveries(auditorToken);
      expect(auditorList.length).toBeGreaterThanOrEqual(2);
      await expectAtlasError(atlasRetryDelivery(auditorToken, failedDeliveryId), "forbidden");

      await expectAtlasError(atlasListDeliveries(viewerToken), "forbidden");

      // Operator may do both: list, and one more bounded attempt on the pending row.
      await atlasListDeliveries(operatorToken);
      const retried = await atlasRetryDelivery(operatorToken, pendingDeliveryId);
      expect(["pending", "failed"]).toContain(retried.status);
    });
  });

  describe("audit", () => {
    it("returns newest-first entries bounded by limit", async () => {
      const entries = await atlasListAudit(adminToken, { limit: 5 });
      expect(entries.length).toBeLessThanOrEqual(5);
      expect(entries.length).toBeGreaterThan(0);
      const ids = entries.map((entry) => entry.id);
      expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    });

    it("applies inclusive date bounds server-side", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const todays = await atlasListAudit(adminToken, { from: today, to: today, limit: 50 });
      expect(todays.length).toBeGreaterThan(0);

      const ancient = await atlasListAudit(adminToken, {
        from: "1990-01-01",
        to: "1990-01-02",
        limit: 50,
      });
      expect(ancient).toHaveLength(0);
    });

    it("rejects an inverted range as a 400", async () => {
      await expectAtlasError(
        atlasListAudit(adminToken, { from: "2026-07-21", to: "2026-07-01" }),
        "validation",
      );
    });

    it("exports CSV with the documented header", async () => {
      const csv = await atlasExportAuditCsv(adminToken, { limit: 10 });
      expect(csv.split("\n")[0]).toBe(
        "id,created_at,actor,action,resource_type,resource_id,details",
      );
      expect(csv.split("\n").length).toBeGreaterThan(1);
    });

    it("role matrix: auditor reads, operator and viewer are forbidden", async () => {
      const entries = await atlasListAudit(auditorToken, { limit: 5 });
      expect(entries.length).toBeGreaterThan(0);
      await expectAtlasError(atlasListAudit(operatorToken), "forbidden");
      await expectAtlasError(atlasListAudit(viewerToken), "forbidden");
      await expectAtlasError(atlasExportUsageCsv(operatorToken), "forbidden");
    });
  });

  describe("usage", () => {
    it("returns events plus Atlas-computed totals for the range", async () => {
      // The failed seeded run and delivery runs have emitted workflow_run usage events by now.
      const usage = await atlasGetUsage(adminToken);
      expect(usage.usage.length).toBeGreaterThan(0);
      expect(usage.totals.workflow_runs).toBeGreaterThan(0);
      for (const key of [
        "workflow_runs",
        "successful_workflow_runs",
        "jobs",
        "budget_units",
        "wall_seconds",
        "job_wall_seconds",
        "tokens_prompt",
        "tokens_output",
        "estimated_cost_usd",
      ]) {
        expect(typeof usage.totals[key as keyof typeof usage.totals]).toBe("number");
      }
    });

    it("applies the date range server-side and echoes it back", async () => {
      const empty = await atlasGetUsage(adminToken, { from: "1990-01-01", to: "1990-01-02" });
      expect(empty.usage).toHaveLength(0);
      expect(empty.totals.workflow_runs).toBe(0);
      expect(empty.from).toBe("1990-01-01T00:00:00Z");

      await expectAtlasError(
        atlasGetUsage(adminToken, { from: "2026-07-21", to: "2026-07-01" }),
        "validation",
      );
    });

    it("exports CSV with one row per raw event", async () => {
      const csv = await atlasExportUsageCsv(adminToken);
      const [header, ...rows] = csv.trim().split("\n");
      expect(header).toBe(
        "id,idempotency_key,kind,status,units,seconds,run_id,job_id,node_key,worker_id,actor,started_at,finished_at,model,tokens_prompt,tokens_output,created_at,metadata",
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it("role matrix: auditor reads, operator and viewer are forbidden", async () => {
      const usage = await atlasGetUsage(auditorToken);
      expect(usage.usage.length).toBeGreaterThan(0);
      await expectAtlasError(atlasGetUsage(operatorToken), "forbidden");
      await expectAtlasError(atlasGetUsage(viewerToken), "forbidden");
    });
  });

  describe("users", () => {
    it("admin lists users with live token counts", async () => {
      const users = await atlasListUsers(adminToken);
      const usernames = users.map((user) => user.username);
      for (const expected of ["admin", "viewer", "operator", "auditor"]) {
        expect(usernames).toContain(expected);
      }
      const admin = users.find((user) => user.username === "admin")!;
      // At least this suite's login token is live.
      expect(admin.token_count).toBeGreaterThanOrEqual(1);
    });

    it("creates, partially updates, disables, and deletes a user", async () => {
      const created = await atlasCreateUser(adminToken, {
        username: "contract-temp",
        password: "contract-temp-password",
        role: "viewer",
        status: "active",
      });
      expect(created.role).toBe("viewer");

      // Duplicate username is a 400, not a 409 — Atlas maps IntegrityError to ValueError.
      const duplicate = await expectAtlasError(
        atlasCreateUser(adminToken, {
          username: "contract-temp",
          password: "x",
          role: "viewer",
          status: "active",
        }),
        "validation",
      );
      expect(duplicate.message).toContain("already exists");

      await expectAtlasError(
        atlasCreateUser(adminToken, {
          username: "bad-role",
          password: "x",
          role: "superuser",
          status: "active",
        }),
        "validation",
      );

      // Partial PUT: role alone, then status alone; the untouched fields survive.
      const promoted = await atlasUpdateUser(adminToken, created.id, { role: "operator" });
      expect(promoted.role).toBe("operator");
      expect(promoted.status).toBe("active");

      const tempToken = (
        await atlasLogin({ username: "contract-temp", password: "contract-temp-password" })
      ).token;
      const me = await rawRequest("GET", "/api/me", tempToken);
      expect(me.status).toBe(200);

      const disabled = await atlasUpdateUser(adminToken, created.id, { status: "disabled" });
      expect(disabled.status).toBe("disabled");

      // A disabled user can neither sign in nor keep using an existing token.
      await expectAtlasError(
        atlasLogin({ username: "contract-temp", password: "contract-temp-password" }),
        "unauthorized",
      );
      const meDisabled = await rawRequest("GET", "/api/me", tempToken);
      expect(meDisabled.status).toBe(401);

      await atlasDeleteUser(adminToken, created.id);
      const gone = await rawRequest("GET", `/api/users/${created.id}`, adminToken);
      expect(gone.status).toBe(404);
    });

    it("role matrix: every non-admin role is forbidden, even for reads", async () => {
      await expectAtlasError(atlasListUsers(operatorToken), "forbidden");
      await expectAtlasError(atlasListUsers(auditorToken), "forbidden");
      await expectAtlasError(atlasListUsers(viewerToken), "forbidden");
      await expectAtlasError(
        atlasCreateUser(operatorToken, {
          username: "op-cannot",
          password: "x",
          role: "viewer",
          status: "active",
        }),
        "forbidden",
      );
    });
  });

  describe("api tokens", () => {
    it("returns the raw token exactly once, and metadata never carries it again", async () => {
      const users = await atlasListUsers(adminToken);
      const viewer = users.find((user) => user.username === "viewer")!;

      const created = await atlasCreateApiToken(adminToken, {
        userId: viewer.id,
        name: "contract token",
      });
      expect(created.api_token.length).toBeGreaterThan(10);
      expect("token_hash" in created.token).toBe(false);

      // The raw value is a real bearer.
      const me = await rawRequest("GET", "/api/me", created.api_token);
      expect(me.status).toBe(200);
      expect(((await me.json()) as { user: { username: string } }).user.username).toBe("viewer");

      // Neither the list nor the by-id route can ever reproduce it.
      const listResponse = await rawRequest("GET", "/api/tokens", adminToken);
      const listBody = await listResponse.text();
      expect(listBody).not.toContain(created.api_token);
      expect(listBody).not.toContain("token_hash");

      const getResponse = await rawRequest("GET", `/api/tokens/${created.token.id}`, adminToken);
      const getBody = await getResponse.text();
      expect(getResponse.status).toBe(200);
      expect(getBody).not.toContain(created.api_token);

      // Rename touches metadata only.
      const renamed = await atlasRenameApiToken(adminToken, created.token.id, "contract renamed");
      expect(renamed.name).toBe("contract renamed");

      // Revocation (the DELETE route) kills the bearer immediately and keeps the row.
      await atlasRevokeApiToken(adminToken, created.token.id);
      const meAfter = await rawRequest("GET", "/api/me", created.api_token);
      expect(meAfter.status).toBe(401);
      const listed = await atlasListApiTokens(adminToken, { userId: viewer.id });
      const row = listed.find((token) => token.id === created.token.id)!;
      expect(row.revoked_at).toBeTruthy();
    });

    it("role matrix: token management is admin-only", async () => {
      await expectAtlasError(atlasListApiTokens(operatorToken), "forbidden");
      await expectAtlasError(atlasListApiTokens(auditorToken), "forbidden");
      await expectAtlasError(atlasListApiTokens(viewerToken), "forbidden");
    });

    it("404s for an unknown token id", async () => {
      await expectAtlasError(atlasRevokeApiToken(adminToken, "tok_does_not_exist"), "not_found");
    });
  });

  describe("unauthenticated requests", () => {
    it("answer 401 on every Phase 5 route", async () => {
      for (const path of [
        "/api/conversations",
        "/api/deliveries",
        "/api/audit",
        "/api/usage",
        "/api/users",
        "/api/tokens",
      ]) {
        const response = await rawRequest("GET", path, null);
        expect(response.status, path).toBe(401);
      }
    });
  });
});
