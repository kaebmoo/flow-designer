import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, useEdgesState, useNodesState, type Connection, type Edge, type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AtlasNode, type AtlasNodeData } from "./workflow-node";
import { NODE_KINDS, useAtlas, type Workflow, type NodeKind } from "@/lib/atlas-store";
import { StatusPill } from "./page";
import {
  Play, Save, Sparkles, Wrench, Zap, ChevronRight, X, Plus, Trash2,
} from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";

const nodeTypes = { atlas: AtlasNode };

function toFlow(wf: Workflow, runStates?: Record<string, AtlasNodeData["runState"]>) {
  const nodes: Node[] = wf.nodes.map((n) => ({
    id: n.id,
    type: "atlas",
    position: { x: n.x, y: n.y },
    data: {
      kind: n.kind,
      label: n.label,
      hint: Object.values(n.config)[0] ?? "",
      runState: runStates?.[n.id],
    } satisfies AtlasNodeData,
  }));
  const edges: Edge[] = wf.edges.map((e) => ({
    id: e.id, source: e.source, target: e.target, label: e.label,
    animated: runStates?.[e.source] === "success" && runStates?.[e.target] === "running",
    style: { stroke: "var(--color-primary)", strokeWidth: 2, strokeOpacity: 0.6 },
  }));
  return { nodes, edges };
}

export function WorkflowEditor({ workflow }: { workflow: Workflow }) {
  const initial = useMemo(() => toFlow(workflow), [workflow.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runStates, setRunStates] = useState<Record<string, AtlasNodeData["runState"]>>({});
  const [logs, setLogs] = useState<Array<{ ts: string; node: string; level: string; text: string }>>([]);
  const [drawerOpen, setDrawerOpen] = useState(true);

  const updateWorkflow = useAtlas((s) => s.updateWorkflow);
  const addRun = useAtlas((s) => s.addRun);
  const workers = useAtlas((s) => s.workers);
  const navigate = useNavigate();

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => addEdge({ ...c, style: { stroke: "var(--color-primary)", strokeWidth: 2, strokeOpacity: 0.6 } }, eds));
  }, [setEdges]);

  const selectedNode = nodes.find((n) => n.id === selected);

  const updateSelected = (patch: Partial<AtlasNodeData>) => {
    if (!selected) return;
    setNodes((ns) => ns.map((n) => (n.id === selected ? { ...n, data: { ...(n.data as AtlasNodeData), ...patch } } : n)));
  };

  const addNode = (kind: NodeKind) => {
    const id = `n_${Math.random().toString(36).slice(2, 7)}`;
    const newNode: Node = {
      id, type: "atlas",
      position: { x: 200 + Math.random() * 400, y: 100 + Math.random() * 200 },
      data: { kind, label: NODE_KINDS.find((k) => k.kind === kind)?.label ?? kind, hint: "" } satisfies AtlasNodeData,
    };
    setNodes((ns) => [...ns, newNode]);
    setSelected(id);
  };

  const removeSelected = () => {
    if (!selected) return;
    setNodes((ns) => ns.filter((n) => n.id !== selected));
    setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected));
    setSelected(null);
  };

  const save = () => {
    updateWorkflow(workflow.id, {
      nodes: nodes.map((n) => ({
        id: n.id,
        kind: (n.data as AtlasNodeData).kind,
        label: (n.data as AtlasNodeData).label,
        x: n.position.x, y: n.position.y,
        config: workflow.nodes.find((wn) => wn.id === n.id)?.config ?? {},
      })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label as string | undefined })),
    });
  };

  const run = () => {
    save();
    const rid = addRun(workflow.id);
    setRunId(rid);
    setDrawerOpen(true);
    setLogs([{ ts: new Date().toLocaleTimeString(), node: "SYSTEM", level: "info", text: `Run ${rid} started.` }]);
    const order = nodes.map((n) => n.id);
    setRunStates(Object.fromEntries(order.map((id, i) => [id, i === 0 ? "running" : "queued"])));
    let i = 0;
    const timer = setInterval(() => {
      i++;
      if (i >= order.length) {
        setRunStates((s) => ({ ...s, [order[order.length - 1]]: "success" }));
        setLogs((l) => [...l, { ts: new Date().toLocaleTimeString(), node: "SYSTEM", level: "success", text: "Run completed successfully." }]);
        clearInterval(timer);
        return;
      }
      const prev = order[i - 1];
      const cur = order[i];
      setRunStates((s) => ({ ...s, [prev]: "success", [cur]: "running" }));
      const n = nodes.find((x) => x.id === cur);
      setLogs((l) => [...l, { ts: new Date().toLocaleTimeString(), node: (n?.data as AtlasNodeData).label.toUpperCase(), level: "info", text: `Executing ${(n?.data as AtlasNodeData).label}...` }]);
    }, 1400);
  };

  // sync run states into node data
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...(n.data as AtlasNodeData), runState: runStates[n.id] } })));
  }, [runStates, setNodes]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/70 px-6 backdrop-blur">
        <div className="flex items-center gap-4">
          <Link to="/workflows" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground">← Workflows</Link>
          <div className="h-4 w-px bg-border" />
          <h1 className="text-sm font-bold uppercase tracking-wide">{workflow.name}</h1>
          <StatusPill tone={workflow.status === "active" ? "primary" : workflow.status === "draft" ? "muted" : "warning"}>
            {workflow.status} {workflow.trigger_enabled && "· trigger on"}
          </StatusPill>
        </div>
        <div className="flex items-center gap-1">
          <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"><Sparkles className="size-3.5" /> Explain</button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"><Wrench className="size-3.5" /> Repair</button>
          <button onClick={() => updateWorkflow(workflow.id, { trigger_enabled: !workflow.trigger_enabled })} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <Zap className="size-3.5" /> {workflow.trigger_enabled ? "Disable trigger" : "Enable trigger"}
          </button>
          <div className="mx-2 h-4 w-px bg-border" />
          <button onClick={save} className="flex items-center gap-1.5 rounded border border-border bg-white/5 px-4 py-1.5 text-xs font-bold uppercase tracking-wider hover:bg-white/10">
            <Save className="size-3.5" /> Save
          </button>
          <button onClick={run} className="flex items-center gap-1.5 rounded bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground shadow-[0_0_15px_color-mix(in_oklab,var(--color-primary)_25%,transparent)] hover:opacity-90">
            <Play className="size-3.5" /> Run
          </button>
        </div>
      </header>

      {/* Canvas + inspector + drawer */}
      <div className="relative flex-1 min-h-0">
        <ReactFlowProvider>
          <div className="atlas-grid absolute inset-0">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, n) => setSelected(n.id)}
              onPaneClick={() => setSelected(null)}
              nodeTypes={nodeTypes}
              fitView
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ style: { stroke: "var(--color-primary)", strokeWidth: 2, strokeOpacity: 0.6 } }}
            >
              <Background gap={24} size={1} color="rgba(255,255,255,0.05)" />
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={() => "var(--color-primary)"}
                maskColor="rgba(0,0,0,0.6)"
                pannable zoomable
              />
            </ReactFlow>
          </div>
        </ReactFlowProvider>

        {/* Palette */}
        <div className="absolute left-4 top-4 z-10 w-14 space-y-1 rounded-xl border border-border bg-card p-1.5 shadow-xl">
          {NODE_KINDS.map((k) => (
            <button
              key={k.kind}
              onClick={() => addNode(k.kind)}
              title={`${k.label} — ${k.hint}`}
              className="grid size-10 place-items-center rounded-lg bg-white/5 text-muted-foreground transition hover:bg-primary/20 hover:text-primary"
            >
              <span className="font-mono text-[10px] font-bold">{k.label[0]}</span>
            </button>
          ))}
        </div>

        {/* Inspector */}
        {selectedNode && (
          <aside className="absolute right-0 top-0 bottom-0 z-20 flex w-80 flex-col border-l border-border bg-card shadow-2xl animate-slide-in-right">
            <header className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Inspector</div>
                <div className="text-sm font-bold">{(selectedNode.data as AtlasNodeData).label}</div>
              </div>
              <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
            </header>
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              <Field label="Node name">
                <input
                  value={(selectedNode.data as AtlasNodeData).label}
                  onChange={(e) => updateSelected({ label: e.target.value })}
                  className="w-full rounded border border-border bg-background/50 px-3 py-2 text-sm outline-none focus:border-primary/50"
                />
              </Field>

              {(selectedNode.data as AtlasNodeData).kind === "worker" && (
                <>
                  <Field label="Worker">
                    <select className="w-full rounded border border-border bg-background/50 px-3 py-2 text-sm outline-none focus:border-primary/50">
                      {workers.map((w) => <option key={w.id}>{w.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Workspace">
                    <input defaultValue="thclaws" className="w-full rounded border border-border bg-background/50 px-3 py-2 font-mono text-xs outline-none focus:border-primary/50" />
                  </Field>
                  <Field label="Prompt">
                    <textarea rows={5} defaultValue="Analyze the following payload and extract priority signals. Context: {{ trigger.payload }}" className="w-full rounded border border-border bg-black/30 p-3 font-mono text-xs outline-none focus:border-primary/50" />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Retry"><input defaultValue="3" className="w-full rounded border border-border bg-background/50 px-2 py-1.5 font-mono text-xs outline-none" /></Field>
                    <Field label="Timeout"><input defaultValue="300s" className="w-full rounded border border-border bg-background/50 px-2 py-1.5 font-mono text-xs outline-none" /></Field>
                  </div>
                </>
              )}

              {(selectedNode.data as AtlasNodeData).kind === "condition" && (
                <Field label="Expression"><input defaultValue="payload.qty > 1000" className="w-full rounded border border-border bg-black/30 px-3 py-2 font-mono text-xs outline-none focus:border-primary/50" /></Field>
              )}

              {(selectedNode.data as AtlasNodeData).kind === "trigger" && (
                <>
                  <Field label="Kind">
                    <select className="w-full rounded border border-border bg-background/50 px-3 py-2 text-sm outline-none focus:border-primary/50">
                      <option>Webhook</option><option>Cron</option><option>Manual</option><option>Internal Event</option>
                    </select>
                  </Field>
                  <Field label="Path / Cron"><input defaultValue="/api/v1/ingest" className="w-full rounded border border-border bg-background/50 px-3 py-2 font-mono text-xs outline-none" /></Field>
                </>
              )}

              {(selectedNode.data as AtlasNodeData).kind === "approval" && (
                <>
                  <Field label="Approvers"><input defaultValue="ops-lead" className="w-full rounded border border-border bg-background/50 px-3 py-2 text-sm outline-none" /></Field>
                  <Field label="Timeout (s)"><input defaultValue="600" className="w-full rounded border border-border bg-background/50 px-3 py-2 font-mono text-xs outline-none" /></Field>
                </>
              )}

              {(selectedNode.data as AtlasNodeData).kind === "join" && (
                <Field label="Join mode">
                  <select className="w-full rounded border border-border bg-background/50 px-3 py-2 text-sm outline-none focus:border-primary/50">
                    <option>all</option><option>any</option><option>quorum</option>
                  </select>
                </Field>
              )}
            </div>
            <footer className="flex gap-2 border-t border-border p-4">
              <button onClick={removeSelected} className="flex flex-1 items-center justify-center gap-1.5 rounded border border-destructive/40 bg-destructive/10 py-2 text-xs font-bold uppercase tracking-widest text-destructive hover:bg-destructive/20">
                <Trash2 className="size-3.5" /> Delete
              </button>
              <button onClick={save} className="flex flex-1 items-center justify-center rounded bg-primary py-2 text-xs font-bold uppercase tracking-widest text-primary-foreground">
                Update
              </button>
            </footer>
          </aside>
        )}

        {/* Run drawer */}
        {runId && (
          <div className={`absolute bottom-0 left-0 z-10 border-t border-border bg-card shadow-[0_-20px_50px_rgba(0,0,0,0.5)] transition-all ${selectedNode ? "right-80" : "right-0"} ${drawerOpen ? "h-56" : "h-10"}`}>
            <header className="flex h-10 items-center justify-between border-b border-border px-5">
              <div className="flex items-center gap-4">
                <button onClick={() => setDrawerOpen((o) => !o)} className="text-muted-foreground hover:text-foreground">
                  <ChevronRight className={`size-4 transition ${drawerOpen ? "rotate-90" : ""}`} />
                </button>
                <span className="font-mono text-[10px] uppercase tracking-widest text-primary">Run {runId} · streaming</span>
                <button onClick={() => navigate({ to: "/runs/$id", params: { id: runId } })} className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground">Open full view →</button>
              </div>
              <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <button className="hover:text-foreground">Timeline</button>
                <button className="hover:text-foreground">Artifacts</button>
                <button onClick={() => { setRunId(null); setRunStates({}); }} className="hover:text-destructive">Clear</button>
              </div>
            </header>
            {drawerOpen && (
              <div className="h-[calc(100%-2.5rem)] overflow-y-auto bg-black/40 p-4 font-mono text-[11px] leading-relaxed">
                {logs.map((l, i) => (
                  <div key={i} className="flex gap-4">
                    <span className="text-primary">{l.ts}</span>
                    <span className="text-muted-foreground">[{l.node}]</span>
                    <span className={l.level === "success" ? "text-[var(--color-success)]" : l.level === "error" ? "text-destructive" : ""}>{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// Silence unused-imports for icons that could be useful later
export const _icons = { Plus };