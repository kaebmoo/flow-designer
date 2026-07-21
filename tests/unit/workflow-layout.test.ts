import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  autoLayout,
  clearLayout,
  migrateLayoutVersion,
  readLayout,
  readViewport,
  renameInLayout,
  resolveLayout,
  writeLayout,
  writeViewport,
} from "@/components/atlas/workflow-layout";
import {
  layoutStorageKey,
  mapAtlasValidationMessage,
  parseWorkflowGraph,
  type WorkflowGraph,
} from "@/lib/workflow-graph";
import { ALL_KINDS_GRAPH } from "../fixtures/workflow-graphs";

function graph(): WorkflowGraph {
  const parsed = parseWorkflowGraph(ALL_KINDS_GRAPH);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

/** A minimal in-memory `localStorage`, since the unit project runs in node. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  return store;
}

describe("layout storage", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    store = installStorage();
  });

  it("round-trips a layout under the workflow's own key", () => {
    writeLayout("wf_1", 2, { a: { x: 10, y: 20 } });
    expect(store.has(layoutStorageKey("wf_1", 2))).toBe(true);
    expect(readLayout("wf_1", 2)).toEqual({ a: { x: 10, y: 20 } });
  });

  it("stores the viewport alongside positions without either write clobbering the other", () => {
    writeLayout("wf_1", 2, { a: { x: 10, y: 20 } });
    writeViewport("wf_1", 2, { x: 30, y: 40, zoom: 1.5 });
    writeLayout("wf_1", 2, { a: { x: 50, y: 60 } });

    expect(readLayout("wf_1", 2)).toEqual({ a: { x: 50, y: 60 } });
    expect(readViewport("wf_1", 2)).toEqual({ x: 30, y: 40, zoom: 1.5 });
  });

  it("reads the former position-only layout shape so existing arrangements survive the upgrade", () => {
    store.set(layoutStorageKey("wf_1", 2), JSON.stringify({ a: { x: 10, y: 20 } }));
    expect(readLayout("wf_1", 2)).toEqual({ a: { x: 10, y: 20 } });
    expect(readViewport("wf_1", 2)).toBeUndefined();
  });

  it("does not serve one workflow's layout to another, or one version's to the next", () => {
    writeLayout("wf_1", 1, { a: { x: 10, y: 20 } });
    expect(readLayout("wf_2", 1)).toEqual({});
    expect(readLayout("wf_1", 2)).toEqual({});
  });

  it("copies node positions and viewport when Atlas increments the workflow version", () => {
    writeLayout("wf_1", 1, { a: { x: 10, y: 20 } });
    writeViewport("wf_1", 1, { x: 30, y: 40, zoom: 1.5 });
    migrateLayoutVersion("wf_1", 1, 2);
    expect(readLayout("wf_1", 2)).toEqual({ a: { x: 10, y: 20 } });
    expect(readViewport("wf_1", 2)).toEqual({ x: 30, y: 40, zoom: 1.5 });
  });

  it("ignores stored junk rather than crashing the editor", () => {
    store.set(layoutStorageKey("wf_1", 1), "not json");
    expect(readLayout("wf_1", 1)).toEqual({});

    store.set(layoutStorageKey("wf_1", 1), JSON.stringify({ a: "nope", b: { x: 1, y: 2 } }));
    expect(readLayout("wf_1", 1)).toEqual({ b: { x: 1, y: 2 } });
  });

  it("survives storage that throws, which is what a blocked browser does", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(readLayout("wf_1", 1)).toEqual({});
    expect(() => writeLayout("wf_1", 1, { a: { x: 0, y: 0 } })).not.toThrow();
    expect(() => clearLayout("wf_1", 1)).not.toThrow();
  });

  it("does nothing at all when there is no window, so server rendering is safe", () => {
    vi.unstubAllGlobals();
    expect(readLayout("wf_1", 1)).toEqual({});
    expect(() => writeLayout("wf_1", 1, { a: { x: 0, y: 0 } })).not.toThrow();
  });
});

describe("auto-layout", () => {
  it("places every node exactly once", () => {
    const placed = autoLayout(graph());
    expect(Object.keys(placed).sort()).toEqual(
      graph()
        .nodes.map((n) => n.id)
        .sort(),
    );
  });

  it("puts the start node in the leftmost column and downstream nodes to its right", () => {
    const g = graph();
    const placed = autoLayout(g);
    expect(placed[g.start]!.x).toBe(0);
    expect(placed.triage!.x).toBeGreaterThan(placed.ingest!.x);
    expect(placed.publish!.x).toBeGreaterThan(placed.review!.x);
  });

  it("terminates on a graph that is nothing but a cycle", () => {
    const cyclic: WorkflowGraph = {
      start: "a",
      nodes: [
        { id: "a", type: "worker" },
        { id: "b", type: "worker" },
      ],
      edges: [
        { from: "a", to: "b", condition: { type: "always" } },
        { from: "b", to: "a", condition: { type: "always" } },
      ],
    };
    expect(Object.keys(autoLayout(cyclic)).sort()).toEqual(["a", "b"]);
  });

  it("places an unreachable node somewhere visible rather than on top of the start", () => {
    const orphaned: WorkflowGraph = {
      start: "a",
      nodes: [
        { id: "a", type: "worker" },
        { id: "orphan", type: "worker" },
      ],
      edges: [],
    };
    const placed = autoLayout(orphaned);
    expect(placed.orphan!.x).toBeGreaterThan(placed.a!.x);
  });
});

describe("resolveLayout", () => {
  it("keeps stored positions and auto-places only what is missing", () => {
    const g = graph();
    const stored = { ingest: { x: 999, y: 999 } };
    const resolved = resolveLayout(g, stored);
    expect(resolved.ingest).toEqual({ x: 999, y: 999 });
    expect(Object.keys(resolved).sort()).toEqual(g.nodes.map((n) => n.id).sort());
  });

  it("drops positions for nodes that no longer exist", () => {
    const g = graph();
    const resolved = resolveLayout(g, { ghost: { x: 1, y: 1 } });
    expect(resolved.ghost).toBeUndefined();
  });
});

describe("renameInLayout", () => {
  it("moves the position with the node, so a rename does not undo the arrangement", () => {
    expect(renameInLayout({ a: { x: 5, y: 6 } }, "a", "b")).toEqual({ b: { x: 5, y: 6 } });
  });

  it("leaves the layout alone when the node was never placed", () => {
    const layout = { a: { x: 5, y: 6 } };
    expect(renameInLayout(layout, "z", "b")).toBe(layout);
  });
});

describe("mapping an Atlas validation message back to a target", () => {
  it.each([
    [
      "workflow node fast_path uses unsupported type: widget",
      { kind: "node", nodeId: "fast_path" },
    ],
    [
      "workflow manager node triage schema must be manager_decision_v1",
      { kind: "node", nodeId: "triage" },
    ],
    [
      "workflow join node converge quorum exceeds distinct incoming upstream count",
      { kind: "node", nodeId: "converge" },
    ],
    [
      "workflow human_gate node review choice ids must be unique",
      { kind: "node", nodeId: "review" },
    ],
    [
      "workflow edge at index 3 uses unsupported condition: expression",
      { kind: "edge", edgeIndex: 3 },
    ],
    [
      "workflow manager edge at index 1 requires manager_selected condition",
      { kind: "edge", edgeIndex: 1 },
    ],
    [
      "workflow human_gate edge at index 7 requires human_selected condition",
      { kind: "edge", edgeIndex: 7 },
    ],
    [
      "workflow policy max_jobs must be an integer between 1 and 100",
      { kind: "policy", field: "max_jobs" },
    ],
    [
      "policy allowed_worker_ids references unknown worker: wk_1",
      { kind: "policy", field: "allowed_worker_ids" },
    ],
    ["workflow graph start references missing node: nowhere", { kind: "graph", field: "start" }],
    [
      "workflow graph has a cycle; policy.max_iterations or max_iterations_below is required",
      { kind: "graph", field: "edges" },
    ],
    ["duplicate node id: ingest", { kind: "node", nodeId: "ingest" }],
    // The index form has no id to anchor to. Attaching it to a node called "at" would render a
    // problem against a node that does not exist and whose click target selects nothing.
    ["workflow node at index 0 requires a non-empty id", { kind: "graph" }],
    ["workflow node at index 2 must be an object", { kind: "graph" }],
  ])("anchors %s", (message, target) => {
    expect(mapAtlasValidationMessage(message).target).toEqual(target);
  });

  it("keeps an unrecognised message at graph level rather than guessing a node", () => {
    const issue = mapAtlasValidationMessage("something Atlas has not said before");
    expect(issue.target).toEqual({ kind: "graph" });
    expect(issue.message).toBe("something Atlas has not said before");
  });

  it("preserves Atlas's wording, because it is the only detail the user gets", () => {
    const message = "workflow node ingest budget_units must be a positive integer";
    expect(mapAtlasValidationMessage(message).message).toBe(message);
  });
});
