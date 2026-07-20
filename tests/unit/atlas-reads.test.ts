/**
 * Unit tests for the typed read operations and the query-key/search layer.
 *
 * The contract tests prove these operations work against a real Atlas. These prove the parts a
 * healthy Atlas will not produce on demand: a proxy error page instead of JSON, a truncated
 * envelope, a bearer that must never reach a URL, and the clamping the browser and the server
 * have to agree on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AtlasError,
  atlasGetJob,
  atlasGetMetrics,
  atlasGetWorkflow,
  atlasGetWorkflowRun,
  atlasListJobs,
  atlasListWorkers,
  atlasListWorkflowRuns,
  atlasListWorkflows,
  atlasListWorkspaces,
} from "@/lib/atlas-api.server";
import { ATLAS_DEFAULT_LIMIT, clampAtlasLimit } from "@/lib/atlas-limits";
import { ATLAS_LIMIT_OPTIONS, parseLimitSearch, parseStringSearch } from "@/lib/atlas-search";
import { queryKeys } from "@/lib/query-keys";
import { resetServerEnvCache } from "@/lib/env.server";

const ATLAS_ORIGIN = "http://127.0.0.1:8787";
const TOKEN = "secret-bearer-value";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A `Response` body can only be read once, so each call gets a fresh one — otherwise a test
 * that makes two requests fails as a bogus "protocol error" on the second.
 */
function stubFetch(body: unknown, status = 200) {
  // The parameters are declared so the recorded calls stay typed as (input, init).
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(jsonResponse(body, status)),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.ATLAS_API_ORIGIN = ATLAS_ORIGIN;
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "s".repeat(32);
  process.env.NODE_ENV = "test";
  resetServerEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetServerEnvCache();
});

describe("request construction", () => {
  it("issues a GET with the bearer in the header and nothing in the URL", async () => {
    const fetchMock = stubFetch({ workers: [] });

    await atlasListWorkers(TOKEN);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ATLAS_ORIGIN}/api/workers`);
    expect(String(url)).not.toContain(TOKEN);
    expect(init?.method).toBe("GET");
    // The client always passes a plain header record, so indexing it is safe here.
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  /** Atlas accepts `?token=` on `/events` paths; flow-designer must never use that path. */
  it.each([
    ["workers", () => atlasListWorkers(TOKEN), { workers: [] }],
    ["workspaces", () => atlasListWorkspaces(TOKEN), { workspaces: [] }],
    ["metrics", () => atlasGetMetrics(TOKEN), { metrics: { version: "0.1.0" } }],
    ["workflows", () => atlasListWorkflows(TOKEN, { limit: 10 }), { workflows: [] }],
    ["runs", () => atlasListWorkflowRuns(TOKEN, { limit: 10 }), { runs: [] }],
    ["jobs", () => atlasListJobs(TOKEN, { limit: 10 }), { jobs: [] }],
  ])("never puts the bearer in the URL for %s", async (_name, call, body) => {
    const fetchMock = stubFetch(body);
    await call();
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("token=");
  });

  it("sends only the parameters Atlas accepts on the runs route", async () => {
    const fetchMock = stubFetch({ runs: [] });

    await atlasListWorkflowRuns(TOKEN, { limit: 25, workflowDefinitionId: "wfd_1" });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/workflow-runs");
    expect([...url.searchParams.keys()].sort()).toEqual(["limit", "workflow_definition_id"]);
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("workflow_definition_id")).toBe("wfd_1");
  });

  it("omits an absent workflow filter rather than sending an empty value", async () => {
    const fetchMock = stubFetch({ runs: [] });

    await atlasListWorkflowRuns(TOKEN, { limit: 25 });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.has("workflow_definition_id")).toBe(false);
  });

  /** Atlas accepts no parameters at all on these two routes. */
  it.each([
    ["workers", () => atlasListWorkers(TOKEN), { workers: [] }],
    ["workspaces", () => atlasListWorkspaces(TOKEN), { workspaces: [] }],
  ])("sends no query string for %s", async (_name, call, body) => {
    const fetchMock = stubFetch(body);
    await call();
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("?");
  });

  it("percent-encodes an id so a crafted value cannot alter the path", async () => {
    const fetchMock = stubFetch({ workflow: { id: "x" } });

    await atlasGetWorkflow(TOKEN, "../../api/users");

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/workflows/..%2F..%2Fapi%2Fusers");
  });

  it("clamps a limit to Atlas's own range before sending it", async () => {
    const fetchMock = stubFetch({ workflows: [] });

    await atlasListWorkflows(TOKEN, { limit: 99_999 });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get("limit")).toBe("10000");

    await atlasListWorkflows(TOKEN, { limit: 0 });
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get("limit")).toBe("1");
  });
});

describe("response guards", () => {
  it("unwraps each list envelope under the key Atlas actually uses", async () => {
    stubFetch({ runs: [{ id: "wfr_1" }] });
    // The runs envelope key is `runs`, not `workflow_runs`.
    await expect(atlasListWorkflowRuns(TOKEN, { limit: 10 })).resolves.toEqual([{ id: "wfr_1" }]);
  });

  /**
   * A 200 that does not match the contract must be rejected here rather than flowing onward as
   * `undefined` and surfacing as a blank table three layers away.
   */
  it.each([
    ["a wrong envelope key", { workflow_runs: [{ id: "wfr_1" }] }],
    ["a non-array body", { runs: { id: "wfr_1" } }],
    ["a row without an id", { runs: [{ name: "no id" }] }],
    ["a null row", { runs: [null] }],
  ])("rejects %s as a protocol error", async (_case, body) => {
    stubFetch(body);
    const error = await atlasListWorkflowRuns(TOKEN, { limit: 10 }).catch((e) => e);
    expect(error).toBeInstanceOf(AtlasError);
    expect(error.kind).toBe("protocol");
  });

  it("requires all four sections of a run detail response", async () => {
    stubFetch({ run: { id: "wfr_1" }, nodes: [], edges: [] });
    const error = await atlasGetWorkflowRun(TOKEN, "wfr_1").catch((e) => e);
    expect(error.kind).toBe("protocol");
  });

  it("accepts a run detail response with every section present", async () => {
    stubFetch({ run: { id: "wfr_1" }, nodes: [], edges: [], approvals: [] });
    await expect(atlasGetWorkflowRun(TOKEN, "wfr_1")).resolves.toMatchObject({
      run: { id: "wfr_1" },
    });
  });

  it("rejects a metrics body that is not an object", async () => {
    stubFetch({ metrics: null });
    const error = await atlasGetMetrics(TOKEN).catch((e) => e);
    expect(error.kind).toBe("protocol");
  });

  /**
   * Atlas's stdlib handler answers an undefined method with a 501 HTML page, and a reverse
   * proxy can substitute an HTML error at any time. Neither may be parsed as the contract.
   */
  it("treats a non-JSON body as a protocol error rather than parsing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>502 Bad Gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const error = await atlasListWorkers(TOKEN).catch((e) => e);
    expect(error.kind).toBe("protocol");
  });
});

describe("error normalisation", () => {
  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [500, "server"],
  ])("maps a %i on a read to kind %s", async (status, kind) => {
    stubFetch({ error: "atlas said so" }, status);
    const error = await atlasGetJob(TOKEN, "job_1").catch((e) => e);
    expect(error).toBeInstanceOf(AtlasError);
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
  });

  it("preserves Atlas's own error text for diagnostics", async () => {
    stubFetch({ error: "not found" }, 404);
    const error = await atlasGetJob(TOKEN, "job_1").catch((e) => e);
    expect(error.message).toBe("not found");
    expect(error.fromAtlas).toBe(true);
  });

  it("falls back to its own copy when Atlas sends no usable message", async () => {
    stubFetch({}, 403);
    const error = await atlasGetJob(TOKEN, "job_1").catch((e) => e);
    expect(error.fromAtlas).toBe(false);
    expect(error.message).toMatch(/role/i);
  });

  it("never echoes the bearer in a failure message", async () => {
    stubFetch({ error: "unauthorized" }, 401);
    const error = await atlasListWorkers(TOKEN).catch((e) => e);
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("limit clamping", () => {
  it.each([
    [undefined, ATLAS_DEFAULT_LIMIT],
    [0, 1],
    [-5, 1],
    [25, 25],
    [10_001, 10_000],
    [25.7, 25],
    [Number.NaN, ATLAS_DEFAULT_LIMIT],
    [Number.POSITIVE_INFINITY, ATLAS_DEFAULT_LIMIT],
  ])("clamps %p to %p", (input, expected) => {
    expect(clampAtlasLimit(input)).toBe(expected);
  });

  /**
   * The browser parser and the server clamp must agree, or the UI would label a window Atlas
   * never applied.
   */
  it.each([
    ["absent", undefined, ATLAS_DEFAULT_LIMIT],
    ["empty", "", ATLAS_DEFAULT_LIMIT],
    ["a numeric string", "25", 25],
    ["garbage", "not-a-number", ATLAS_DEFAULT_LIMIT],
    ["out of range", "999999", 10_000],
    ["zero", "0", 1],
    ["an object", { nope: true }, ATLAS_DEFAULT_LIMIT],
  ])("parses %s in the URL to %p", (_case, input, expected) => {
    expect(parseLimitSearch(input)).toBe(expected);
  });

  it("offers only window sizes Atlas will honour unchanged", () => {
    for (const option of ATLAS_LIMIT_OPTIONS) {
      expect(clampAtlasLimit(option)).toBe(option);
    }
  });
});

describe("parseStringSearch", () => {
  it.each([
    ["wfd_1", "wfd_1"],
    ["", undefined],
    [undefined, undefined],
    [null, undefined],
    [42, undefined],
  ])("parses %p to %p", (input, expected) => {
    expect(parseStringSearch(input)).toBe(expected);
  });
});

describe("query keys", () => {
  it("namespaces every key under atlas so nothing collides with another cache", () => {
    const keys = [
      queryKeys.identity(),
      queryKeys.metrics(),
      queryKeys.workers(),
      queryKeys.workspaces(),
      queryKeys.workflowList({ limit: 25 }),
      queryKeys.workflowDetail("wfd_1"),
      queryKeys.runList({ limit: 25 }),
      queryKeys.runDetail("wfr_1"),
      queryKeys.jobList({ limit: 25 }),
      queryKeys.jobDetail("job_1"),
    ];
    for (const key of keys) {
      expect(key[0]).toBe("atlas");
    }
  });

  /**
   * A parameter outside the key would serve one window's rows for another window's request —
   * the classic stale-cache bug, and an invisible one because the data looks plausible.
   */
  it("separates windows and filters that produce different Atlas requests", () => {
    expect(queryKeys.workflowList({ limit: 25 })).not.toEqual(
      queryKeys.workflowList({ limit: 100 }),
    );
    expect(queryKeys.runList({ limit: 25 })).not.toEqual(
      queryKeys.runList({ limit: 25, workflowDefinitionId: "wfd_1" }),
    );
    expect(queryKeys.runList({ limit: 25, workflowDefinitionId: "wfd_1" })).not.toEqual(
      queryKeys.runList({ limit: 25, workflowDefinitionId: "wfd_2" }),
    );
    expect(queryKeys.jobDetail("job_1")).not.toEqual(queryKeys.jobDetail("job_2"));
  });

  it("is stable for the same parameters, so a re-render does not refetch", () => {
    expect(queryKeys.runList({ limit: 25, workflowDefinitionId: "wfd_1" })).toEqual(
      queryKeys.runList({ limit: 25, workflowDefinitionId: "wfd_1" }),
    );
  });

  /** Phase 3 mutations invalidate by prefix, so list and detail must share an entity prefix. */
  it("nests list and detail keys under a shared entity prefix", () => {
    expect(queryKeys.runList({ limit: 25 }).slice(0, 2)).toEqual(queryKeys.runs());
    expect(queryKeys.runDetail("wfr_1").slice(0, 2)).toEqual(queryKeys.runs());
    expect(queryKeys.workflowDetail("wfd_1").slice(0, 2)).toEqual(queryKeys.workflows());
    expect(queryKeys.jobList({ limit: 25 }).slice(0, 2)).toEqual(queryKeys.jobs());
  });
});
