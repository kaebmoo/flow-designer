import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PageHeader, StatusPill } from "@/components/atlas/page";
import { useAtlas } from "@/lib/atlas-store";
import { Plus, Trash2, Play, FileText } from "lucide-react";

export const Route = createFileRoute("/_app/workflows/")({
  component: WorkflowsIndex,
  head: () => ({ meta: [{ title: "Workflows · Atlas Control" }] }),
});

const templates = [
  { name: "Research → Writer", desc: "Two-step chain: research worker, then writer." },
  { name: "Coder → Reviewer", desc: "Coder proposes patch, reviewer signs off." },
  { name: "Webhook Ingest", desc: "Accept POST, route by payload, fan out to workers." },
  { name: "Daily Digest (cron)", desc: "Scheduled digest with return-path webhook." },
];

function WorkflowsIndex() {
  const workflows = useAtlas((s) => s.workflows);
  const addWorkflow = useAtlas((s) => s.addWorkflow);
  const removeWorkflow = useAtlas((s) => s.removeWorkflow);
  const navigate = useNavigate();

  const create = () => {
    const id = `wf_${Math.random().toString(36).slice(2, 8)}`;
    addWorkflow({
      id, name: "Untitled Workflow", description: "New workflow", status: "draft",
      updated_at: "just now", runs_24h: 0, success_rate: 0, trigger_enabled: false,
      nodes: [{ id: "n1", kind: "trigger", label: "Manual Trigger", x: 60, y: 200, config: {} }],
      edges: [],
    });
    navigate({ to: "/workflows/$id", params: { id } });
  };

  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="Design and orchestrate multi-worker automations."
        actions={
          <button onClick={create} className="inline-flex items-center gap-2 rounded bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground hover:opacity-90">
            <Plus className="size-4" /> New Workflow
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mb-8">
          <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Templates</div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {templates.map((t) => (
              <button key={t.name} onClick={create} className="rounded-lg border border-dashed border-border bg-white/[0.02] p-4 text-left transition hover:border-primary/40 hover:bg-primary/5">
                <FileText className="size-4 text-primary" />
                <div className="mt-3 text-sm font-bold">{t.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">{t.desc}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Your workflows</div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {workflows.map((w) => (
            <div key={w.id} className="group flex flex-col rounded-lg border border-border bg-card p-5 transition hover:border-primary/40">
              <div className="flex items-start justify-between gap-3">
                <Link to="/workflows/$id" params={{ id: w.id }} className="min-w-0 flex-1">
                  <div className="truncate text-base font-bold">{w.name}</div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{w.description}</div>
                </Link>
                <StatusPill tone={w.status === "active" ? "success" : w.status === "draft" ? "muted" : "warning"}>{w.status}</StatusPill>
              </div>
              <div className="mt-4 flex items-center gap-4 border-t border-border pt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <span>{w.nodes.length} nodes</span>
                <span>{w.runs_24h} runs/24h</span>
                <span>{w.success_rate.toFixed(1)}% ok</span>
                <div className="ml-auto flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
                  <Link to="/workflows/$id" params={{ id: w.id }} className="rounded border border-primary/30 bg-primary/10 px-2 py-1 text-primary">
                    <Play className="size-3" />
                  </Link>
                  <button onClick={() => removeWorkflow(w.id)} className="rounded border border-border bg-white/5 px-2 py-1 hover:text-destructive">
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}