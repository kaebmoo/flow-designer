/**
 * Unit tests for the Phase 5 operational-page view models and the date-range validator.
 *
 * Focused on decisions a live Atlas cannot be made to demonstrate on demand: missing optional
 * fields, unknown roles, and — most importantly — the structural guarantee that a raw API
 * token can never ride along inside token metadata.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_USAGE_WINDOW_DAYS, defaultUsageFrom, parseDateBoundary } from "@/lib/atlas-dates";
import {
  ARTIFACT_PREVIEW_MAX_CHARS,
  toApiTokenView,
  toArtifactListingView,
  toArtifactPreviewView,
  toAuditEntryView,
  toConversationView,
  toUsageView,
  toUserAdminView,
} from "@/lib/atlas-mappers";
import type {
  AtlasApiToken,
  AtlasArtifact,
  AtlasArtifactListing,
  AtlasArtifactListRow,
  AtlasAuditEntry,
  AtlasConversation,
  AtlasUsageResponse,
  AtlasUserListRow,
} from "@/lib/atlas-types";

const inlineArtifact: AtlasArtifact = {
  id: "art_inline",
  run_id: null,
  job_id: "job_1",
  key: "analysis",
  kind: "text",
  content: "inline content must not enter a list cache",
  metadata: {},
  created_at: "2026-07-21T08:00:00Z",
  updated_at: "2026-07-21T08:00:00Z",
};
const inlineArtifactListRow: AtlasArtifactListRow = {
  id: inlineArtifact.id,
  run_id: inlineArtifact.run_id,
  job_id: inlineArtifact.job_id,
  key: inlineArtifact.key,
  kind: inlineArtifact.kind,
  metadata: inlineArtifact.metadata,
  created_at: inlineArtifact.created_at,
  updated_at: inlineArtifact.updated_at,
};

describe("artifact views", () => {
  it("maps a global listing to metadata only, dropping every inline content value", () => {
    const listing: AtlasArtifactListing = {
      artifacts: [inlineArtifactListRow],
      total: 1,
      limit: 25,
    };

    const view = toArtifactListingView(listing);
    expect(view.artifacts[0]).toEqual({
      id: "art_inline",
      key: "analysis",
      kind: "text",
      downloadable: false,
      filename: null,
      mediaType: null,
      sizeBytes: null,
      runId: null,
      jobId: "job_1",
      createdAt: "2026-07-21 08:00:00 UTC",
    });
    expect(JSON.stringify(view)).not.toContain("inline content must not enter a list cache");
    expect(view.artifacts[0]).not.toHaveProperty("preview");
  });

  it("bounds the on-demand by-id preview before it can enter the browser cache", () => {
    const content = "x".repeat(ARTIFACT_PREVIEW_MAX_CHARS + 17);
    const view = toArtifactPreviewView({ ...inlineArtifact, content });

    expect(view.preview).toHaveLength(ARTIFACT_PREVIEW_MAX_CHARS);
    expect(view.truncated).toBe(true);
    expect(view).not.toHaveProperty("originalCharacters");
  });

  it("does not split a surrogate pair at the preview boundary", () => {
    const content = `${"a".repeat(ARTIFACT_PREVIEW_MAX_CHARS - 1)}😀`;
    const view = toArtifactPreviewView({ ...inlineArtifact, content });

    expect(view.preview).toBe("a".repeat(ARTIFACT_PREVIEW_MAX_CHARS - 1));
    expect(view.truncated).toBe(true);
  });

  it("keeps a complete combining sequence when it fits within the preview boundary", () => {
    const finalCluster = "e\u0301";
    const content = `${"a".repeat(ARTIFACT_PREVIEW_MAX_CHARS - 2)}${finalCluster}b`;
    const view = toArtifactPreviewView({ ...inlineArtifact, content });

    expect(view.preview).toBe(`${"a".repeat(ARTIFACT_PREVIEW_MAX_CHARS - 2)}${finalCluster}`);
    expect(view.preview).toHaveLength(ARTIFACT_PREVIEW_MAX_CHARS);
    expect(view.truncated).toBe(true);
  });

  it("does not split a combining sequence that crosses the preview boundary", () => {
    const finalCluster = "e\u0301";
    const content = `${"a".repeat(ARTIFACT_PREVIEW_MAX_CHARS - 1)}${finalCluster}b`;
    const view = toArtifactPreviewView({ ...inlineArtifact, content });

    expect(view.preview).toBe("a".repeat(ARTIFACT_PREVIEW_MAX_CHARS - 1));
    expect(view.truncated).toBe(true);
  });

  it("bounds a pathological single grapheme cluster by code units", () => {
    const content = `x${"\u0301".repeat(100_000)}`;
    const view = toArtifactPreviewView({ ...inlineArtifact, content });

    expect(content).toHaveLength(100_001);
    expect(view.preview).toHaveLength(ARTIFACT_PREVIEW_MAX_CHARS);
    expect(view.truncated).toBe(true);
  });

  it("uses a collected file relpath basename before falling back to the artifact key", () => {
    const fileArtifact: AtlasArtifactListRow = {
      ...inlineArtifactListRow,
      id: "art_file",
      key: "files.output.reports.final.txt",
      kind: "file_ref",
      metadata: { relpath: "reports/final.txt", size: 12 },
    };
    const fallbackArtifact: AtlasArtifactListRow = {
      ...fileArtifact,
      id: "art_file_key",
      key: "fallback-key",
      metadata: {},
    };

    expect(
      toArtifactListingView({ artifacts: [fileArtifact], total: 1, limit: 25 }).artifacts[0],
    ).toMatchObject({ filename: "final.txt" });
    expect(
      toArtifactListingView({ artifacts: [fallbackArtifact], total: 1, limit: 25 }).artifacts[0],
    ).toMatchObject({ filename: "fallback-key" });
  });
});

const conversation: AtlasConversation = {
  id: "cnv_1",
  title: "Weekly report",
  preferred_worker_id: "wrk_1",
  preferred_workspace_id: null,
  workspace_key: "reports",
  company: "Acme",
  metadata: {},
  created_at: "2026-07-21T08:00:00Z",
  updated_at: "2026-07-21T09:30:00Z",
};

describe("toConversationView", () => {
  it("maps every field and formats timestamps", () => {
    const view = toConversationView(conversation);
    expect(view.id).toBe("cnv_1");
    expect(view.title).toBe("Weekly report");
    expect(view.workspaceKey).toBe("reports");
    expect(view.company).toBe("Acme");
    expect(view.preferredWorkerId).toBe("wrk_1");
    expect(view.preferredWorkspaceId).toBeNull();
    expect(view.updatedAt).toBe("2026-07-21 09:30:00 UTC");
  });

  it("labels an empty title Untitled rather than rendering a blank row", () => {
    expect(toConversationView({ ...conversation, title: "" }).title).toBe("Untitled");
  });
});

const userRow: AtlasUserListRow = {
  id: "usr_1",
  username: "ops-lead",
  role: "operator",
  status: "active",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-20T00:00:00Z",
  token_count: 3,
};

describe("toUserAdminView", () => {
  it("maps a known role to its label and keeps the raw value for the form", () => {
    const view = toUserAdminView(userRow);
    expect(view.role).toBe("operator");
    expect(view.roleLabel).toBe("Operator");
    expect(view.tokenCount).toBe(3);
    expect(view.disabled).toBe(false);
  });

  it("renders an unknown future role as itself instead of crashing the lookup", () => {
    const view = toUserAdminView({ ...userRow, role: "superuser" });
    expect(view.role).toBe("superuser");
    expect(view.roleLabel).toBe("superuser");
  });

  it("marks a disabled user", () => {
    const view = toUserAdminView({ ...userRow, status: "disabled" });
    expect(view.disabled).toBe(true);
    expect(view.status.label).toBe("disabled");
  });

  it("defaults a missing token_count to zero", () => {
    const view = toUserAdminView({ ...userRow, token_count: undefined as unknown as number });
    expect(view.tokenCount).toBe(0);
  });
});

const tokenRow: AtlasApiToken = {
  id: "tok_1",
  user_id: "usr_1",
  name: "CI pipeline",
  last_used_at: "2026-07-21T07:00:00Z",
  created_at: "2026-07-01T00:00:00Z",
  revoked_at: null,
  username: "ops-lead",
  purpose: "api",
  expires_at: null,
};

describe("toApiTokenView", () => {
  it("maps metadata and derives revoked from revoked_at", () => {
    const live = toApiTokenView(tokenRow);
    expect(live.revoked).toBe(false);
    expect(live.lifecycle).toBe("active");
    const revoked = toApiTokenView({ ...tokenRow, revoked_at: "2026-07-21T08:00:00Z" });
    expect(revoked.revoked).toBe(true);
    expect(revoked.revokedAt).toBe("2026-07-21 08:00:00 UTC");
    expect(revoked.lifecycle).toBe("revoked");
  });

  it("derives expiry without inferring session purpose from the display name", () => {
    const expired = toApiTokenView({
      ...tokenRow,
      name: "dashboard session",
      purpose: "api",
      expires_at: "2020-01-01T00:00:00Z",
    });
    expect(expired.lifecycle).toBe("expired");
    expect(expired.purpose).toBe("api");
  });

  it("labels an unnamed token", () => {
    expect(toApiTokenView({ ...tokenRow, name: "" }).name).toBe("(unnamed)");
  });

  /**
   * The structural guarantee behind "the raw token never enters a cache": the view type has
   * no field that could carry it, so even a mapper bug cannot smuggle it into the token list.
   * If Atlas's create response were fed through this mapper, `api_token` is dropped.
   */
  it("never carries a token value, even when one is present on the input", () => {
    const smuggled = { ...tokenRow, api_token: "at_raw_secret", token_hash: "deadbeef" };
    const view = toApiTokenView(smuggled as AtlasApiToken);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("at_raw_secret");
    expect(serialized).not.toContain("deadbeef");
    expect(Object.keys(view).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "id",
      "lastUsedAt",
      "lifecycle",
      "name",
      "purpose",
      "revoked",
      "revokedAt",
      "userId",
      "username",
    ]);
  });
});

const auditEntry: AtlasAuditEntry = {
  id: 42,
  action: "user.create",
  actor: "admin",
  resource_type: "user",
  resource_id: "usr_9",
  details: { username: "new-user", role: "viewer" },
  created_at: "2026-07-21T10:00:00Z",
};

describe("toAuditEntryView", () => {
  it("maps the row and stringifies details", () => {
    const view = toAuditEntryView(auditEntry);
    expect(view.id).toBe("42");
    expect(view.action).toBe("user.create");
    expect(view.detail).toContain("new-user");
    expect(view.createdAt).toBe("2026-07-21 10:00:00 UTC");
  });

  it("renders empty details as null rather than an empty JSON object", () => {
    expect(toAuditEntryView({ ...auditEntry, details: {} }).detail).toBeNull();
  });

  it("survives details that are not an object", () => {
    const view = toAuditEntryView({
      ...auditEntry,
      details: null as unknown as Record<string, unknown>,
    });
    expect(view.detail).toBeNull();
  });
});

const usageResponse: AtlasUsageResponse = {
  usage: [
    {
      id: "usg_1",
      idempotency_key: "job:job_1",
      run_id: null,
      job_id: "job_1",
      node_key: null,
      worker_id: "wrk_1",
      actor: "admin",
      kind: "job",
      status: "succeeded",
      units: 1,
      seconds: 2.5,
      started_at: "2026-07-21T09:00:00Z",
      finished_at: "2026-07-21T09:00:02Z",
      model: "small",
      tokens_prompt: 100,
      tokens_output: 40,
      created_at: "2026-07-21T09:00:03Z",
      metadata: { estimated_cost_usd: 0.0012 },
    },
    {
      id: "usg_2",
      idempotency_key: "run:wfr_1",
      run_id: "wfr_1",
      job_id: null,
      node_key: null,
      worker_id: null,
      actor: "admin",
      kind: "workflow_run",
      status: "failed",
      units: 4,
      seconds: null,
      started_at: null,
      finished_at: null,
      model: null,
      tokens_prompt: null,
      tokens_output: null,
      created_at: "2026-07-21T09:05:00Z",
      metadata: {},
    },
  ],
  totals: {
    workflow_runs: 1,
    successful_workflow_runs: 0,
    jobs: 1,
    budget_units: 4,
    wall_seconds: 0,
    job_wall_seconds: 2.5,
    tokens_prompt: 100,
    tokens_output: 40,
    estimated_cost_usd: 0.0012,
  },
  from: "2026-07-21T00:00:00Z",
  to: null,
};

describe("toUsageView", () => {
  it("keeps Atlas's totals verbatim and reverses events to newest first", () => {
    const view = toUsageView(usageResponse);
    expect(view.totals.workflowRuns).toBe(1);
    expect(view.totals.estimatedCostUsd).toBe(0.0012);
    expect(view.eventCount).toBe(2);
    // Atlas orders ascending; the view is newest first.
    expect(view.events[0]!.id).toBe("usg_2");
    expect(view.events[1]!.id).toBe("usg_1");
  });

  it("reads the per-event cost estimate from metadata and tolerates its absence", () => {
    const view = toUsageView(usageResponse);
    expect(view.events[1]!.estimatedCostUsd).toBe(0.0012);
    expect(view.events[0]!.estimatedCostUsd).toBeNull();
  });

  it("tolerates missing numeric fields without inventing values", () => {
    const view = toUsageView(usageResponse);
    const runEvent = view.events[0]!;
    expect(runEvent.seconds).toBeNull();
    expect(runEvent.tokensPrompt).toBeNull();
    expect(runEvent.model).toBe("");
  });
});

describe("defaultUsageFrom", () => {
  /**
   * The usage page's default bound exists because `GET /api/usage` has no limit — an
   * unbounded default request would fetch the entire ledger. The value must be a bare ISO
   * date (what Atlas's `from` accepts and what a date input renders), and the **inclusive**
   * window it opens — Atlas expands the date to 00:00 and compares `>=`
   * (`atlas/usage.py:201-213`) — must span exactly the labelled number of calendar dates,
   * counting today. Subtracting the full 30 days was the off-by-one the gate review caught:
   * it covered 31 dates.
   */
  it("opens an inclusive window of exactly the labelled calendar dates, today included", () => {
    const now = new Date("2026-07-21T10:30:00Z");
    const from = defaultUsageFrom(now);
    expect(from).toBe("2026-06-22");
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Inclusive date count: from-date .. today, both ends counted.
    const inclusiveDates = (Date.parse("2026-07-21") - Date.parse(from)) / 86_400_000 + 1;
    expect(inclusiveDates).toBe(DEFAULT_USAGE_WINDOW_DAYS);
  });

  it("is a valid boundary by the same validator the RPC layer applies", () => {
    expect(parseDateBoundary(defaultUsageFrom(), "from")).toBe(defaultUsageFrom());
  });
});

describe("parseDateBoundary", () => {
  it("passes through an ISO date and a timestamp, trimmed", () => {
    expect(parseDateBoundary("2026-07-21", "from")).toBe("2026-07-21");
    expect(parseDateBoundary(" 2026-07-21T10:00:00Z ", "from")).toBe("2026-07-21T10:00:00Z");
  });

  it("treats absent and empty as no bound", () => {
    expect(parseDateBoundary(undefined, "from")).toBeUndefined();
    expect(parseDateBoundary(null, "from")).toBeUndefined();
    expect(parseDateBoundary("", "from")).toBeUndefined();
    expect(parseDateBoundary("   ", "from")).toBeUndefined();
  });

  it("rejects garbage, non-strings, and oversized input without echoing the value", () => {
    for (const bad of ["not-a-date", 12345, { from: "x" }, "9".repeat(41)]) {
      let message = "";
      try {
        parseDateBoundary(bad, "from");
        expect.unreachable("should have thrown");
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^from /);
      expect(message).not.toContain("not-a-date");
    }
  });
});
