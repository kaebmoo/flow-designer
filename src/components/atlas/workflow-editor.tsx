import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AtlasNode, type AtlasNodeData } from "./workflow-node";
import { NODE_PRESENTATION } from "./workflow-node-presentation";
import { createWorkflowSimulator, type PendingGate } from "./workflow-simulator";
import {
  NODE_KINDS,
  useAtlas,
  type ChoiceOption,
  type Workflow,
  type WorkflowNodeConfig,
  type WorkflowNodeConfigValue,
  type WorkflowNode,
  type WorkflowRun,
  type NodeKind,
} from "./workflow-scaffold-store";
import {
  ArrowLeft,
  Braces,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  GitBranch,
  Link2,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Wrench,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";

const nodeTypes = { atlas: AtlasNode };

const DEFAULT_NODE_CONFIG: Record<NodeKind, WorkflowNodeConfig> = {
  trigger: { mode: "webhook", path: "/api/v1/events", time: "09:00", event_workflow: "" },
  worker: {
    worker: "wrk_01",
    workspace: "thclaws",
    prompt: "Describe the work this node should complete.",
    output: "result",
  },
  condition: {
    expr: "payload.status === 'ready'",
    true_label: "matches",
    false_label: "otherwise",
  },
  decision: {
    question: "Pick how to continue.",
    choices: [
      { id: "choice_a", label: "Option A" },
      { id: "choice_b", label: "Option B" },
    ],
  },
  loop: { collection: "payload.items", limit: "100" },
  fanout: { branches: "2" },
  join: { mode: "all", quorum: "2" },
  approval: {
    approvers: "ops-lead",
    message: "Please review before the workflow continues.",
    timeout_s: "600",
  },
  manager: { prompt: "Review the connected results and choose the next appropriate path." },
};

const configText = (config: WorkflowNodeConfig, key: string, fallback = "") => {
  const value = config[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
};

const configChoices = (config: WorkflowNodeConfig): ChoiceOption[] =>
  Array.isArray(config.choices) ? config.choices : [];

function defaultedConfig(node: WorkflowNode): WorkflowNodeConfig {
  const config = { ...DEFAULT_NODE_CONFIG[node.kind], ...node.config };
  if (node.kind !== "trigger" || configText(node.config, "mode")) return config;
  if (configText(node.config, "cron")) return { ...config, mode: "schedule" };
  if (node.label.toLowerCase().includes("manual")) return { ...config, mode: "manual" };
  return config;
}

function nodeHint(node: WorkflowNode) {
  const config = defaultedConfig(node);
  if (node.kind === "trigger") {
    const mode = configText(config, "mode", "webhook");
    if (mode === "event") return "After another workflow";
    if (mode === "schedule") return `Daily at ${configText(config, "time", "09:00")}`;
    return configText(config, "path", "Manual start");
  }
  if (node.kind === "worker")
    return configText(config, "output")
      ? `Saves ${configText(config, "output")}`
      : configText(config, "workspace", "Worker job");
  if (node.kind === "condition") return configText(config, "expr", "Evaluate expression");
  if (node.kind === "decision") return `${configChoices(config).length} choices for a person`;
  if (node.kind === "approval")
    return configText(config, "approvers")
      ? `For ${configText(config, "approvers")}`
      : "Wait for review";
  if (node.kind === "join")
    return configText(config, "mode")
      ? `Wait for ${configText(config, "mode")}`
      : "Wait for branches";
  if (node.kind === "loop") return configText(config, "collection", "Iterate items");
  if (node.kind === "fanout") return `${configText(config, "branches", "2")} parallel paths`;
  return configText(config, "prompt", "Choose a connected path");
}

function toFlow(wf: Workflow, runStates?: Record<string, AtlasNodeData["runState"]>) {
  const nodes: Node[] = wf.nodes.map((n) => ({
    id: n.id,
    type: "atlas",
    position: { x: n.x, y: n.y },
    data: {
      kind: n.kind,
      label: n.label,
      hint: nodeHint(n),
      config: defaultedConfig(n),
      runState: runStates?.[n.id],
    } satisfies AtlasNodeData,
  }));
  const edges: Edge[] = wf.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    animated: runStates?.[e.source] === "success" && runStates?.[e.target] === "running",
    style: { stroke: "var(--color-primary)", strokeWidth: 2, strokeOpacity: 0.65 },
  }));
  return { nodes, edges };
}

type RunLog = {
  ts: string;
  node: string;
  level: "info" | "success" | "error" | "warn";
  text: string;
};

function RunGate({
  gate,
  onApprove,
  onChoose,
}: {
  gate: PendingGate;
  onApprove: (approved: boolean) => void;
  onChoose: (choiceId: string) => void;
}) {
  if (gate.kind === "approval") {
    return (
      <div className="mb-3 rounded-xl border border-amber-300/35 bg-amber-300/[0.09] p-3 font-sans">
        <div className="flex items-center gap-2 text-xs font-bold text-amber-100">
          <Clock3 className="size-4" /> Approval needed · {gate.title}
        </div>
        <p className="mt-1.5 text-[11px] leading-5 text-[#d3c28a]">{gate.message}</p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => onApprove(false)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2 text-[11px] font-bold text-destructive transition hover:bg-destructive/20"
          >
            <XCircle className="size-3.5" /> Reject
          </button>
          <button
            type="button"
            onClick={() => onApprove(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-bold text-primary-foreground transition hover:brightness-110"
          >
            <CheckCircle2 className="size-3.5" /> Approve
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-xl border border-teal-300/30 bg-teal-300/[0.08] p-3 font-sans">
      <div className="flex items-center gap-2 text-xs font-bold text-teal-100">
        <GitBranch className="size-4" /> Choice needed · {gate.title}
      </div>
      <p className="mt-1.5 text-[11px] leading-5 text-[#b9dedb]">{gate.question}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {gate.choices.map((choice) => (
          <button
            type="button"
            key={choice.id}
            onClick={() => onChoose(choice.id)}
            className="rounded-lg border border-teal-300/25 bg-[#0d1e28] px-3 py-2 text-left text-[11px] font-semibold text-teal-100 transition hover:border-teal-200/70 hover:bg-teal-300/[0.12]"
          >
            {choice.label || "Untitled choice"}
          </button>
        ))}
      </div>
    </div>
  );
}

export function WorkflowEditor({ workflow }: { workflow: Workflow }) {
  const initial = useMemo(() => toFlow(workflow), [workflow]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runStates, setRunStates] = useState<Record<string, AtlasNodeData["runState"]>>({});
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [pendingGate, setPendingGate] = useState<PendingGate | null>(null);
  const simulatorRef = useRef<ReturnType<typeof createWorkflowSimulator> | null>(null);

  const updateWorkflow = useAtlas((s) => s.updateWorkflow);
  const addRun = useAtlas((s) => s.addRun);
  const updateRun = useAtlas((s) => s.updateRun);
  const workers = useAtlas((s) => s.workers);
  const workflows = useAtlas((s) => s.workflows);
  const navigate = useNavigate();

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      onNodesChange(changes);
      if (changes.some((change) => change.type === "position" && change.dragging !== true))
        setDirty(true);
    },
    [onNodesChange],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChange(changes);
      if (changes.some((change) => change.type === "remove")) setDirty(true);
    },
    [onEdgesChange],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = nodes.find((node) => node.id === connection.source);
      const sourceData = source?.data as AtlasNodeData | undefined;
      let label: string | undefined;
      if (sourceData?.kind === "condition") {
        label =
          connection.sourceHandle === "condition:false"
            ? configText(sourceData.config, "false_label", "otherwise")
            : configText(sourceData.config, "true_label", "matches");
      }
      if (sourceData?.kind === "decision" && connection.sourceHandle?.startsWith("choice:")) {
        label = configChoices(sourceData.config).find(
          (choice) => `choice:${choice.id}` === connection.sourceHandle,
        )?.label;
      }
      setEdges((currentEdges) =>
        addEdge(
          {
            ...connection,
            label,
            style: { stroke: "var(--color-primary)", strokeWidth: 2, strokeOpacity: 0.65 },
          },
          currentEdges,
        ),
      );
      setDirty(true);
    },
    [nodes, setEdges],
  );

  const selectedNode = nodes.find((node) => node.id === selected);
  const selectedData = selectedNode?.data as AtlasNodeData | undefined;

  const updateSelected = (patch: Partial<AtlasNodeData>) => {
    if (!selected) return;
    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === selected
          ? { ...node, data: { ...(node.data as AtlasNodeData), ...patch } }
          : node,
      ),
    );
    setDirty(true);
  };

  const updateConfig = (key: string, value: WorkflowNodeConfigValue) => {
    if (!selectedData) return;
    updateSelected({ config: { ...selectedData.config, [key]: value } });
  };

  const updateDecisionChoices = (choices: ChoiceOption[]) => {
    if (!selectedData || selectedData.kind !== "decision" || !selected) return;
    const validHandles = new Set(choices.map((choice) => `choice:${choice.id}`));
    const labelsByHandle = new Map(choices.map((choice) => [`choice:${choice.id}`, choice.label]));
    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === selected
          ? {
              ...node,
              data: {
                ...(node.data as AtlasNodeData),
                config: { ...(node.data as AtlasNodeData).config, choices },
              },
            }
          : node,
      ),
    );
    setEdges((currentEdges) =>
      currentEdges
        .filter(
          (edge) =>
            edge.source !== selected ||
            !edge.sourceHandle?.startsWith("choice:") ||
            validHandles.has(edge.sourceHandle),
        )
        .map((edge) =>
          edge.source === selected && edge.sourceHandle?.startsWith("choice:")
            ? { ...edge, label: labelsByHandle.get(edge.sourceHandle) ?? edge.label }
            : edge,
        ),
    );
    setDirty(true);
  };

  const addNode = (kind: NodeKind) => {
    const id = `n_${Math.random().toString(36).slice(2, 7)}`;
    const newNode: Node = {
      id,
      type: "atlas",
      position: { x: 240 + Math.random() * 280, y: 120 + Math.random() * 280 },
      data: {
        kind,
        label: NODE_KINDS.find((item) => item.kind === kind)?.label ?? kind,
        hint: NODE_PRESENTATION[kind].description,
        config: { ...DEFAULT_NODE_CONFIG[kind] },
      } satisfies AtlasNodeData,
    };
    setNodes((currentNodes) => [...currentNodes, newNode]);
    setSelected(id);
    setDirty(true);
  };

  const removeSelected = () => {
    if (!selected) return;
    setNodes((currentNodes) => currentNodes.filter((node) => node.id !== selected));
    setEdges((currentEdges) =>
      currentEdges.filter((edge) => edge.source !== selected && edge.target !== selected),
    );
    setSelected(null);
    setDirty(true);
  };

  const save = () => {
    updateWorkflow(workflow.id, {
      nodes: nodes.map((node) => {
        const data = node.data as AtlasNodeData;
        return {
          id: node.id,
          kind: data.kind,
          label: data.label,
          x: node.position.x,
          y: node.position.y,
          config: data.config,
        };
      }),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label as string | undefined,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
      })),
    });
    setDirty(false);
  };

  const run = () => {
    simulatorRef.current?.cancel();
    save();
    const id = addRun(workflow.id);
    // `AtlasNodeData["runState"]` is optional, so casting to it makes every value
    // `... | undefined` and the record stops matching `WorkflowRun["node_states"]`, which
    // requires a concrete state per node. A run always starts with every node queued, so
    // strip the undefined rather than widening the run type.
    const initialStates: WorkflowRun["node_states"] = Object.fromEntries(
      nodes.map((node) => [node.id, "queued" as NonNullable<AtlasNodeData["runState"]>]),
    );
    const initialLogs: RunLog[] = [
      {
        ts: new Date().toLocaleTimeString(),
        node: "SYSTEM",
        level: "info",
        text: `Run ${id} started.`,
      },
    ];
    let currentStates = initialStates;
    let currentLogs = initialLogs;
    setRunId(id);
    setDrawerOpen(true);
    setPendingGate(null);
    setLogs(initialLogs);
    setRunStates(initialStates);
    updateRun(id, { node_states: initialStates, log: initialLogs });
    const simulator = createWorkflowSimulator({
      nodes,
      edges,
      onNodeState: (nodeId, state) => {
        currentStates = { ...currentStates, [nodeId]: state };
        setRunStates(currentStates);
        updateRun(id, {
          node_states: currentStates,
          state: state === "waiting" ? "paused" : "running",
        });
      },
      onLog: (nodeId, text, level = "info") => {
        const node = nodes.find((item) => item.id === nodeId);
        currentLogs = [
          ...currentLogs,
          {
            ts: new Date().toLocaleTimeString(),
            node: node ? (node.data as AtlasNodeData).label.toUpperCase() : nodeId,
            level,
            text,
          },
        ];
        setLogs(currentLogs);
        updateRun(id, { log: currentLogs });
      },
      onGate: setPendingGate,
      onFinish: (state) => {
        updateRun(id, { state, node_states: currentStates, log: currentLogs });
      },
    });
    simulatorRef.current = simulator;
    simulator.start();
  };

  useEffect(() => {
    setNodes((currentNodes) =>
      currentNodes.map((node) => ({
        ...node,
        data: { ...(node.data as AtlasNodeData), runState: runStates[node.id] },
      })),
    );
  }, [runStates, setNodes]);

  return (
    <div className="workflow-editor flex h-full min-h-0 flex-col bg-[#0b1420]">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-[#273647] bg-[#101a27]/95 px-5 backdrop-blur">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/workflows"
            aria-label="Back to workflows"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-white/5 hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/15 text-primary">
            <Zap className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold tracking-[-0.01em] text-foreground">
              {workflow.name}
            </h1>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] font-medium text-muted-foreground">
              <span
                className={`inline-flex items-center gap-1 ${workflow.trigger_enabled ? "text-primary" : ""}`}
              >
                <span
                  className={`size-1.5 rounded-full ${workflow.trigger_enabled ? "bg-primary animate-pulse" : "bg-muted-foreground"}`}
                />
                {workflow.trigger_enabled ? "Trigger enabled" : "Trigger disabled"}
              </span>
              <span className="text-[#405369]">•</span>
              <span>{nodes.length} steps</span>
            </div>
          </div>
          {dirty && (
            <span className="hidden rounded-full border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 text-[10px] font-semibold text-amber-200 sm:inline">
              Unsaved changes
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              updateWorkflow(workflow.id, { trigger_enabled: !workflow.trigger_enabled })
            }
            className="hidden items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground transition hover:bg-white/5 hover:text-foreground lg:flex"
          >
            <Zap className="size-3.5" />{" "}
            {workflow.trigger_enabled ? "Disable trigger" : "Enable trigger"}
          </button>
          <button
            type="button"
            className="hidden items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground transition hover:bg-white/5 hover:text-foreground xl:flex"
          >
            <Wrench className="size-3.5" /> Check
          </button>
          <button
            type="button"
            onClick={save}
            className="flex items-center gap-1.5 rounded-lg border border-[#3b4d60] bg-[#172434] px-3.5 py-2 text-xs font-bold text-foreground transition hover:border-[#52677c] hover:bg-[#1c2a3a]"
          >
            <Save className="size-3.5" /> Save
          </button>
          <button
            type="button"
            onClick={run}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground shadow-[0_8px_18px_color-mix(in_oklab,var(--color-primary)_24%,transparent)] transition hover:brightness-110"
          >
            <Play className="size-3.5 fill-current" /> Run
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-[#273647] bg-[#101a27] p-3 lg:flex">
          <div className="px-2 pb-3 pt-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#8193a7]">
            Add a step
          </div>
          <div className="space-y-1">
            {NODE_KINDS.map((kind) => {
              const presentation = NODE_PRESENTATION[kind.kind];
              const Icon = presentation.icon;
              return (
                <button
                  type="button"
                  key={kind.kind}
                  onClick={() => addNode(kind.kind)}
                  className="group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition hover:bg-white/[0.055]"
                >
                  <span
                    className={`grid size-9 shrink-0 place-items-center rounded-lg ${presentation.tile}`}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-foreground">
                      {presentation.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] leading-tight text-muted-foreground">
                      {presentation.description}
                    </span>
                  </span>
                  <Plus className="ml-auto size-3.5 shrink-0 text-[#587087] opacity-0 transition group-hover:opacity-100" />
                </button>
              );
            })}
          </div>
          <div className="mt-auto rounded-xl border border-[#2b3a4a] bg-[#0d1723] p-3 text-[11px] leading-5 text-muted-foreground">
            Select a step to add it, then drag it into place and connect its ports on the canvas.
          </div>
        </aside>

        <div className="relative min-w-0 flex-1 overflow-hidden">
          <ReactFlowProvider>
            <div className="workflow-canvas absolute inset-0">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={handleNodesChange}
                onEdgesChange={handleEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, node) => setSelected(node.id)}
                onPaneClick={() => setSelected(null)}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.24 }}
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{
                  style: { stroke: "var(--color-primary)", strokeWidth: 2, strokeOpacity: 0.65 },
                }}
              >
                <Background gap={22} size={1.2} color="rgba(140, 166, 192, 0.16)" />
                <Controls showInteractive={false} />
                <MiniMap
                  nodeColor={() => "#15cfe2"}
                  maskColor="rgba(6, 12, 20, 0.74)"
                  pannable
                  zoomable
                />
              </ReactFlow>
            </div>
          </ReactFlowProvider>

          <div className="pointer-events-none absolute left-5 top-5 z-10 hidden rounded-full border border-[#34475a] bg-[#101a27]/90 px-3 py-1.5 text-[10px] font-medium text-muted-foreground shadow-lg backdrop-blur xl:block">
            Canvas <span className="mx-1.5 text-[#43586d]">/</span> drag to arrange{" "}
            <span className="mx-1.5 text-[#43586d]">/</span> connect ports to link
          </div>

          {runId && (
            <section
              className={`absolute bottom-0 left-0 right-0 z-20 border-t border-[#2c3d4f] bg-[#0e1825]/98 shadow-[0_-20px_45px_rgba(0,0,0,0.35)] backdrop-blur transition-[height] duration-200 ${drawerOpen ? (pendingGate ? "h-72" : "h-52") : "h-11"}`}
            >
              <header className="flex h-11 items-center justify-between border-b border-[#273647] px-4">
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setDrawerOpen((open) => !open)}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-white/5 hover:text-foreground"
                  >
                    <ChevronRight
                      className={`size-4 transition ${drawerOpen ? "rotate-90" : ""}`}
                    />
                  </button>
                  <div className="flex items-center gap-2 truncate text-xs font-semibold text-foreground">
                    <span className="size-2 animate-pulse rounded-full bg-primary" /> Live run{" "}
                    {runId}
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate({ to: "/runs/$id", params: { id: runId } })}
                    className="hidden text-[10px] font-semibold text-primary hover:underline sm:block"
                  >
                    Open full view
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setRunId(null);
                    setRunStates({});
                    setPendingGate(null);
                    simulatorRef.current?.cancel();
                    simulatorRef.current = null;
                  }}
                  className="rounded-md px-2 py-1 text-[10px] font-semibold text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                >
                  Clear
                </button>
              </header>
              {drawerOpen && (
                <div className="h-[calc(100%-2.75rem)] overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
                  {pendingGate && (
                    <RunGate
                      gate={pendingGate}
                      onApprove={(approved) => simulatorRef.current?.approve(approved)}
                      onChoose={(choiceId) => simulatorRef.current?.choose(choiceId)}
                    />
                  )}
                  {logs.map((log, index) => (
                    <div
                      key={index}
                      className="flex gap-3 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]"
                    >
                      <span className="shrink-0 text-primary">{log.ts}</span>
                      <span className="w-28 shrink-0 truncate text-[#8193a7]">[{log.node}]</span>
                      <span
                        className={
                          log.level === "success"
                            ? "text-[var(--color-success)]"
                            : log.level === "error"
                              ? "text-destructive"
                              : "text-foreground"
                        }
                      >
                        {log.text}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        {selectedNode && selectedData && (
          <NodeInspector
            data={selectedData}
            workers={workers}
            workflows={workflows.filter((item) => item.id !== workflow.id)}
            onClose={() => setSelected(null)}
            onDelete={removeSelected}
            onLabelChange={(label) => updateSelected({ label })}
            onConfigChange={updateConfig}
            onChoicesChange={updateDecisionChoices}
            onSave={save}
          />
        )}
      </div>
    </div>
  );
}

function NodeInspector({
  data,
  workers,
  workflows,
  onClose,
  onDelete,
  onLabelChange,
  onConfigChange,
  onChoicesChange,
  onSave,
}: {
  data: AtlasNodeData;
  workers: { id: string; name: string; status: string }[];
  workflows: { id: string; name: string }[];
  onClose: () => void;
  onDelete: () => void;
  onLabelChange: (label: string) => void;
  onConfigChange: (key: string, value: WorkflowNodeConfigValue) => void;
  onChoicesChange: (choices: ChoiceOption[]) => void;
  onSave: () => void;
}) {
  const presentation = NODE_PRESENTATION[data.kind];
  const Icon = presentation.icon;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const value = (key: string, fallback = "") => configText(data.config, key, fallback);
  const choices = configChoices(data.config);

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-[#273647] bg-[#101a27] shadow-[-16px_0_36px_rgba(0,0,0,0.16)] animate-slide-in-right">
      <header className="flex items-center gap-3 border-b border-[#273647] px-4 py-4">
        <div className={`grid size-9 shrink-0 place-items-center rounded-lg ${presentation.tile}`}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-bold uppercase tracking-[0.14em] text-[#8193a7]">
            {presentation.label}
          </div>
          <div className="mt-0.5 truncate text-sm font-bold text-foreground">Configure step</div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete node"
          className="grid size-8 place-items-center rounded-md text-[#8091a3] transition hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="grid size-8 place-items-center rounded-md text-[#8091a3] transition hover:bg-white/5 hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        <Field label="Step name">
          <input
            value={data.label}
            onChange={(event) => onLabelChange(event.target.value)}
            className="inspector-input"
          />
        </Field>

        {data.kind === "worker" && (
          <>
            <Field label="What should the worker do?">
              <textarea
                value={value("prompt")}
                onChange={(event) => onConfigChange("prompt", event.target.value)}
                rows={5}
                className="inspector-input resize-y leading-relaxed"
                placeholder="Write the task as you would brief a colleague…"
              />
              <p className="inspector-help">
                Use results from an earlier step as variables, for example{" "}
                <code>{"{{ trigger.payload }}"}</code>.
              </p>
            </Field>
            <Field label="Which worker?">
              <select
                value={value("worker", "wrk_01")}
                onChange={(event) => onConfigChange("worker", event.target.value)}
                className="inspector-input"
              >
                <option value="auto">Auto — choose a healthy worker</option>
                {workers.map((worker) => (
                  <option key={worker.id} value={worker.id}>
                    {worker.name} {worker.status === "offline" ? "(offline)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Workspace">
                <input
                  value={value("workspace", "thclaws")}
                  onChange={(event) => onConfigChange("workspace", event.target.value)}
                  className="inspector-input font-mono text-xs"
                />
              </Field>
              <Field label="Save result as">
                <input
                  value={value("output", "result")}
                  onChange={(event) =>
                    onConfigChange("output", event.target.value.replace(/[^a-zA-Z0-9_]/g, "_"))
                  }
                  className="inspector-input font-mono text-xs"
                />
              </Field>
            </div>
            <button
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              className="flex w-full items-center justify-between rounded-lg border border-[#2c3e50] bg-[#0c1622] px-3 py-2.5 text-xs font-semibold text-[#c9d5e1] transition hover:border-[#40556a] hover:bg-[#111e2d]"
            >
              <span className="flex items-center gap-2">
                <Braces className="size-3.5 text-primary" /> Advanced worker settings
              </span>
              <ChevronRight
                className={`size-4 text-muted-foreground transition ${advancedOpen ? "rotate-90" : ""}`}
              />
            </button>
            {advancedOpen && (
              <div className="space-y-3 rounded-xl border border-[#2c3e50] bg-[#0c1622] p-3">
                <Field label="Work budget (minutes)">
                  <input
                    type="number"
                    min="1"
                    value={value("budget_minutes", "15")}
                    onChange={(event) =>
                      onConfigChange("budget_minutes", Number(event.target.value || 0))
                    }
                    className="inspector-input w-28 font-mono text-xs"
                  />
                </Field>
                <button
                  type="button"
                  onClick={() =>
                    onConfigChange("structured_output", data.config.structured_output !== true)
                  }
                  className="flex w-full items-center justify-between text-left"
                >
                  <span>
                    <span className="block text-xs font-semibold text-foreground">
                      Require structured output
                    </span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      Return a JSON-compatible result for the next step.
                    </span>
                  </span>
                  <span
                    className={`relative ml-3 h-5 w-9 shrink-0 rounded-full transition ${data.config.structured_output === true ? "bg-primary" : "bg-[#45596d]"}`}
                  >
                    <span
                      className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition ${data.config.structured_output === true ? "left-4.5" : "left-0.5"}`}
                    />
                  </span>
                </button>
              </div>
            )}
          </>
        )}

        {data.kind === "trigger" && (
          <>
            <Field label="This workflow starts…">
              <div className="space-y-1">
                {[
                  ["webhook", "Webhook", "When another system sends an event", Zap],
                  ["schedule", "Scheduled", "At a set time", Clock3],
                  ["manual", "Manually", "When an operator runs it", Play],
                  ["event", "After another workflow", "When an upstream workflow finishes", Link2],
                ].map(([mode, label, detail, ModeIcon]) => (
                  <RadioChoice
                    key={mode as string}
                    selected={value("mode", "webhook") === mode}
                    label={label as string}
                    detail={detail as string}
                    icon={ModeIcon as typeof Zap}
                    onClick={() => onConfigChange("mode", mode as string)}
                  />
                ))}
              </div>
            </Field>
            {value("mode", "webhook") === "schedule" ? (
              <Field label="Time of day">
                <input
                  type="time"
                  value={value("time", "09:00")}
                  onChange={(event) => onConfigChange("time", event.target.value)}
                  className="inspector-input"
                />
              </Field>
            ) : value("mode", "webhook") === "webhook" ? (
              <Field label="Endpoint path">
                <input
                  value={value("path", "/api/v1/events")}
                  onChange={(event) => onConfigChange("path", event.target.value)}
                  className="inspector-input font-mono text-xs"
                />
              </Field>
            ) : value("mode", "webhook") === "event" ? (
              <Field label="Start after workflow">
                <select
                  value={value("event_workflow")}
                  onChange={(event) => onConfigChange("event_workflow", event.target.value)}
                  className="inspector-input"
                >
                  <option value="">Select a workflow…</option>
                  {workflows.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </option>
                  ))}
                </select>
                <p className="inspector-help">
                  The workflow starts after the selected workflow completes successfully.
                </p>
              </Field>
            ) : (
              <PanelHint>Use the Run button in the editor or API to begin this workflow.</PanelHint>
            )}
          </>
        )}

        {data.kind === "condition" && (
          <>
            <Field label="Expression">
              <input
                value={value("expr")}
                onChange={(event) => onConfigChange("expr", event.target.value)}
                className="inspector-input font-mono text-xs"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Matched path">
                <input
                  value={value("true_label", "matches")}
                  onChange={(event) => onConfigChange("true_label", event.target.value)}
                  className="inspector-input"
                />
              </Field>
              <Field label="Other path">
                <input
                  value={value("false_label", "otherwise")}
                  onChange={(event) => onConfigChange("false_label", event.target.value)}
                  className="inspector-input"
                />
              </Field>
            </div>
            <PanelHint icon={<GitBranch className="size-4 text-primary" />}>
              Connect the named output ports on the right side of this node to route each result.
            </PanelHint>
          </>
        )}

        {data.kind === "decision" && (
          <>
            <Field label="Question for the person">
              <textarea
                value={value("question", "Pick how to continue.")}
                onChange={(event) => onConfigChange("question", event.target.value)}
                rows={3}
                className="inspector-input resize-y leading-relaxed"
              />
            </Field>
            <Field label="Choices">
              <div className="space-y-2">
                {choices.map((choice, index) => (
                  <div
                    key={choice.id}
                    className="flex items-center gap-2 rounded-lg border border-[#2d4053] bg-[#0c1622] p-1.5"
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-teal-300/15 text-[10px] font-bold text-teal-200">
                      {index + 1}
                    </span>
                    <input
                      value={choice.label}
                      onChange={(event) =>
                        onChoicesChange(
                          choices.map((item) =>
                            item.id === choice.id ? { ...item, label: event.target.value } : item,
                          ),
                        )
                      }
                      className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-xs font-medium text-foreground outline-none placeholder:text-muted-foreground"
                      placeholder={`Option ${index + 1}`}
                    />
                    <button
                      type="button"
                      disabled={choices.length <= 2}
                      onClick={() =>
                        onChoicesChange(choices.filter((item) => item.id !== choice.id))
                      }
                      aria-label={`Remove ${choice.label || `choice ${index + 1}`}`}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-[#8ca0b4] transition hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    onChoicesChange([
                      ...choices,
                      {
                        id: `choice_${Math.random().toString(36).slice(2, 8)}`,
                        label: `Option ${choices.length + 1}`,
                      },
                    ])
                  }
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[#4a6176] py-2.5 text-xs font-semibold text-[#a9bac9] transition hover:border-teal-300/60 hover:bg-teal-300/[0.06] hover:text-teal-100"
                >
                  <Plus className="size-3.5" /> Add a choice
                </button>
              </div>
            </Field>
            <PanelHint icon={<GitBranch className="size-4 text-teal-200" />}>
              Each choice becomes its own output port. Connect each port to the next step for that
              path.
            </PanelHint>
          </>
        )}

        {data.kind === "approval" && (
          <>
            <Field label="Message to the approver">
              <textarea
                value={value("message")}
                onChange={(event) => onConfigChange("message", event.target.value)}
                rows={4}
                className="inspector-input resize-y leading-relaxed"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Approvers">
                <input
                  value={value("approvers", "ops-lead")}
                  onChange={(event) => onConfigChange("approvers", event.target.value)}
                  className="inspector-input"
                />
              </Field>
              <Field label="Timeout (seconds)">
                <input
                  value={value("timeout_s", "600")}
                  onChange={(event) => onConfigChange("timeout_s", event.target.value)}
                  className="inspector-input font-mono text-xs"
                />
              </Field>
            </div>
            <PanelHint icon={<ClipboardCheck className="size-4 text-orange-200" />}>
              The run pauses here until an approver accepts or rejects the request.
            </PanelHint>
          </>
        )}

        {data.kind === "join" && (
          <Field label="Continue when…">
            <div className="space-y-1">
              <RadioChoice
                selected={value("mode", "all") === "all"}
                label="All branches finish"
                onClick={() => onConfigChange("mode", "all")}
              />
              <RadioChoice
                selected={value("mode") === "any"}
                label="The first branch finishes"
                onClick={() => onConfigChange("mode", "any")}
              />
              <RadioChoice
                selected={value("mode") === "quorum"}
                label="A set number finish"
                onClick={() => onConfigChange("mode", "quorum")}
              />
            </div>
            {value("mode") === "quorum" && (
              <div className="mt-3 flex items-center gap-3 pl-8">
                <span className="text-xs font-medium text-muted-foreground">How many?</span>
                <input
                  value={value("quorum", "2")}
                  onChange={(event) => onConfigChange("quorum", event.target.value)}
                  className="inspector-input w-20 font-mono text-xs"
                />
              </div>
            )}
          </Field>
        )}

        {data.kind === "fanout" && (
          <>
            <Field label="Parallel paths">
              <input
                value={value("branches", "2")}
                onChange={(event) => onConfigChange("branches", event.target.value)}
                className="inspector-input w-24 font-mono text-xs"
              />
            </Field>
            <PanelHint>
              Connect each branch to a step, then use a Join node when they need to converge.
            </PanelHint>
          </>
        )}

        {data.kind === "loop" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Collection">
              <input
                value={value("collection", "payload.items")}
                onChange={(event) => onConfigChange("collection", event.target.value)}
                className="inspector-input font-mono text-xs"
              />
            </Field>
            <Field label="Maximum items">
              <input
                value={value("limit", "100")}
                onChange={(event) => onConfigChange("limit", event.target.value)}
                className="inspector-input font-mono text-xs"
              />
            </Field>
          </div>
        )}

        {data.kind === "manager" && (
          <>
            <Field label="What should the manager consider?">
              <textarea
                value={value("prompt")}
                onChange={(event) => onConfigChange("prompt", event.target.value)}
                rows={5}
                className="inspector-input resize-y leading-relaxed"
              />
            </Field>
            <PanelHint icon={<Sparkles className="size-4 text-primary" />}>
              The manager can choose only among the steps you have connected to it.
            </PanelHint>
          </>
        )}
      </div>

      <footer className="flex gap-2 border-t border-[#273647] p-4">
        <button
          type="button"
          onClick={onDelete}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-destructive/45 bg-destructive/10 py-2.5 text-xs font-bold text-destructive transition hover:bg-destructive/20"
        >
          <Trash2 className="size-3.5" /> Delete
        </button>
        <button
          type="button"
          onClick={onSave}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary py-2.5 text-xs font-bold text-primary-foreground transition hover:brightness-110"
        >
          <Check className="size-3.5" /> Save changes
        </button>
      </footer>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-semibold text-[#d6e0ea]">{label}</span>
      {children}
    </label>
  );
}

function RadioChoice({
  selected,
  label,
  detail,
  icon: Icon,
  onClick,
}: {
  selected: boolean;
  label: string;
  detail?: string;
  icon?: typeof Zap;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${selected ? "bg-primary/10" : "hover:bg-white/[0.045]"}`}
    >
      <span
        className={`grid size-4 shrink-0 place-items-center rounded-full border-2 ${selected ? "border-primary" : "border-[#71859a]"}`}
      >
        {selected && <span className="size-1.5 rounded-full bg-primary" />}
      </span>
      {Icon && <Icon className="size-3.5 shrink-0 text-[#8ca0b4]" />}
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        {detail && <span className="mt-0.5 block text-[10px] text-muted-foreground">{detail}</span>}
      </span>
    </button>
  );
}

function PanelHint({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-[#2c3e50] bg-[#0c1622] p-3 text-[11px] leading-5 text-muted-foreground">
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <span>{children}</span>
    </div>
  );
}
