/**
 * Where a node sits on the canvas — and why that never reaches Atlas.
 *
 * Atlas stores a semantic graph and has no layout endpoint at all
 * (`workflow-visual-builder-spec-en.md` §13). Its workflow schema is
 * `additionalProperties: false`, so a `position` on a node is not merely ignored — it is a
 * rejected payload. Positions therefore live in `localStorage`, and the parser in
 * `workflow-graph.ts` refuses any graph that carries one, which is what makes it impossible to
 * leak a layout into a save by accident.
 *
 * The consequence is real and worth stating in the UI rather than hiding: a layout is
 * per-browser. It does not follow the user to another device, and a second operator opening the
 * same workflow sees the auto-layout until they arrange it themselves.
 */

import { layoutStorageKey, type WorkflowGraph } from "@/lib/workflow-graph";

export interface NodePosition {
  x: number;
  y: number;
}

export type WorkflowLayout = Record<string, NodePosition>;

/** React Flow's viewport shape, kept local for the same reason as node positions. */
export interface WorkflowViewport {
  x: number;
  y: number;
  zoom: number;
}

interface StoredWorkflowLayout {
  layout_version: 1;
  nodes: WorkflowLayout;
  viewport?: WorkflowViewport;
}

/** Node box size, used by the auto-layout to space columns and rows without overlap. */
const NODE_WIDTH = 240;
const NODE_HEIGHT = 96;
const COLUMN_GAP = 120;
const ROW_GAP = 36;

function isPosition(value: unknown): value is NodePosition {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isFinite((value as NodePosition).x) &&
    Number.isFinite((value as NodePosition).y)
  );
}

function isViewport(value: unknown): value is WorkflowViewport {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isFinite((value as WorkflowViewport).x) &&
    Number.isFinite((value as WorkflowViewport).y) &&
    Number.isFinite((value as WorkflowViewport).zoom) &&
    (value as WorkflowViewport).zoom > 0
  );
}

function positionsFrom(value: unknown): WorkflowLayout {
  if (value === null || typeof value !== "object") return {};
  const layout: WorkflowLayout = {};
  for (const [id, position] of Object.entries(value as Record<string, unknown>)) {
    if (isPosition(position)) layout[id] = { x: position.x, y: position.y };
  }
  return layout;
}

/** Reads the current envelope and the pre-viewport position-only format from older browsers. */
function readStored(workflowId: string, graphVersion: number): StoredWorkflowLayout | undefined {
  if (typeof window === "undefined") return undefined;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(layoutStorageKey(workflowId, graphVersion));
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const envelope = parsed as Partial<StoredWorkflowLayout>;
    if (envelope.layout_version === 1 && envelope.nodes !== undefined) {
      return {
        layout_version: 1,
        nodes: positionsFrom(envelope.nodes),
        viewport: isViewport(envelope.viewport) ? envelope.viewport : undefined,
      };
    }
    // Phase 3 initially persisted only a bare node-position map. Preserve it when the new
    // viewport writer lands so arranging an existing workflow is not lost during the upgrade.
    return { layout_version: 1, nodes: positionsFrom(parsed) };
  } catch {
    return undefined;
  }
}

function writeStored(workflowId: string, graphVersion: number, stored: StoredWorkflowLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(layoutStorageKey(workflowId, graphVersion), JSON.stringify(stored));
  } catch {
    // A full or blocked quota must not take the editor down with it: the layout is a
    // convenience, and the graph — the thing that matters — is safe in Atlas either way.
  }
}

/**
 * Reads a stored layout, ignoring anything that is not a usable position.
 *
 * `localStorage` is shared with every other tab and survives upgrades, so its contents are
 * treated as untrusted input rather than as something this code wrote.
 */
export function readLayout(workflowId: string, graphVersion: number): WorkflowLayout {
  return readStored(workflowId, graphVersion)?.nodes ?? {};
}

/** Returns the last local pan/zoom, if the browser has one for this workflow version. */
export function readViewport(
  workflowId: string,
  graphVersion: number,
): WorkflowViewport | undefined {
  return readStored(workflowId, graphVersion)?.viewport;
}

export function writeLayout(
  workflowId: string,
  graphVersion: number,
  layout: WorkflowLayout,
): void {
  const previous = readStored(workflowId, graphVersion);
  writeStored(workflowId, graphVersion, {
    layout_version: 1,
    nodes: layout,
    viewport: previous?.viewport,
  });
}

/** Persists pan/zoom without clobbering the node arrangement. */
export function writeViewport(
  workflowId: string,
  graphVersion: number,
  viewport: WorkflowViewport,
): void {
  const previous = readStored(workflowId, graphVersion);
  writeStored(workflowId, graphVersion, {
    layout_version: 1,
    nodes: previous?.nodes ?? {},
    viewport,
  });
}

export function clearLayout(workflowId: string, graphVersion: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(layoutStorageKey(workflowId, graphVersion));
  } catch {
    // Same reasoning as writeLayout.
  }
}

/**
 * Places every node when there is no stored layout.
 *
 * A layered left-to-right pass: nodes go in the column after the deepest predecessor that
 * reaches them from `graph.start`, and anything unreachable is stacked in a trailing column so
 * it is visible rather than piled at the origin. Cycles are bounded by only ever moving a node
 * forward, which terminates because a node's depth is monotonically increasing and capped at
 * the node count.
 *
 * ponytail: no graph-layout dependency. This is a few dozen lines against a graph an operator
 * drew by hand — tens of nodes, not thousands. Reach for a real layout engine the day someone
 * has a graph this makes ugly, not before.
 */
export function autoLayout(graph: WorkflowGraph): WorkflowLayout {
  const ids = graph.nodes.map((node) => node.id);
  if (ids.length === 0) return {};

  const outgoing = new Map<string, string[]>();
  for (const id of ids) outgoing.set(id, []);
  for (const edge of graph.edges) outgoing.get(edge.from)?.push(edge.to);

  const depth = new Map<string, number>();
  const start = ids.includes(graph.start) ? graph.start : ids[0]!;
  depth.set(start, 0);

  // Relax depths breadth-first, bounded so a cycle cannot spin: each node can only be pushed
  // deeper, and never past the number of nodes.
  //
  // The start node is pinned at column 0 and never relaxed. A guarded back-edge — the only way
  // Atlas expresses a loop — points at a node upstream of itself, and without the pin that edge
  // would push the start node to the far right of its own graph, which is the one arrangement
  // guaranteed to be wrong.
  const queue = [start];
  const limit = ids.length;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const next = (depth.get(current) ?? 0) + 1;
    if (next > limit) continue;
    for (const target of outgoing.get(current) ?? []) {
      if (target === start) continue;
      if ((depth.get(target) ?? -1) < next) {
        depth.set(target, next);
        queue.push(target);
      }
    }
  }

  const unreachableColumn = Math.max(0, ...[...depth.values()]) + 1;
  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const column = depth.get(id) ?? unreachableColumn;
    const bucket = columns.get(column);
    if (bucket) bucket.push(id);
    else columns.set(column, [id]);
  }

  const layout: WorkflowLayout = {};
  for (const [column, members] of columns) {
    // Rows are centred within their column so a fan-out reads symmetrically around its source.
    const height = members.length * NODE_HEIGHT + (members.length - 1) * ROW_GAP;
    members.forEach((id, index) => {
      layout[id] = {
        x: column * (NODE_WIDTH + COLUMN_GAP),
        y: index * (NODE_HEIGHT + ROW_GAP) - height / 2,
      };
    });
  }

  // Shift the whole arrangement into positive space. Centring puts the tallest column's first
  // row above y = 0, and React Flow's initial viewport starts at the origin — so without this
  // the top row renders half above the canvas until the user pans or the view is fitted.
  const positions = Object.values(layout);
  const minY = Math.min(...positions.map((position) => position.y));
  if (minY < 0) {
    for (const position of positions) position.y -= minY;
  }
  return layout;
}

/**
 * Merges a stored layout with the current graph.
 *
 * A node the layout has never seen — one just added, or added by someone else and pulled in on
 * reload — is placed by the auto-layout rather than at the origin, where it would land on top
 * of whatever is already there. Positions for nodes that no longer exist are dropped.
 */
export function resolveLayout(graph: WorkflowGraph, stored: WorkflowLayout): WorkflowLayout {
  const missing = graph.nodes.filter((node) => stored[node.id] === undefined);
  if (missing.length === 0) {
    const pruned: WorkflowLayout = {};
    for (const node of graph.nodes) pruned[node.id] = stored[node.id]!;
    return pruned;
  }

  const fallback = autoLayout(graph);
  const resolved: WorkflowLayout = {};
  for (const node of graph.nodes) {
    resolved[node.id] = stored[node.id] ?? fallback[node.id] ?? { x: 0, y: 0 };
  }
  return resolved;
}

/** Follows a node rename, so arranging a canvas is not undone by renaming something on it. */
export function renameInLayout(
  layout: WorkflowLayout,
  fromId: string,
  toId: string,
): WorkflowLayout {
  if (layout[fromId] === undefined) return layout;
  const next: WorkflowLayout = { ...layout, [toId]: layout[fromId]! };
  delete next[fromId];
  return next;
}
