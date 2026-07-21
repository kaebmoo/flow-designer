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
import { AlertTriangle, Check, Play, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
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
  autoLayout,
  clearLayout,
  readLayout,
  readViewport,
  renameInLayout,
  resolveLayout,
  writeLayout,
  writeViewport,
  type WorkflowLayout,
} from "./workflow-layout";
import {
  clearSemanticWorkflowDraft,
  readSemanticWorkflowDraft,
  writeSemanticWorkflowDraft,
} from "./workflow-draft";
import { type WorkflowDefaultReply } from "./workflow-inspector";
import { NODE_PRESENTATION, PALETTE_ORDER } from "./workflow-node-presentation";
import { WorkflowCanvasNode, type CanvasNodeData } from "./workflow-node";

const nodeTypes: NodeTypes = { atlas: WorkflowCanvasNode };

type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; index: number }
  | { kind: "policy" }
  | null;

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
      return `chooses among ${outgoing} path(s)`;
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
        ? `${node.choices.length} choice(s)${parallel}`
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

export interface WorkflowDraft {
  name: string;
  description: string;
  graph: Record<string, unknown>;
  policy: Record<string, unknown>;
  defaultReply: WorkflowDefaultReply;
  expectedVersion: number;
}

export interface WorkflowEditorProps {
  /** Atlas's id, or null while creating a workflow that has not been saved yet. */
  workflowId: string | null;
  /** Keys the local layout alongside the workflow id. */
  graphVersion: number;
  initialName: string;
  initialDescription: string;
  initialGraph: WorkflowGraph;
  initialPolicy: WorkflowPolicy;
  initialDefaultReply: WorkflowDefaultReply;
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
  onSave: (draft: WorkflowDraft) => void;
  /** Validates against Atlas. Absent until the workflow has an id Atlas knows. */
  onValidateWithAtlas?: (draft: {
    graph: Record<string, unknown>;
    policy: Record<string, unknown>;
  }) => void;
  validating?: boolean;
  atlasValidation?: { ok: boolean; message: string } | null;
  /** Starts a real run. Absent while the workflow is unsaved or the role cannot run it. */
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
  initialGraph,
  initialPolicy,
  initialDefaultReply,
  savedAt,
  saveCount,
  runStates,
  saving,
  serverIssues,
  saveError,
  expectedVersionOverride,
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
  const [graph, setGraph] = useState<WorkflowGraph>(initialGraph);
  const [policy, setPolicy] = useState<WorkflowPolicy>(initialPolicy);
  const [defaultReply, setDefaultReply] = useState<WorkflowDefaultReply>(initialDefaultReply);
  const [selection, setSelection] = useState<Selection>(null);
  const [layout, setLayout] = useState<WorkflowLayout>({});
  const [pendingNodeDeletion, setPendingNodeDeletion] = useState<string | null>(null);
  const { fitView, setViewport } = useReactFlow();

  const current = useMemo(
    () => ({
      name,
      description,
      graph: serializeWorkflowGraph(graph),
      policy: serializeWorkflowPolicy(policy),
      defaultReply,
    }),
    [name, description, graph, policy, defaultReply],
  );

  /**
   * Dirty is a comparison against what Atlas holds, not a flag set by an event handler.
   *
   * The scaffold derived its flag from React Flow's `NodeChange` stream, so a drag marked the
   * workflow dirty and a keyboard delete did not — exactly backwards, and the delete case meant
   * losing a node silently. Comparing the bytes that would actually be sent cannot get that
   * wrong: identical payload, nothing to save.
   */
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify({
      name: initialName,
      description: initialDescription,
      graph: serializeWorkflowGraph(initialGraph),
      policy: serializeWorkflowPolicy(initialPolicy),
      defaultReply: initialDefaultReply,
    }),
  );
  const dirty = JSON.stringify(current) !== baseline;
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

  useEffect(() => {
    if (!workflowId || !dirty) return;
    writeSemanticWorkflowDraft(workflowId, {
      version: expectedVersion,
      name,
      description,
      graph: current.graph,
      policy: current.policy,
      defaultReply,
    });
  }, [
    workflowId,
    dirty,
    expectedVersion,
    name,
    description,
    current.graph,
    current.policy,
    defaultReply,
  ]);

  const restoreDraft = () => {
    if (!recovery) return;
    const restoredGraph = parseWorkflowGraph(recovery.graph);
    const restoredPolicy = parseWorkflowPolicy(recovery.policy);
    if (restoredGraph.ok) setGraph(restoredGraph.value);
    if (restoredPolicy.ok) setPolicy(restoredPolicy.value);
    setName(recovery.name);
    setDescription(recovery.description);
    setDefaultReply(recovery.defaultReply);
    setRecovery(undefined);
  };

  const discardDraft = () => {
    if (workflowId) clearSemanticWorkflowDraft(workflowId, graphVersion);
    setRecovery(undefined);
  };

  const submit = () => {
    const draft: WorkflowDraft = {
      name,
      description,
      graph: current.graph,
      policy: current.policy,
      defaultReply,
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
  const fitSoon = useCallback(() => setFitRequest((request) => request + 1), []);

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
    fitSoon();
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
        return {
          ...existing,
          id: node.id,
          type: "atlas",
          position: layout[node.id] ?? existing?.position ?? { x: 0, y: 0 },
          selected: selection?.kind === "node" && selection.id === node.id,
          data: {
            kind: node.type,
            title: nodeTitle(node),
            hint: nodeHint(node, graph),
            isStart: graph.start === node.id,
            hasIssue: issuesByTarget.has(`node:${node.id}`),
            runState: runStates?.[node.id],
          },
        } satisfies Node<CanvasNodeData>;
      });
    });
  }, [graph, layout, selection, issuesByTarget, runStates]);

  useEffect(() => {
    if (fitRequest === 0 || flowNodes.length === 0) return;
    const frame = window.requestAnimationFrame(() => void fitView({ duration: 150 }));
    return () => window.cancelAnimationFrame(frame);
  }, [fitRequest, flowNodes, fitView]);

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
      const id = nextNodeId(graph, kind);
      const next: WorkflowGraph = {
        // The first node becomes the start: a graph without one is invalid, and asking the user
        // to choose when there is exactly one candidate is a step with one possible answer.
        start: graph.nodes.length === 0 ? id : graph.start,
        nodes: [...graph.nodes, newNode(id, kind)],
        edges: graph.edges,
      };
      setGraph(next);
      applyLayout({ ...layout, [id]: autoLayout(next)[id] ?? { x: 0, y: 0 } });
      setSelection({ kind: "node", id });
      // A node placed outside the current pane would otherwise appear not to have been added.
      fitSoon();
    },
    [graph, layout, applyLayout, fitSoon],
  );

  const removeSelection = useCallback(() => {
    if (selection?.kind === "node") {
      setGraph((previous) => removeNode(previous, selection.id));
    } else if (selection?.kind === "edge") {
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
  }, [selection]);

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
    setGraph((previous) => removeNode(previous, pendingNodeDeletion));
    setSelection(null);
    setPendingNodeDeletion(null);
  }, [pendingNodeDeletion]);

  const pendingDeletionNode = pendingNodeDeletion
    ? graph.nodes.find((node) => node.id === pendingNodeDeletion)
    : undefined;
  const pendingDeletionEdges = pendingNodeDeletion
    ? edgesRemovedWithNode(graph, pendingNodeDeletion)
    : [];

  /**
   * Keyboard delete, bound on the canvas rather than the document so it cannot fire while the
   * user is deleting characters in an inspector field.
   */
  const onCanvasKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (selection?.kind !== "node" && selection?.kind !== "edge") return;
      event.preventDefault();
      requestDeleteSelection();
    },
    [selection, requestDeleteSelection],
  );

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
      const edges = [...graph.edges, { from: source, to: target, condition }];
      setGraph({ ...graph, edges });
      setSelection({ kind: "edge", index: edges.length - 1 });
    },
    [graph],
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
      setGraph(result.graph);
      applyLayout(renameInLayout(layout, fromId, toId));
      setSelection({ kind: "node", id: toId });
      return { ok: true };
    },
    [graph, layout, applyLayout],
  );

  const selectedNode =
    selection?.kind === "node" ? graph.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === "edge" ? graph.edges[selection.index] : undefined;

  const blocking = localIssues.length > 0;

  return (
    <div className="flex min-h-0 flex-1">
      <AlertDialog open={navigationBlocker.status === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved workflow changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The graph, its policy, name, and description have changes that are not in Atlas. Node
              positions and zoom are already stored only in this browser.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={() => navigationBlocker.reset?.()}>
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => navigationBlocker.proceed?.()}
            >
              Discard changes
            </Button>
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
            <AlertDialogAction onClick={confirmNodeDeletion}>Delete node</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
        <div className="border-b border-border px-4 py-4">
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Add a node
          </h3>
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
            Conditions live on edges. Parallel work is several outgoing edges. A loop is a back-edge
            with a guard. Triggers are managed outside the graph.
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
                      if (target.kind === "node") setSelection({ kind: "node", id: target.nodeId });
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

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3">
          <Input
            value={name}
            aria-label="Workflow name"
            onChange={(event) => setName(event.target.value)}
            className="h-8 max-w-xs text-sm font-semibold"
          />
          <Textarea
            value={description}
            aria-label="Workflow description"
            rows={1}
            placeholder="Description"
            onChange={(event) => setDescription(event.target.value)}
            className="h-8 min-h-8 max-w-sm resize-none py-1.5 text-xs"
          />

          <div className="ml-auto flex items-center gap-2">
            <span
              data-testid="workflow-dirty-state"
              className={`font-mono text-[10px] uppercase tracking-widest ${
                dirty ? "text-warning" : "text-muted-foreground"
              }`}
            >
              {dirty ? "Unsaved changes" : "Saved"}
            </span>

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                applyLayout(autoLayout(graph));
                // Rearranging can make the graph wider than the pane, which would leave nodes
                // off-screen with no indication that anything happened.
                fitSoon();
              }}
              title="Rearrange the canvas and fit it to the view. Layout is stored in this browser only."
            >
              <RotateCcw className="mr-1.5 size-3.5" aria-hidden="true" />
              Auto-arrange
            </Button>

            <Button
              type="button"
              size="sm"
              disabled={saving || blocking || !dirty}
              title={
                blocking
                  ? "Fix the problems listed on the left first."
                  : !dirty
                    ? "Nothing has changed since the last save."
                    : undefined
              }
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
              title={
                !onValidateWithAtlas
                  ? "Save the workflow first — Atlas validates a stored workflow by id."
                  : dirty
                    ? "Save first; Atlas checks what it has stored."
                    : blocking
                      ? "Fix the problems listed on the left first."
                      : "Checks worker and workspace references against Atlas."
              }
              onClick={() =>
                onValidateWithAtlas?.({ graph: current.graph, policy: current.policy })
              }
            >
              {validating ? "Checking…" : "Check against Atlas"}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!onRun || running || blocking || dirty}
              title={
                !onRun
                  ? (runDisabledReason ?? "Save the workflow before running it.")
                  : dirty
                    ? "Save first — Atlas runs the stored graph, not the one on screen."
                    : blocking
                      ? "Fix the problems listed on the left first."
                      : undefined
              }
              onClick={() => onRun?.()}
            >
              <Play className="mr-1.5 size-3.5" aria-hidden="true" />
              {running ? "Starting…" : "Run"}
            </Button>
          </div>
        </div>

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

        {atlasValidation ? (
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
          className="relative min-h-0 flex-1"
          onKeyDown={onCanvasKeyDown}
          tabIndex={-1}
          role="application"
          aria-label="Workflow canvas"
        >
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
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
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>

          {graph.nodes.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <p className="flex items-center gap-2 rounded-md border border-dashed border-border bg-card px-4 py-3 text-xs text-muted-foreground">
                <Plus className="size-3.5" aria-hidden="true" />
                Add a node from the palette to begin.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <aside className="w-80 shrink-0 border-l border-border bg-card">
        {selectedNode ? (
          <NodeInspector
            node={selectedNode}
            graph={graph}
            issues={issuesByTarget.get(`node:${selectedNode.id}`) ?? []}
            onChange={updateNode}
            onRename={(nextId) => rename(selectedNode.id, nextId)}
            onSetStart={() => setGraph((previous) => ({ ...previous, start: selectedNode.id }))}
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
                edges: previous.edges.map((edge, index) =>
                  index === selection.index ? next : edge,
                ),
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
        ) : (
          <div className="space-y-4 px-4 py-6">
            <p className="text-xs text-muted-foreground">
              Select a node or an edge to edit it. Drawing a connection creates an edge; its
              condition decides whether Atlas takes it.
            </p>
            <div className="rounded-md border border-border px-3 py-2">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Start node
              </p>
              <p className="mt-1 font-mono text-xs text-foreground">{graph.start || "not set"}</p>
            </div>
            <div className="rounded-md border border-border px-3 py-2">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Layout
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Node positions are stored in this browser only — Atlas has no layout endpoint, so
                they do not follow you to another device and nobody else sees them.
              </p>
              <button
                type="button"
                onClick={() => {
                  clearLayout(layoutKeyId, graphVersion);
                  applyLayout(autoLayout(graph));
                  fitSoon();
                }}
                className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                <Trash2 className="size-3" aria-hidden="true" />
                Forget this layout
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
