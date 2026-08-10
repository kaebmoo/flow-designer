/**
 * The Atlas-native workflow editor.
 *
 * The canvas edits one thing: the semantic graph in `workflow-graph.ts`. React Flow's own
 * objects are a projection of that graph, rebuilt whenever it changes, with positions merged in
 * from local storage on the way out. Nothing flows back the other way except a drag, which
 * updates the layout and never the graph — which is why moving a node does not make the
 * workflow dirty and does not offer to `PUT` anything to Atlas.
 *
 * The palette has exactly four entries because Atlas's executor accepts exactly four node
 * types. Conditions are edited on edges, parallelism is several outgoing edges, a loop is a
 * guarded back-edge, and triggers are a separate resource with their own panel. None of those
 * is a node here and none is convertible into one: a graph containing a `condition`, `loop`,
 * `fanout`, or `trigger` node is rejected by Atlas on save, so offering to draw one would be
 * offering to build something that cannot be saved.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useBlocker } from "@tanstack/react-router";
import {
  AlertTriangle,
  Check,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  describeCondition,
  edgesRemovedWithNode,
  isConnectionAllowed,
  removeNode,
  renameNodeId,
  parseWorkflowGraph,
  parseWorkflowPolicy,
  serializeWorkflowGraph,
  serializeWorkflowPolicy,
  unreachableNodeIds,
  validateWorkflow,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type ValidationIssue,
  type WorkflowGraph,
  type WorkflowPolicy,
} from "@/lib/workflow-graph";
import { EdgeInspector, NodeInspector, PolicyPanel } from "./workflow-inspector";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  autoLayout,
  clearLayout,
  readLayout,
  readViewport,
  renameInLayout,
  resolveLayout,
  writeLayout,
  writeViewport,
  type NodePosition,
  type WorkflowLayout,
} from "./workflow-layout";
import {
  clearSemanticWorkflowDraft,
  readSemanticWorkflowDraft,
  writeSemanticWorkflowDraft,
} from "./workflow-draft";
import { type WorkflowDefaultReply } from "./workflow-inspector";
import { counted } from "@/lib/plural";
import { NODE_PRESENTATION, PALETTE_ORDER } from "./workflow-node-presentation";
import { WorkflowCanvasNode, minimapNodeFill, type CanvasNodeData } from "./workflow-node";
import {
  buildInterfacePayload,
  initialInterfaceDraftState,
  WorkflowInterfacePanel,
  type InterfaceDraftState,
} from "./workflow-interface-panel";
import type { WorkflowEditableInterface } from "@/lib/atlas-mappers";
import { isWorkflowStatus, type AtlasWorkflowInterface } from "@/lib/atlas-types";
import { observeWorkflowContract } from "@/lib/workflow-run-contract";

const nodeTypes: NodeTypes = { atlas: WorkflowCanvasNode };

type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; index: number }
  | { kind: "policy" }
  | { kind: "interface" }
  | null;

/** One point in the undo/redo history: everything the editor can put back. */
interface EditorSnapshot {
  graph: WorkflowGraph;
  policy: WorkflowPolicy;
  layout: WorkflowLayout;
  name: string;
  description: string;
  defaultReply: WorkflowDefaultReply;
  interfaceDraft: InterfaceDraftState;
}

/** A readable id for a new node: `worker_1`, `worker_2`, … */
function nextNodeId(graph: WorkflowGraph, kind: NodeKind): string {
  const prefix = kind === "human_gate" ? "gate" : kind;
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}_${index}`;
    if (!graph.nodes.some((node) => node.id === candidate)) return candidate;
  }
}

function newNode(id: string, kind: NodeKind): GraphNode {
  switch (kind) {
    case "worker":
      return { id, type: "worker", prompt: "" };
    case "manager":
      // The schema constant is required and not editable; emitting it on creation means a
      // manager is valid from the moment it exists, not only once its inspector is opened.
      return { id, type: "manager", schema: "manager_decision_v1", prompt: "" };
    case "join":
      return { id, type: "join", mode: "all" };
    case "human_gate":
      return { id, type: "human_gate", label: "Human decision" };
  }
}

/** The one-liner under a node title, derived from the graph and stored nowhere. */
function nodeHint(node: GraphNode, graph: WorkflowGraph): string {
  const outgoing = graph.edges.filter((edge) => edge.from === node.id).length;
  const parallel = outgoing > 1 ? ` · ${outgoing} parallel paths` : "";

  switch (node.type) {
    case "worker":
      return `${node.outputs?.[0] ? `→ ${node.outputs[0]}` : "no output artifact"}${parallel}`;
    case "manager":
      return `chooses among ${counted(outgoing, "path")}`;
    case "join": {
      const upstream = new Set(
        graph.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from),
      ).size;
      return node.mode === "quorum"
        ? `quorum ${node.quorum ?? 1} of ${upstream}`
        : `${node.mode} of ${upstream}`;
    }
    case "human_gate":
      return node.choices?.length
        ? `${counted(node.choices.length, "choice")}${parallel}`
        : `approve or reject${parallel}`;
  }
}

function nodeTitle(node: GraphNode): string {
  return node.type === "human_gate" && node.label ? node.label : node.id;
}

function issueKey(issue: ValidationIssue): string {
  const target = issue.target;
  if (target.kind === "node") return `node:${target.nodeId}`;
  if (target.kind === "edge") return `edge:${target.edgeIndex}`;
  if (target.kind === "policy") return `policy:${target.field}`;
  return `graph:${target.field ?? ""}`;
}

/** Local-only view preference, alongside the layout keys — never part of the workflow. */
const PALETTE_COLLAPSED_KEY = "flow-designer:editor-palette-collapsed";

/**
 * How far out the canvas may be zoomed, and the floor a node has to be shown at.
 *
 * React Flow's own default is `minZoom: 0.5`, which is not a fit — it is a clamp. On any graph
 * wider than about two panes, `fitView` stops at the clamp and simply leaves the rest of the
 * graph off-screen, with nothing on the canvas saying so. `MIN_ZOOM` lets a fit actually
 * complete; `READABLE_ZOOM` is the separate question of how close the camera has to be for a
 * node's title to be legible, which is what a newly added node is moved to.
 */
const MIN_ZOOM = 0.15;
const READABLE_ZOOM = 0.7;

/**
 * The fit used everywhere, rather than React Flow's defaults.
 *
 * `maxZoom` matters as much as `minZoom` here: without it a single-node workflow fits at 2×
 * and fills the pane with one card.
 */
const FIT_VIEW_OPTIONS = { padding: 0.15, minZoom: MIN_ZOOM, maxZoom: 1 } as const;

/**
 * Height of the strip along the bottom of the pane that React Flow's own panels sit in — the
 * zoom controls bottom-left, the minimap bottom-right, and the Inspector button below `xl`.
 *
 * A node dropped into that strip renders fine and is then unclickable, because the panels are
 * above it and the minimap is `pannable`, so it swallows the pointer rather than passing it
 * through. Aiming above the strip is what keeps a newly added node reachable.
 */
const CANVAS_PANEL_BAND = 180;

/**
 * How long a camera move should take for this operator.
 *
 * Panning and zooming a whole canvas is exactly the class of motion that provokes vestibular
 * symptoms, and it is not decoration that can simply be dropped: the viewport genuinely has to
 * end up somewhere else. So the destination is kept and only the travel is removed — the
 * canvas cuts to the new framing instead of gliding to it. Read per call rather than cached,
 * because the OS setting can change while the tab is open.
 */
function cameraDuration(ms: number): number {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
}

/**
 * A position near `candidate` that no existing node already occupies.
 *
 * Adding several nodes without moving the camera would otherwise stack them all on the exact
 * same point, which reads as one node and hides the rest behind it.
 */
function freeSlotNear(candidate: NodePosition, layout: WorkflowLayout): NodePosition {
  const taken = Object.values(layout);
  const overlaps = (point: NodePosition) =>
    taken.some(
      (other) =>
        Math.abs(other.x - point.x) < NODE_WIDTH && Math.abs(other.y - point.y) < NODE_HEIGHT,
    );
  let position = candidate;
  /**
   * Alternating offsets, so the cascade stays clustered around the drop point. Stepping one
   * direction would march a busy canvas off the pane edge or down into the panel strip — the
   * exact overlap this whole placement is avoiding. Bounded, because past a dozen tries the
   * canvas is dense enough that one more step will not help, and a node drawn over another
   * still beats a loop that does not end.
   */
  for (let step = 1; step <= 12 && overlaps(position); step += 1) {
    const offset = Math.ceil(step / 2) * 40 * (step % 2 === 1 ? 1 : -1);
    position = { x: candidate.x + offset, y: candidate.y + offset };
  }
  return position;
}

export interface WorkflowDraft {
  name: string;
  description: string;
  /** Execution policy (`draft` test-only, `active` runnable, `disabled` blocked). */
  status: string;
  graph: Record<string, unknown>;
  policy: Record<string, unknown>;
  defaultReply: WorkflowDefaultReply;
  /** `undefined` omits the key (preserve/never-touch); `null` is an explicit clear. */
  interface: AtlasWorkflowInterface | null | undefined;
  expectedVersion: number;
}

export interface WorkflowEditorProps {
  /** Atlas's id, or null while creating a workflow that has not been saved yet. */
  workflowId: string | null;
  /** Keys the local layout alongside the workflow id. */
  graphVersion: number;
  initialName: string;
  initialDescription: string;
  /** Atlas's stored status. Typed open (string) for forward safety; the selector offers the closed set. */
  initialStatus: string;
  /** Human-formatted `updated_at` for the toolbar's metadata line. */
  updatedAtLabel?: string;
  /**
   * Page-level actions (export, view runs, delete) rendered in the editor's own header —
   * the editor owns the whole page top so the name is edited where it is displayed,
   * instead of a static headline repeating cramped toolbar fields below it.
   */
  headerActions?: ReactNode;
  initialGraph: WorkflowGraph;
  initialPolicy: WorkflowPolicy;
  initialDefaultReply: WorkflowDefaultReply;
  /** Atlas's stored application interface, or the reason it cannot be edited. */
  initialInterface: WorkflowEditableInterface;
  /**
   * Atlas's current `updated_at`, refreshed by the query.
   *
   * Used to notice that *someone else* wrote to this workflow while it was open. It is not
   * used to detect this editor's own save — see `saveCount`.
   */
  savedAt: string | null;
  /**
   * How many saves from this editor have landed.
   *
   * A counter rather than a timestamp because `updated_at` cannot carry the signal: Atlas's
   * `now_iso()` truncates to whole seconds (`atlas/db.py`), so creating a workflow and saving it
   * a moment later produces the *same* `updated_at` and a timestamp comparison sees no change
   * at all. The editor would then sit on "Unsaved changes" after a save that plainly worked.
   */
  saveCount: number;
  /** Runtime node states from a run being viewed, keyed by node id. Empty while authoring. */
  runStates?: Record<string, string>;
  saving: boolean;
  /** Rejections the server produced, mapped back onto the same node/edge/policy targets. */
  serverIssues?: ValidationIssue[];
  /** The message from the last failed save. Shown verbatim, because Atlas wrote it for us. */
  saveError?: string | null;
  expectedVersionOverride?: number;
  /**
   * True while Atlas's stored version differs from the one this editor is showing — another
   * tab or user saved underneath it. While that holds, a save must send the full local state
   * including the interface: an "unchanged" interface draft is only unchanged relative to what
   * *this* editor loaded, and omitting it would silently let the other writer's interface win
   * while the panel keeps displaying this one.
   */
  serverMoved?: boolean;
  onSave: (draft: WorkflowDraft) => void;
  /** Validates against Atlas. Absent until the workflow has an id Atlas knows. */
  onValidateWithAtlas?: (draft: {
    graph: Record<string, unknown>;
    policy: Record<string, unknown>;
  }) => void;
  validating?: boolean;
  atlasValidation?: { ok: boolean; message: string } | null;
  /**
   * Opens the Test Run dialog. Absent while the workflow is unsaved or the role cannot run it.
   *
   * Deliberately not a mutation: the caller opens a dialog that reads and validates, and only an
   * explicit `Start live test` inside it creates an Atlas run.
   */
  onRun?: () => void;
  running?: boolean;
  /** Why running is unavailable, when it is. Shown instead of a silently dead button. */
  runDisabledReason?: string;
}

export function WorkflowEditor(props: WorkflowEditorProps) {
  return (
    <ReactFlowProvider>
      <EditorSurface {...props} />
    </ReactFlowProvider>
  );
}

function EditorSurface({
  workflowId,
  graphVersion,
  initialName,
  initialDescription,
  initialStatus,
  updatedAtLabel,
  headerActions,
  initialGraph,
  initialPolicy,
  initialDefaultReply,
  initialInterface,
  savedAt,
  saveCount,
  runStates,
  saving,
  serverIssues,
  saveError,
  expectedVersionOverride,
  serverMoved,
  onSave,
  onValidateWithAtlas,
  validating,
  atlasValidation,
  onRun,
  running,
  runDisabledReason,
}: WorkflowEditorProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [status, setStatus] = useState(initialStatus);
  const [graph, setGraph] = useState<WorkflowGraph>(initialGraph);
  const [policy, setPolicy] = useState<WorkflowPolicy>(initialPolicy);
  const [defaultReply, setDefaultReply] = useState<WorkflowDefaultReply>(initialDefaultReply);
  const [interfaceDraft, setInterfaceDraft] = useState<InterfaceDraftState>(() =>
    initialInterfaceDraftState(initialInterface),
  );
  const [selection, setSelection] = useState<Selection>(null);
  const [layout, setLayout] = useState<WorkflowLayout>({});
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => {
    // On compact desktops the inspector is a temporary sheet, but selecting an authoring target
    // should still feel direct rather than asking for a second, unrelated click.
    if (selection !== null && window.innerWidth < 1280) setInspectorOpen(true);
  }, [selection]);
  /**
   * Canvas-space preference: the node panel collapses to a thin rail. Local and cosmetic —
   * like canvas layout, it never enters the semantic draft or the save payload. Read in an
   * effect because localStorage does not exist during server rendering.
   */
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PALETTE_COLLAPSED_KEY);
      // The authoring canvas needs the width first. On compact desktops, start with a slim
      // palette rail unless the author has made and saved their own preference.
      setPaletteCollapsed(stored === null ? window.innerWidth < 1280 : stored === "1");
    } catch {
      // A blocked storage must not block editing; the panel simply starts expanded.
    }
  }, []);
  const togglePalette = () =>
    setPaletteCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        window.localStorage.setItem(PALETTE_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // Same reasoning: the preference just won't persist.
      }
      return next;
    });
  const [pendingNodeDeletion, setPendingNodeDeletion] = useState<string | null>(null);
  const { fitView, setViewport, screenToFlowPosition, setCenter, getZoom } = useReactFlow();

  /**
   * The canvas pane, needed to convert "the middle of what the operator is looking at" into a
   * graph coordinate. React Flow exposes the transform but not the element's own box.
   */
  const paneRef = useRef<HTMLDivElement | null>(null);

  /**
   * The middle of the part of the pane a node can actually be dropped into.
   *
   * Vertically that is the middle of everything *above* the panel strip, not the middle of the
   * pane: the true centre of a short pane sits close enough to the minimap that a new node lands
   * under it and cannot be clicked at all.
   */
  const nodeDropPoint = useCallback((): NodePosition | null => {
    const rect = paneRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const usableHeight = Math.max(rect.height - CANVAS_PANEL_BAND, rect.height / 2);
    return screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + usableHeight / 2,
    });
  }, [screenToFlowPosition]);

  /**
   * In-memory undo/redo over the editor's own state — the semantic graph, its policy, the browser
   * layout, and the name/description/reply/interface draft.
   *
   * It is deliberately not persisted and it changes nothing about what a save sends: undo simply
   * puts the editor back in a state it was already in, and `dirty` (a byte comparison against the
   * Atlas baseline) recomputes from there. Snapshots are taken at discrete structural commits
   * (add, connect, delete, rename, auto-arrange); per-keystroke field edits are left to the
   * browser's native text-field undo rather than flooding this stack.
   */
  const HISTORY_LIMIT = 50;
  const snapshotRef = useRef<EditorSnapshot>(undefined as unknown as EditorSnapshot);
  const historyRef = useRef<{ past: EditorSnapshot[]; future: EditorSnapshot[] }>({
    past: [],
    future: [],
  });
  const [historyTick, setHistoryTick] = useState(0);
  const pushHistory = useCallback(() => {
    const history = historyRef.current;
    history.past.push(snapshotRef.current);
    if (history.past.length > HISTORY_LIMIT) history.past.shift();
    history.future = [];
    setHistoryTick((tick) => tick + 1);
  }, []);
  // Mirrors the live editable state so `pushHistory`/undo/redo can capture it without threading
  // every value through their closures. Reassigned on every render, so it is always current.
  snapshotRef.current = { graph, policy, layout, name, description, defaultReply, interfaceDraft };

  const interfaceContract = useMemo(
    () =>
      observeWorkflowContract(graph, {
        workflowId: workflowId ?? "draft",
        observedVersion: graphVersion,
      }),
    [graph, workflowId, graphVersion],
  );

  const current = useMemo(
    () => ({
      name,
      description,
      status,
      graph: serializeWorkflowGraph(graph),
      policy: serializeWorkflowPolicy(policy),
      defaultReply,
      interfaceDraft,
    }),
    [name, description, status, graph, policy, defaultReply, interfaceDraft],
  );

  /**
   * Dirty is a comparison against what Atlas holds, not a flag set by an event handler.
   *
   * The scaffold derived its flag from React Flow's `NodeChange` stream, so a drag marked the
   * workflow dirty and a keyboard delete did not — exactly backwards, and the delete case meant
   * losing a node silently. Comparing the bytes that would actually be sent cannot get that
   * wrong: identical payload, nothing to save. `interfaceDraft` participates the same way: an
   * interface-only edit (nothing else touched) still flips this to dirty and still triggers the
   * optimistic `expected_version` save below.
   */
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify({
      name: initialName,
      description: initialDescription,
      status: initialStatus,
      graph: serializeWorkflowGraph(initialGraph),
      policy: serializeWorkflowPolicy(initialPolicy),
      defaultReply: initialDefaultReply,
      interfaceDraft: initialInterfaceDraftState(initialInterface),
    }),
  );
  const dirty = JSON.stringify(current) !== baseline;

  /**
   * Whether the interface draft still matches what this editor loaded (or last successfully
   * saved — the baseline re-bases there). Unchanged means the save *omits* the `interface` key
   * entirely, so Atlas preserves its stored value verbatim: a graph-only save never re-encodes
   * a stored interface, and a changed draft in `"none"` mode is always a deliberate clear this
   * session — which is why this comparison, not a mount-time "had one before" flag, decides
   * between `null` and omission. (A flag frozen at mount misses an add-save-clear sequence in
   * one session, because a successful save deliberately does not remount the editor.)
   */
  const baselineInterfaceDraft = useMemo(
    () => JSON.stringify((JSON.parse(baseline) as { interfaceDraft: unknown }).interfaceDraft),
    [baseline],
  );
  const interfaceUnchanged =
    !serverMoved && JSON.stringify(interfaceDraft) === baselineInterfaceDraft;

  const interfaceBuild = useMemo(
    () => buildInterfacePayload(interfaceDraft, interfaceUnchanged),
    [interfaceDraft, interfaceUnchanged],
  );
  const navigationBlocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: dirty,
    disabled: !dirty,
    withResolver: true,
  });

  /**
   * The version is Atlas's optimistic-concurrency token. It advances only after a successful
   * save or an explicit conflict choice to keep this local draft.
   */
  const [expectedVersion, setExpectedVersion] = useState(graphVersion);
  const sentPayload = useRef<string | null>(null);

  useEffect(() => {
    if (expectedVersionOverride !== undefined) setExpectedVersion(expectedVersionOverride);
  }, [expectedVersionOverride]);

  useEffect(() => {
    if (!dirty) setExpectedVersion(graphVersion);
  }, [dirty, graphVersion]);

  useEffect(() => {
    if (saveCount === 0 || sentPayload.current === null) return;
    setBaseline(sentPayload.current);
    sentPayload.current = null;
    if (workflowId) clearSemanticWorkflowDraft(workflowId, expectedVersion);
  }, [saveCount]);

  const [recovery, setRecovery] = useState<ReturnType<typeof readSemanticWorkflowDraft>>(undefined);

  useEffect(() => {
    if (!workflowId) return;
    setRecovery(readSemanticWorkflowDraft(workflowId, graphVersion));
  }, [workflowId, graphVersion]);

  /**
   * True once this mount has actually been dirty, so a return to clean can be told apart from
   * having started clean. Without it the effect below would delete, on first render, the very
   * draft the recovery banner had just been offered.
   */
  const hasBeenDirty = useRef(false);

  useEffect(() => {
    if (!workflowId) return;
    if (!dirty) {
      /**
       * Undo (or a manual revert) brought the editor back to the saved state.
       *
       * The stored draft now describes an edit the operator deliberately took back, and leaving
       * it there means the next visit offers to restore it — resurrecting work that was thrown
       * away on purpose. The save path clears it too (via `saveCount`), which makes this the
       * undo-shaped half of the same rule.
       *
       * The in-memory `recovery` banner is left alone: it holds its own copy, so an offer
       * already on screen stays actionable for this session rather than vanishing under the
       * operator mid-edit.
       */
      if (!hasBeenDirty.current) return;
      hasBeenDirty.current = false;
      clearSemanticWorkflowDraft(workflowId, expectedVersion);
      return;
    }
    hasBeenDirty.current = true;
    writeSemanticWorkflowDraft(workflowId, {
      version: expectedVersion,
      name,
      description,
      status,
      graph: current.graph,
      policy: current.policy,
      defaultReply,
      interfaceDraft,
    });
  }, [
    workflowId,
    dirty,
    expectedVersion,
    name,
    description,
    status,
    current.graph,
    current.policy,
    defaultReply,
    interfaceDraft,
  ]);

  const restoreDraft = () => {
    if (!recovery) return;
    const restoredGraph = parseWorkflowGraph(recovery.graph);
    const restoredPolicy = parseWorkflowPolicy(recovery.policy);
    if (restoredGraph.ok) {
      setGraph(restoredGraph.value);
      // Mount pruned the stored layout to the SERVER graph's nodes, so a node that exists
      // only in the draft lost its position and would stack at the origin on top of the
      // start node. Re-resolve against the restored graph (missing nodes get auto-layout
      // slots, written through like any arrange), then refit so the result is on screen.
      applyLayout(resolveLayout(restoredGraph.value, layout));
      fitSoon();
    }
    if (restoredPolicy.ok) setPolicy(restoredPolicy.value);
    setName(recovery.name);
    setDescription(recovery.description);
    // Older drafts (written before status editing existed) recover without touching it.
    if (recovery.status !== undefined) setStatus(recovery.status);
    setDefaultReply(recovery.defaultReply);
    if (recovery.interfaceDraft) setInterfaceDraft(recovery.interfaceDraft);
    setRecovery(undefined);
  };

  const discardDraft = () => {
    if (workflowId) clearSemanticWorkflowDraft(workflowId, graphVersion);
    setRecovery(undefined);
  };

  const submit = () => {
    if (!interfaceBuild.ok) return;
    const draft: WorkflowDraft = {
      name,
      description,
      status,
      graph: current.graph,
      policy: current.policy,
      defaultReply,
      interface: interfaceBuild.interface,
      expectedVersion,
    };
    sentPayload.current = JSON.stringify(current);
    onSave(draft);
  };

  // Layout is read in an effect, not in a lazy initialiser: `localStorage` does not exist during
  // server rendering, so reading it up front would make SSR and hydration disagree about where
  // every node sits.
  const layoutKeyId = workflowId ?? "draft";
  const initialGraphRef = useRef(initialGraph);
  initialGraphRef.current = initialGraph;
  /**
   * Requests a view fit once the layout change it follows has actually been rendered.
   *
   * `fitView` reads React Flow's store, which holds the new positions only after the changed
   * `nodes` prop has been committed and measured — calling it synchronously would fit to where
   * the nodes just were, and a bare `requestAnimationFrame` races the commit. The effect below
   * lists `flowNodes` in its dependencies, so it is guaranteed to run after the nodes are in.
   */
  const [fitRequest, setFitRequest] = useState(0);
  /**
   * Which kind of fit was asked for.
   *
   * `"whole"` means the operator explicitly asked to see everything — Auto-arrange, Fit View, a
   * draft restore, an undo. Framing the entire graph is the request, however small that makes
   * it. `"legible"` is the arrival fit, where nobody asked for anything and the editor is
   * choosing on their behalf; that one is bounded by whether a node can actually be read.
   */
  const fitModeRef = useRef<"whole" | "legible">("whole");
  const fitSoon = useCallback((mode: "whole" | "legible" = "whole") => {
    fitModeRef.current = mode;
    setFitRequest((request) => request + 1);
  }, []);

  const applySnapshot = useCallback(
    (snapshot: EditorSnapshot) => {
      setGraph(snapshot.graph);
      setPolicy(snapshot.policy);
      setLayout(snapshot.layout);
      // Layout is browser-only state; a restored layout is written through so it survives a reload
      // exactly as an auto-arrange or a drag would.
      writeLayout(layoutKeyId, graphVersion, snapshot.layout);
      setName(snapshot.name);
      setDescription(snapshot.description);
      setDefaultReply(snapshot.defaultReply);
      setInterfaceDraft(snapshot.interfaceDraft);
      // The previous selection may point at a node or edge this snapshot does not contain.
      setSelection(null);
      fitSoon();
    },
    [layoutKeyId, graphVersion, fitSoon],
  );

  const undo = useCallback(() => {
    const history = historyRef.current;
    if (history.past.length === 0) return;
    const previous = history.past.pop()!;
    history.future.unshift(snapshotRef.current);
    if (history.future.length > HISTORY_LIMIT) history.future.pop();
    applySnapshot(previous);
    setHistoryTick((tick) => tick + 1);
  }, [applySnapshot]);

  const redo = useCallback(() => {
    const history = historyRef.current;
    if (history.future.length === 0) return;
    const next = history.future.shift()!;
    history.past.push(snapshotRef.current);
    if (history.past.length > HISTORY_LIMIT) history.past.shift();
    applySnapshot(next);
    setHistoryTick((tick) => tick + 1);
  }, [applySnapshot]);

  useEffect(() => {
    const viewport = readViewport(layoutKeyId, graphVersion);
    setLayout(resolveLayout(initialGraphRef.current, readLayout(layoutKeyId, graphVersion)));
    // React Flow's `fitView` prop only runs on mount, and on mount every node is still at the
    // origin because the layout has not been read yet. A saved viewport wins; otherwise fitting
    // after the layout commits is what makes the graph visible without manual panning.
    if (viewport) {
      const frame = window.requestAnimationFrame(() => void setViewport(viewport));
      return () => window.cancelAnimationFrame(frame);
    }
    // Arrival: the one fit nobody asked for, so it is the one bounded by legibility.
    fitSoon("legible");
  }, [layoutKeyId, graphVersion, fitSoon, setViewport]);

  /**
   * Applies a layout, writing it through to storage.
   *
   * `persist: false` keeps a mid-drag frame in memory only. `onNodesChange` fires on every
   * pointer move, and a synchronous `localStorage.setItem` per frame is a main-thread write on
   * the hot path of the one interaction that has to stay smooth.
   */
  const applyLayout = useCallback(
    (next: WorkflowLayout, persist = true) => {
      setLayout(next);
      if (persist) writeLayout(layoutKeyId, graphVersion, next);
    },
    [layoutKeyId, graphVersion],
  );

  const localIssues = useMemo(() => validateWorkflow(graph, policy), [graph, policy]);
  const issues = useMemo(
    () => [...localIssues, ...(serverIssues ?? [])],
    [localIssues, serverIssues],
  );
  const issuesByTarget = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const issue of issues) {
      const key = issueKey(issue);
      const bucket = map.get(key);
      if (bucket) bucket.push(issue.message);
      else map.set(key, [issue.message]);
    }
    return map;
  }, [issues]);

  const orphans = useMemo(() => unreachableNodeIds(graph), [graph]);

  /**
   * React Flow's node objects, kept rather than rebuilt.
   *
   * The semantic graph is still the source of truth — this array is derived from it on every
   * change. What it must *not* do is replace the node objects wholesale, because React Flow v12
   * stores each node's measured size on the object it was given and keeps a node
   * `visibility: hidden` until it has been measured. Handing it a freshly built array every
   * render throws that measurement away on each pass, `fitView` never completes, and the canvas
   * renders an invisible graph. Merging into the previous objects preserves it.
   */
  const [flowNodes, setFlowNodes] = useState<Node<CanvasNodeData>[]>([]);

  useEffect(() => {
    setFlowNodes((previous) => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      return graph.nodes.map((node) => {
        const existing = byId.get(node.id);
        const isStart = graph.start === node.id;
        const hasIssue = issuesByTarget.has(`node:${node.id}`);
        return {
          ...existing,
          id: node.id,
          type: "atlas",
          position: layout[node.id] ?? existing?.position ?? { x: 0, y: 0 },
          selected: selection?.kind === "node" && selection.id === node.id,
          /**
           * The name a screen reader reads for this node.
           *
           * React Flow gives a node `role="group"`, which takes no name from its contents, so
           * without this every node on the canvas announces as an unlabelled "group" — the
           * canvas becomes seven identical stops. Everything the tile shows visually goes in,
           * in the order it is read: kind, id, then the state a sighted operator gets from the
           * badge, the ring colour, and the derived hint. Edges already get an equivalent name
           * from React Flow itself.
           */
          ariaLabel: [
            NODE_PRESENTATION[node.type].label,
            node.id,
            isStart ? "start node" : null,
            hasIssue ? "has a validation issue" : null,
            runStates?.[node.id] ?? null,
            nodeHint(node, graph),
          ]
            .filter(Boolean)
            .join(", "),
          data: {
            kind: node.type,
            title: nodeTitle(node),
            hint: nodeHint(node, graph),
            isStart,
            hasIssue,
            runState: runStates?.[node.id],
          },
        } satisfies Node<CanvasNodeData>;
      });
    });
  }, [graph, layout, selection, issuesByTarget, runStates]);

  /**
   * Whether React Flow has measured every node yet.
   *
   * `fitView` computes from measured sizes, so running it against an unmeasured node fits
   * nothing and silently leaves the graph wherever it was. Waiting on this — rather than on
   * `flowNodes` itself — also stops the effect from re-running on each intermediate array
   * identity while measurement settles.
   */
  const nodesMeasured =
    flowNodes.length > 0 && flowNodes.every((node) => (node.measured?.width ?? 0) > 0);

  /**
   * The last fit request actually serviced.
   *
   * Every fit is asked for explicitly — mount, undo, auto-arrange, draft restore. Without this
   * guard the effect below re-fit on *any* change to the node list, so adding a node yanked the
   * camera back to frame the whole graph, and marking a node with a validation issue (which
   * rewrites `data.hasIssue`) reset the operator's zoom as a side effect of pressing
   * "Check against Atlas".
   */
  const servicedFit = useRef(0);

  useEffect(() => {
    if (fitRequest === 0 || !nodesMeasured || servicedFit.current === fitRequest) return;
    const frame = window.requestAnimationFrame(() => {
      // Marked inside the frame, so a cleanup that cancels before it runs leaves the request
      // outstanding for the next pass rather than swallowing it.
      servicedFit.current = fitRequest;
      const duration = cameraDuration(150);
      const whole = () => void fitView({ ...FIT_VIEW_OPTIONS, duration });

      if (fitModeRef.current === "whole") {
        whole();
        return;
      }

      /**
       * The arrival fit, bounded by legibility.
       *
       * Fitting a workflow to the pane is only useful if you can then read it. These graphs are
       * long and shallow — a seven-node branch is roughly 5:1 against a pane nearer 1:1 — so the
       * fit is width-bound and lands around 0.44 on a laptop and at the `MIN_ZOOM` floor on a
       * phone, where a 14px node title paints at two or three physical pixels. That is a picture
       * of a workflow, not a workflow you can work on.
       *
       * So: frame the whole graph when it fits at a readable size, and otherwise open on the
       * start node at that size. `graph.start` is where Atlas begins every run, which makes it
       * the honest place for the operator to begin too — better than the centroid of a shape
       * they cannot read. Panning, the minimap, and Fit View all remain for seeing the rest.
       */
      const start = flowNodes.find((node) => node.id === graph.start) ?? flowNodes[0];
      if (!start) {
        whole();
        return;
      }

      /*
        Ask React Flow what the fit actually is rather than re-deriving it.

        Modelling the same calculation from `getNodesBounds` + `getViewportForBounds` means
        keeping a second copy of its padding and clamping semantics in step with the library's,
        and getting that subtly wrong is silent: the branch just picks the wrong view. Applying
        the fit with no animation and reading `getZoom()` back is the library's own answer, and
        because both this and the correction below are instant there is no intermediate frame to
        see — arrival should not animate anyway.
      */
      void fitView({ ...FIT_VIEW_OPTIONS, duration: 0 }).then(() => {
        // Read the zoom *after* the fit resolves. `fitView` is a promise even at duration 0, so
        // reading `getZoom()` on the next line returns the pre-fit value and the check silently
        // compares against the wrong number.
        if (getZoom() >= READABLE_ZOOM) return;
        void setCenter(
          start.position.x + (start.measured?.width ?? NODE_WIDTH) / 2,
          start.position.y + (start.measured?.height ?? NODE_HEIGHT) / 2,
          { zoom: READABLE_ZOOM, duration: 0 },
        );
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitRequest, nodesMeasured, fitView, setCenter, getZoom, flowNodes, graph.start]);

  const flowEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge, index) => ({
        // The index is part of the identity because Atlas permits two edges between the same
        // pair of nodes carrying different conditions — `from->to` alone is not unique.
        id: `e${index}:${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        // The caption is a render of the condition. It is not stored, and it cannot drift from
        // the condition the way the scaffold's free-text edge labels did.
        label: describeCondition(edge.condition),
        selected: selection?.kind === "edge" && selection.index === index,
        style: issuesByTarget.has(`edge:${index}`)
          ? { stroke: "var(--color-destructive)" }
          : undefined,
      })),
    [graph, selection, issuesByTarget],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CanvasNodeData>>[]) => {
      // Every change is forwarded, including the `dimensions` change that carries React Flow's
      // measurement — dropping it is what leaves nodes invisible.
      setFlowNodes((previous) => applyNodeChanges(changes, previous));

      // React Flow selects a node when a keyboard user focuses it (Tab) and presses Enter/Space,
      // emitting a `select` change here. Without mirroring that into our own `selection` state the
      // inspector never opens and the effect that derives `selected` from `selection` immediately
      // reverts the highlight — so a keyboard user could never actually select a node. Mouse
      // clicks emit the same change, so this covers both.
      const selects = changes.filter(
        (change): change is Extract<NodeChange<Node<CanvasNodeData>>, { type: "select" }> =>
          change.type === "select",
      );
      if (selects.length > 0) {
        const selected = selects.find((change) => change.selected);
        if (selected) {
          setSelection({ kind: "node", id: selected.id });
        } else {
          // Escape / deselect: only clear if the node being deselected is the one we are showing.
          setSelection((previous) =>
            previous?.kind === "node" && selects.some((change) => change.id === previous.id)
              ? null
              : previous,
          );
        }
      }

      // A position change is *layout*, not graph: it updates local storage and never touches
      // the semantic model or the dirty state, which is why dragging a node does not make the
      // workflow claim unsaved changes.
      const moves = changes.filter(
        (change): change is Extract<NodeChange<Node<CanvasNodeData>>, { type: "position" }> =>
          change.type === "position" && change.position !== undefined,
      );
      if (moves.length === 0) return;

      // React Flow reports `dragging: true` for every frame of a drag and `false` once it ends;
      // only the settled frame is written through to storage.
      const settled = !moves.some((change) => change.dragging === true);
      setLayout((previous) => {
        const next = { ...previous };
        for (const move of moves) next[move.id] = move.position!;
        if (settled) writeLayout(layoutKeyId, graphVersion, next);
        return next;
      });
    },
    [layoutKeyId, graphVersion],
  );

  const addNode = useCallback(
    (kind: NodeKind) => {
      pushHistory();
      const id = nextNodeId(graph, kind);
      const next: WorkflowGraph = {
        // The first node becomes the start: a graph without one is invalid, and asking the user
        // to choose when there is exactly one candidate is a step with one possible answer.
        start: graph.nodes.length === 0 ? id : graph.start,
        nodes: [...graph.nodes, newNode(id, kind)],
        edges: graph.edges,
      };
      /**
       * Put the node where the operator is looking, not where the auto-layout would file it.
       *
       * `autoLayout` appends a new node to the right of everything already drawn, and the
       * `fitView` that used to follow could not reach it: React Flow's default `minZoom` of 0.5
       * clamps the fit, so on any graph wider than about two panes the node landed off-screen
       * and the create action looked like it had done nothing at all. Dropping the node into
       * the middle of the current view removes the need to move the camera to find it.
       *
       * The auto-layout slot is still the fallback for the case the pane cannot be measured
       * (first paint, or a hidden canvas), where there is no "current view" to aim at.
       */
      const drop = nodeDropPoint();
      const position = drop
        ? freeSlotNear({ x: drop.x - NODE_WIDTH / 2, y: drop.y - NODE_HEIGHT / 2 }, layout)
        : (autoLayout(next)[id] ?? { x: 0, y: 0 });

      setGraph(next);
      applyLayout({ ...layout, [id]: position });
      setSelection({ kind: "node", id });

      // Only intervene when the view is too far out to read the node that just appeared —
      // otherwise the camera stays exactly where the operator left it, which is the whole
      // point of placing the node in view rather than fitting the graph around it.
      if (getZoom() < READABLE_ZOOM) {
        setCenter(position.x + NODE_WIDTH / 2, position.y + NODE_HEIGHT / 2, {
          zoom: READABLE_ZOOM,
          duration: cameraDuration(200),
        });
      }
    },
    [graph, layout, applyLayout, pushHistory, nodeDropPoint, getZoom, setCenter],
  );

  const removeSelection = useCallback(() => {
    if (selection?.kind === "node") {
      pushHistory();
      setGraph((previous) => removeNode(previous, selection.id));
    } else if (selection?.kind === "edge") {
      pushHistory();
      setGraph((previous) => ({
        ...previous,
        edges: previous.edges.filter((_, index) => index !== selection.index),
      }));
    } else {
      return;
    }
    // Clearing the selection is part of the delete, not a side effect: the scaffold left the
    // inspector pointed at a node that no longer existed.
    setSelection(null);
  }, [selection, pushHistory]);

  const requestDeleteSelection = useCallback(() => {
    if (selection?.kind === "node") {
      // Do not choose a replacement by array order: changing graph.start changes execution.
      if (selection.id === graph.start) return;
      setPendingNodeDeletion(selection.id);
      return;
    }
    if (selection?.kind === "edge") removeSelection();
  }, [selection, graph.start, removeSelection]);

  const confirmNodeDeletion = useCallback(() => {
    if (!pendingNodeDeletion) return;
    pushHistory();
    setGraph((previous) => removeNode(previous, pendingNodeDeletion));
    setSelection(null);
    setPendingNodeDeletion(null);
  }, [pendingNodeDeletion, pushHistory]);

  const pendingDeletionNode = pendingNodeDeletion
    ? graph.nodes.find((node) => node.id === pendingNodeDeletion)
    : undefined;
  const pendingDeletionEdges = pendingNodeDeletion
    ? edgesRemovedWithNode(graph, pendingNodeDeletion)
    : [];

  /**
   * Canvas keyboard selection and delete, bound on the canvas rather than the document so
   * neither can fire while the user is typing in an inspector field.
   *
   * Enter/Space is wired here rather than left to React Flow, even though React Flow has its own
   * handler for both, because that handler only reaches this editor for *nodes*: it selects an
   * edge by pushing a change through `onEdgesChange`, which this component does not supply —
   * `flowEdges` is derived from the semantic graph, so a focused edge could never be selected at
   * all. Reading the focused element's `data-id` covers both element types with one rule and
   * does not depend on a library store change this component then has to mirror back. Selecting
   * an already-selected element is a no-op, so running alongside React Flow's own path is safe.
   */
  const onCanvasKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const selects = event.key === "Enter" || event.key === " ";
      if (!selects && event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;

      if (selects) {
        const focused = target?.closest(".react-flow__node, .react-flow__edge");
        const id = focused?.getAttribute("data-id");
        if (!focused || !id) return;
        // Space would otherwise scroll the pane out from under the node it just selected.
        event.preventDefault();
        if (focused.classList.contains("react-flow__node")) {
          setSelection({ kind: "node", id });
          return;
        }
        const index = flowEdges.findIndex((candidate) => candidate.id === id);
        if (index >= 0) setSelection({ kind: "edge", index });
        return;
      }

      if (selection?.kind !== "node" && selection?.kind !== "edge") return;
      event.preventDefault();
      requestDeleteSelection();
    },
    [selection, requestDeleteSelection, flowEdges],
  );

  /**
   * Undo/redo, bound on the editor root so it works from the canvas, the palette, or the
   * inspector — except inside a text field, where Cmd/Ctrl+Z must remain the browser's own
   * character-level undo rather than reverting a whole structural change.
   */
  const onConnect = useCallback(
    (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target) return;
      if (!isConnectionAllowed(graph, source, target)) return;
      const from = graph.nodes.find((node) => node.id === source);
      // Seed the condition Atlas requires for this source, so a freshly drawn edge is valid
      // rather than immediately reported as a problem the user then has to go and fix.
      const condition: GraphEdge["condition"] =
        from?.type === "manager"
          ? { type: "manager_selected", target }
          : from?.type === "human_gate" && from.choices?.length
            ? { type: "human_selected", choice: from.choices[0]!.id }
            : { type: "always" };
      pushHistory();
      const edges = [...graph.edges, { from: source, to: target, condition }];
      setGraph({ ...graph, edges });
      setSelection({ kind: "edge", index: edges.length - 1 });
    },
    [graph, pushHistory],
  );

  const updateNode = useCallback((next: GraphNode) => {
    setGraph((previous) => ({
      ...previous,
      nodes: previous.nodes.map((node) => (node.id === next.id ? next : node)),
    }));
  }, []);

  const rename = useCallback(
    (fromId: string, toId: string): { ok: boolean; reason?: string } => {
      const result = renameNodeId(graph, fromId, toId);
      if (!result.ok) return { ok: false, reason: result.reason };
      pushHistory();
      setGraph(result.graph);
      applyLayout(renameInLayout(layout, fromId, toId));
      setSelection({ kind: "node", id: toId });
      return { ok: true };
    },
    [graph, layout, applyLayout, pushHistory],
  );

  const selectedNode =
    selection?.kind === "node" ? graph.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === "edge" ? graph.edges[selection.index] : undefined;

  const blocking = localIssues.length > 0 || !interfaceBuild.ok;

  const onEditorKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      const key = event.key.toLowerCase();

      /**
       * Save, from anywhere in the editor including inside a field.
       *
       * The most-used action on the surface was mouse-only, in an editor that already bound
       * undo and redo. Deliberately *not* excluded inside inputs the way undo is: the browser's
       * own ⌘S would otherwise offer to save the page to disk while the operator is typing a
       * prompt, which is both useless and alarming. The guard is `submit`'s own — it no-ops when
       * the interface draft is unparseable — plus the same `dirty`/`saving` conditions the
       * button is disabled on, so the shortcut can never do what the button would refuse.
       */
      if (key === "s") {
        event.preventDefault();
        if (!saving && !blocking && dirty) submit();
        return;
      }

      if (key !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    },
    [undo, redo, submit, saving, blocking, dirty],
  );

  // `historyTick` is read so the button disabled states re-render when the history stacks change.
  void historyTick;
  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;
  const readiness = !interfaceBuild.ok
    ? `Fix the Application interface first: ${interfaceBuild.message}`
    : blocking
      ? `Resolve ${issues.length} ${issues.length === 1 ? "check" : "checks"} before saving.`
      : dirty
        ? "Next: save this version, verify it with Atlas, then run a live test."
        : !onValidateWithAtlas
          ? "Save this workflow before Atlas can verify or run it."
          : !onRun
            ? (runDisabledReason ?? "This workflow cannot run from this editor.")
            : "Saved and ready. Verify with Atlas before running a live test.";
  const inspectorTitle =
    selection?.kind === "node"
      ? "Node details"
      : selection?.kind === "edge"
        ? "Edge details"
        : selection?.kind === "policy"
          ? "Run policy"
          : selection?.kind === "interface"
            ? "Application interface"
            : "Inspector";
  const inspectorContent = selectedNode ? (
    <NodeInspector
      node={selectedNode}
      graph={graph}
      issues={issuesByTarget.get(`node:${selectedNode.id}`) ?? []}
      onChange={updateNode}
      onRename={(nextId) => rename(selectedNode.id, nextId)}
      onSetStart={() => setGraph((previous) => ({ ...previous, start: selectedNode.id }))}
      onConnect={(target) =>
        onConnect({
          source: selectedNode.id,
          target,
          sourceHandle: null,
          targetHandle: null,
        })
      }
      onDelete={requestDeleteSelection}
      deleteDisabled={selectedNode.id === graph.start}
    />
  ) : selectedEdge && selection?.kind === "edge" ? (
    <EdgeInspector
      edge={selectedEdge}
      edgeIndex={selection.index}
      graph={graph}
      policy={policy}
      issues={issuesByTarget.get(`edge:${selection.index}`) ?? []}
      onChange={(next) =>
        setGraph((previous) => ({
          ...previous,
          edges: previous.edges.map((edge, index) => (index === selection.index ? next : edge)),
        }))
      }
      onDelete={requestDeleteSelection}
    />
  ) : selection?.kind === "policy" ? (
    <PolicyPanel
      policy={policy}
      issues={issues
        .filter((issue) => issue.target.kind === "policy")
        .map((issue) => issue.message)}
      onChange={setPolicy}
      defaultReply={defaultReply}
      onDefaultReplyChange={setDefaultReply}
    />
  ) : selection?.kind === "interface" ? (
    <WorkflowInterfacePanel
      draft={interfaceDraft}
      onChange={setInterfaceDraft}
      contract={interfaceContract}
    />
  ) : (
    <div className="space-y-4 px-4 py-6">
      <p className="text-xs text-muted-foreground">
        Select a node or an edge to edit it. Drawing a connection creates an edge; its condition
        decides whether Atlas takes it.
      </p>
      <div className="rounded-md border border-border px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Start node
        </p>
        <p className="mt-1 font-mono text-xs text-foreground">{graph.start || "not set"}</p>
      </div>
      <div className="rounded-md border border-border px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Local layout
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Node positions stay in this browser only. Atlas has no layout endpoint, so they do not
          follow you to another device or appear for other authors.
        </p>
        <button
          type="button"
          onClick={() => {
            pushHistory();
            clearLayout(layoutKeyId, graphVersion);
            applyLayout(autoLayout(graph));
            fitSoon();
          }}
          className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline pointer-coarse:min-h-11 pointer-coarse:text-xs"
        >
          <Trash2 className="size-3" aria-hidden="true" />
          Forget this layout
        </button>
      </div>
    </div>
  );

  return (
    /*
      Below `md` the column scrolls instead of compressing.

      The header and toolbar are a fixed cost — and once every control in them clears 44×44 for
      a finger, they are a *large* fixed cost. As a flex column that must fit the viewport, the
      only thing left to squeeze was the canvas, which was ending up a quarter of the screen:
      the one part of this page nobody opens the editor without. Letting the column scroll gives
      the canvas a floor (see `md:min-h-0` below) and pushes the overflow into a gesture people
      already have. Unchanged from `md` up, where everything fits at once.
    */
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-y-hidden"
      onKeyDown={onEditorKeyDown}
    >
      {/*
        `AlertDialogCancel`/`AlertDialogAction`, and an `onOpenChange` — not plain buttons.

        Radix autofocuses its Cancel on open and traps focus inside the content. With plain
        `<Button>`s there was no Cancel to focus, so focus never *entered* the scope and the trap
        never engaged: the dialog opened with focus still on the sidebar link that triggered it,
        Tab walked the navigation behind the overlay, and Escape did nothing because dismissal
        had nowhere to report to. Measured, on the most frequently hit high-stakes moment in the
        editor. The node-delete dialog below always did this correctly.
      */}
      <AlertDialog
        open={navigationBlocker.status === "blocked"}
        onOpenChange={(open) => {
          // Escape and overlay dismissal both land here. Cancelling the navigation is the
          // conservative reading of "the user backed out of the prompt".
          if (!open) navigationBlocker.reset?.();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved workflow changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The graph, its policy, name, and description have changes that are not in Atlas. Node
              positions and zoom are already stored only in this browser.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => navigationBlocker.reset?.()}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => navigationBlocker.proceed?.()}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDeletionNode !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingNodeDeletion(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDeletionNode?.id}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {pendingDeletionEdges.length} related{" "}
              {pendingDeletionEdges.length === 1 ? "edge" : "edges"}, including any loop guard that
              counts this node. Choose another start node first if this node should be the execution
              entry point.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep node</AlertDialogCancel>
            {/* Destructive, for the same reason as the workflow delete: the default variant
                painted the destroy action in the primary cyan reserved for Save. */}
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={confirmNodeDeletion}
            >
              Delete node
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
        The identity is edited where it is displayed: one full-width header, not a static
        headline repeating cramped toolbar fields below it. The inputs read as the title at
        rest — transparent field chrome — and reveal the edit affordance on hover/focus.
        The sr-only h1 keeps the page's heading outline (the name input cannot be one).
      */}
      <div className="border-b border-border bg-card px-6 pb-2 pt-3">
        <h1 className="sr-only">{name || "Untitled workflow"}</h1>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-72 max-w-3xl flex-1">
            <Input
              value={name}
              aria-label="Workflow name"
              placeholder="Untitled workflow"
              onChange={(event) => setName(event.target.value)}
              className="h-9 border-transparent px-2 text-lg font-bold tracking-tight shadow-none hover:border-input focus-visible:border-input md:text-lg"
            />
            <Input
              value={description}
              aria-label="Workflow description"
              placeholder="Add a description…"
              onChange={(event) => setDescription(event.target.value)}
              className="h-7 border-transparent px-2 text-sm text-muted-foreground shadow-none hover:border-input focus-visible:border-input md:text-sm"
            />
          </div>
          {headerActions ? (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-1">
              {headerActions}
            </div>
          ) : null}
        </div>
      </div>

      {/*
        One full-width toolbar row: machine metadata + execution policy on the left, editing
        actions on the right. Full-width (above the panels) so it cannot collide with the
        inspector the way a column-scoped toolbar did.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card px-6 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          {workflowId ? (
            // Reference data, not state: the id is on the list card that got you here and in
            // the URL. It costs a line of a phone's screen to repeat it above the canvas, so
            // below `md` it steps aside for the graph. The dirty flag and readiness line, which
            // are state, stay at every width.
            <span className="hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground md:inline">
              {workflowId}
            </span>
          ) : null}
          {/*
          Execution policy, saved with everything else (it participates in the same
          expected_version save, so a status flip cannot silently race another writer).
          Atlas enforces the semantics at every start path; this selector is how an
          operator moves a workflow between them. A legacy value outside the closed set
          is shown as-is so the control never lies, but only the three real policies are
          offered — saving then requires choosing one, because Atlas validates the set.
        */}
          <select
            value={status}
            aria-label="Workflow status"
            aria-describedby="workflow-status-help"
            data-testid="workflow-status-select"
            onChange={(event) => setStatus(event.target.value)}
            className="h-8 w-36 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            {isWorkflowStatus(status) ? null : (
              <option value={status} disabled>
                {status} (unsupported)
              </option>
            )}
            <option value="draft">Draft — test only</option>
            <option value="active">Active — production</option>
            <option value="disabled">Disabled — blocked</option>
          </select>
          {/* The option labels are compact; the full policy reaches keyboard/SR users
            through aria-describedby (never title=). */}
          <span id="workflow-status-help" className="sr-only">
            Draft allows test runs only. Active enables test and production runs. Disabled blocks
            every run. Saved with the workflow.
          </span>
          {/* Same reasoning as the id above: reference, not state. */}
          <span className="hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground md:inline">
            v{graphVersion}
            {updatedAtLabel ? ` · updated ${updatedAtLabel}` : ""}
          </span>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/*
            Reserved width: the label toggles between "Saved" and the much wider "Unsaved
            changes", and without a fixed slot that width change re-wraps the whole toolbar —
            the row jumps taller and the canvas shifts the moment anything is edited.
          */}
          <span
            data-testid="workflow-dirty-state"
            className={`min-w-32 text-right font-mono text-[10px] uppercase tracking-widest ${
              dirty ? "text-warning" : "text-muted-foreground"
            }`}
          >
            {dirty ? "Unsaved changes" : "Saved"}
          </span>

          <div className="flex items-center gap-1" aria-label="Canvas utilities">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canUndo}
              aria-label="Undo"
              title="Undo (⌘Z / Ctrl+Z)"
              onClick={undo}
            >
              <Undo2 className="size-3.5" aria-hidden="true" />
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canRedo}
              aria-label="Redo"
              title="Redo (⇧⌘Z / Ctrl+Shift+Z)"
              onClick={redo}
            >
              <Redo2 className="size-3.5" aria-hidden="true" />
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                pushHistory();
                applyLayout(autoLayout(graph));
                // Rearranging can make the graph wider than the pane, which would leave nodes
                // off-screen with no indication that anything happened.
                fitSoon();
              }}
              // The caveat below is the real content; `title` only mirrors it for a mouse user
              // on hover. It must not be the only carrier — a keyboard user never sees a
              // tooltip, and "this discards your hand-placed layout" is not a detail they can
              // afford to miss.
              aria-describedby="auto-arrange-note"
              title="Rearrange the canvas and fit it to the view. Layout is stored in this browser only. Undo with ⌘Z."
            >
              <RotateCcw className="mr-1.5 size-3.5" aria-hidden="true" />
              Auto-arrange
            </Button>
            <span id="auto-arrange-note" className="sr-only">
              Replaces the current node positions with a generated layout and fits it to the view.
              Layout is stored in this browser only. Undo with Command or Control Z.
            </span>
          </div>

          <span aria-hidden="true" className="h-5 w-px bg-border" />

          {/*
            `aria-describedby` is attached only while the control is actually disabled.

            The readiness sentence explains the save → verify → run ordering, which is the reason
            a control is unavailable — genuinely useful on a disabled button, and pure repetition
            on an enabled one. Attached unconditionally to all three, tabbing the cluster read the
            same sentence out three times in a row before the operator reached anything.
          */}
          <Button
            type="button"
            size="sm"
            disabled={saving || blocking || !dirty}
            aria-describedby={saving || blocking || !dirty ? "workflow-readiness" : undefined}
            onClick={submit}
          >
            <Save className="mr-1.5 size-3.5" aria-hidden="true" />
            {saving ? "Saving…" : "Save"}
          </Button>

          {/*
            Atlas validates a *stored* workflow: it looks the row up by id before checking the
            candidate, and the checks only it can do — worker and workspace references — are
            resolved against its own tables. So this genuinely cannot run before a first save,
            and the title says so rather than leaving a button that would 404.
          */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!onValidateWithAtlas || validating || blocking || dirty}
            aria-describedby={
              !onValidateWithAtlas || validating || blocking || dirty
                ? "workflow-readiness"
                : undefined
            }
            onClick={() => onValidateWithAtlas?.({ graph: current.graph, policy: current.policy })}
          >
            {validating ? "Checking…" : "Check against Atlas"}
          </Button>

          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!onRun || running || blocking || dirty}
            aria-describedby={
              !onRun || running || blocking || dirty ? "workflow-readiness" : undefined
            }
            onClick={() => onRun?.()}
          >
            <Play className="mr-1.5 size-3.5" aria-hidden="true" />
            {running ? "Starting…" : "Run live test"}
          </Button>
        </div>
        <p id="workflow-readiness" className="basis-full text-xs text-muted-foreground">
          {readiness}
        </p>
      </div>

      {/*
        The canvas floor. `70vh` on a phone is enough to read a graph and still see that the
        toolbar continues above it; from `md` up this reverts to ordinary flex sizing.
      */}
      <div className="flex min-h-[70vh] flex-1 md:min-h-0">
        {paletteCollapsed ? (
          /*
          Collapsed rail: the canvas gains the panel's width, but the panel's one
          load-bearing signal — outstanding check issues — stays visible as a count
          (icon + number + label, never colour alone) that expands the panel on click.
        */
          <aside className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-border bg-card py-3">
            <button
              type="button"
              onClick={togglePalette}
              aria-expanded={false}
              aria-label="Expand the node panel"
              title="Expand the node panel"
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            >
              <PanelLeftOpen className="size-4" aria-hidden="true" />
            </button>
            {issues.length > 0 ? (
              <button
                type="button"
                onClick={togglePalette}
                aria-label={`${issues.length} check ${issues.length === 1 ? "issue" : "issues"} — expand the node panel to review`}
                title={`${issues.length} check ${issues.length === 1 ? "issue" : "issues"}`}
                className="flex flex-col items-center gap-0.5 rounded-md border border-destructive/40 bg-destructive/10 px-1 py-1.5 text-destructive transition-colors hover:bg-destructive/20 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
              >
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                <span className="font-mono text-[10px] leading-none">{issues.length}</span>
              </button>
            ) : null}
          </aside>
        ) : (
          <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
            <div className="border-b border-border px-4 py-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Add a node
                </h3>
                <button
                  type="button"
                  onClick={togglePalette}
                  aria-expanded={true}
                  aria-label="Collapse the node panel"
                  title="Collapse the node panel"
                  className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <PanelLeftClose className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <div className="space-y-1.5">
                {PALETTE_ORDER.map((kind) => {
                  const presentation = NODE_PRESENTATION[kind];
                  const Icon = presentation.icon;
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => addNode(kind)}
                      className="flex w-full items-center gap-2.5 rounded-md border border-border px-2 py-2 text-left transition-colors hover:bg-secondary"
                    >
                      <span
                        className={`grid size-7 shrink-0 place-items-center rounded ${presentation.tile}`}
                      >
                        <Icon className="size-3.5" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-foreground">
                          {presentation.label}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {presentation.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {/*
            Naming the four things that are deliberately absent costs three lines and saves an
            operator hunting for a Condition tile that Atlas could never have stored.
          */}
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                Conditions live on edges. Parallel work is several outgoing edges. A loop is a
                back-edge with a guard. Triggers are managed outside the graph.
              </p>
            </div>

            <div className="border-b border-border px-4 py-4">
              <button
                type="button"
                onClick={() => setSelection({ kind: "policy" })}
                className={`w-full rounded-md border px-2 py-2 text-left text-xs font-semibold transition-colors ${
                  selection?.kind === "policy"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-foreground hover:bg-secondary"
                }`}
              >
                Run policy
                {issues.some((issue) => issue.target.kind === "policy") ? (
                  <span className="ml-1.5 text-destructive">
                    <span aria-hidden="true">•</span>
                    <span className="sr-only">has a validation issue</span>
                  </span>
                ) : null}
              </button>
            </div>

            <div className="border-b border-border px-4 py-4">
              <button
                type="button"
                data-testid="open-interface-panel"
                onClick={() => setSelection({ kind: "interface" })}
                className={`w-full rounded-md border px-2 py-2 text-left text-xs font-semibold transition-colors ${
                  selection?.kind === "interface"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-foreground hover:bg-secondary"
                }`}
              >
                Application interface
                {!interfaceBuild.ok ? (
                  <span className="ml-1.5 text-destructive">
                    <span aria-hidden="true">•</span>
                    <span className="sr-only">has a JSON error</span>
                  </span>
                ) : interfaceDraft.mode === "editing" ? (
                  <span className="ml-1.5 font-mono text-[10px] font-normal text-muted-foreground">
                    declared
                  </span>
                ) : interfaceDraft.mode === "unsupported" ? (
                  <span className="ml-1.5 font-mono text-[10px] font-normal text-warning">
                    unsupported
                  </span>
                ) : null}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Checks
              </h3>
              {issues.length === 0 ? (
                <p className="flex items-center gap-1.5 text-xs text-success">
                  <Check className="size-3.5" aria-hidden="true" /> Ready to save
                </p>
              ) : (
                <ul className="space-y-2">
                  {issues.map((issue, index) => (
                    <li key={`${issueKey(issue)}:${index}`}>
                      <button
                        type="button"
                        onClick={() => {
                          const target = issue.target;
                          if (target.kind === "node")
                            setSelection({ kind: "node", id: target.nodeId });
                          else if (target.kind === "edge")
                            setSelection({ kind: "edge", index: target.edgeIndex });
                          else if (target.kind === "policy") setSelection({ kind: "policy" });
                        }}
                        className="w-full text-left text-[11px] leading-snug text-destructive hover:underline"
                      >
                        {issue.target.kind === "node"
                          ? `${issue.target.nodeId}: `
                          : issue.target.kind === "edge"
                            ? `edge ${issue.target.edgeIndex + 1}: `
                            : ""}
                        {issue.message}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {orphans.length > 0 ? (
                <p className="mt-3 flex gap-1.5 text-[11px] leading-snug text-warning">
                  <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    Never reached from the start node: {orphans.join(", ")}. Atlas accepts this, but
                    those nodes will not run.
                  </span>
                </p>
              ) : null}
            </div>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {/*
          Someone else wrote to this workflow while it was open. Said here rather than left for
          the save to discover, so the operator can decide what to do before typing more.
        */}
          {recovery ? (
            <div
              role="status"
              className="flex items-center justify-between gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-warning"
            >
              <span>
                Unsaved semantic edits from this tab are available for this workflow version.
              </span>
              <span className="flex shrink-0 gap-2">
                <Button type="button" size="sm" variant="outline" onClick={restoreDraft}>
                  Restore draft
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={discardDraft}>
                  Discard
                </Button>
              </span>
            </div>
          ) : null}

          {saveError ? (
            <p
              role="alert"
              className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
            >
              {saveError}
            </p>
          ) : null}

          {/*
            The verdict is about the *saved* graph, so it expires the moment the canvas diverges.

            Atlas can only check a stored workflow — which is why the Check button is disabled
            while dirty — so "Atlas accepted this graph" is a statement about a specific version.
            Left up across subsequent edits, it was a green banner vouching for a graph that no
            longer existed, sitting directly above the one that replaced it. Tying it to `dirty`
            is why it needs no dismiss button and no timestamp: it can no longer outlive its
            subject, so there is nothing stale to date or to close.
          */}
          {atlasValidation && !dirty ? (
            <p
              role="status"
              className={`border-b px-4 py-2 text-xs ${
                atlasValidation.ok
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-destructive/40 bg-destructive/10 text-destructive"
              }`}
            >
              {atlasValidation.message}
            </p>
          ) : null}

          <div
            ref={paneRef}
            className="relative min-h-0 flex-1"
            onKeyDown={onCanvasKeyDown}
            tabIndex={-1}
            role="application"
            aria-label="Workflow canvas. Press Tab to move focus between nodes and connections; Enter or Space selects the focused node or connection and opens its inspector; arrow keys nudge a selected node; Delete or Backspace removes the current selection. Draw a connection by dragging from a node's right handle, or use Connect to in the node inspector. Undo with Command or Control Z."
          >
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              // Explicit, though it is also React Flow's default: nodes must stay tabbable so a
              // keyboard user can Tab to one and press Enter/Space to select it (`onCanvasKeyDown`).
              // Edges stay focusable too, for reaching a condition.
              nodesFocusable
              edgesFocusable
              onNodesChange={onNodesChange}
              onConnect={onConnect}
              isValidConnection={(connection) =>
                isConnectionAllowed(graph, connection.source, connection.target)
              }
              onMoveEnd={(_, viewport) => writeViewport(layoutKeyId, graphVersion, viewport)}
              onNodeClick={(_, node) => setSelection({ kind: "node", id: node.id })}
              onEdgeClick={(_, edge) => {
                const index = flowEdges.findIndex((candidate) => candidate.id === edge.id);
                if (index >= 0) setSelection({ kind: "edge", index });
              }}
              onPaneClick={() => setSelection(null)}
              // Deletion belongs to the confirmed path (onCanvasKeyDown → confirmation dialog).
              // React Flow's own delete key would remove the flow node directly — skipping the
              // confirmation, the start-node protection, and the semantic graph update.
              deleteKeyCode={null}
              // Both halves matter. `minZoom` lifts React Flow's 0.5 clamp so a fit can actually
              // frame a wide graph instead of stopping short and leaving nodes off-screen with
              // no indication; `fitViewOptions` caps the other end so a one-node workflow does
              // not open at 2× with a single card filling the pane.
              minZoom={MIN_ZOOM}
              fitView
              fitViewOptions={FIT_VIEW_OPTIONS}
              // Without this React Flow renders its `light` class inside a dark cockpit, and its
              // own chrome keeps light-mode defaults the stylesheet never reaches.
              colorMode="dark"
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
              <Controls showInteractive={false} />
              {/*
                Hidden below `xl`: at 375px it covered a tenth of the visible canvas and sat
                under the Inspector button, costing more space than an overview of a graph you
                can already pan is worth on a phone.
              */}
              <MiniMap
                pannable
                zoomable
                className="!hidden xl:!block"
                nodeColor={(node) => minimapNodeFill(node.data as CanvasNodeData)}
                nodeStrokeWidth={0}
                ariaLabel="Workflow overview. Node colour follows run state while a run is being watched."
              />
            </ReactFlow>

            {graph.nodes.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <p className="flex items-center gap-2 rounded-md border border-dashed border-border bg-card px-4 py-3 text-xs text-muted-foreground">
                  <Plus className="size-3.5" aria-hidden="true" />
                  Add a node from the palette to begin.
                </p>
              </div>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setInspectorOpen(true)}
              className="absolute bottom-4 right-4 z-10 xl:hidden"
            >
              <PanelRightOpen className="mr-1.5 size-3.5" aria-hidden="true" />
              {inspectorTitle}
            </Button>
          </div>
        </div>

        <aside className="hidden w-80 shrink-0 border-l border-border bg-card xl:block">
          {inspectorContent}
        </aside>
      </div>

      <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
        <SheetContent
          side="right"
          className="w-[min(100vw-2rem,24rem)] overflow-y-auto p-0 xl:hidden"
        >
          <SheetHeader className="border-b border-border px-6 py-4 pr-12">
            <SheetTitle>{inspectorTitle}</SheetTitle>
          </SheetHeader>
          {inspectorContent}
        </SheetContent>
      </Sheet>
    </div>
  );
}
