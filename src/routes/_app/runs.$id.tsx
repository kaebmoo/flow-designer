import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader, StatusPill } from "@/components/atlas/page";
import { useAtlas } from "@/lib/atlas-store";
import { CheckCircle2, XCircle, Circle, Loader2, MinusCircle, Download, RotateCcw } from "lucide-react";

export const Route = createFileRoute("/_app/runs/$id")({
  component: RunDetail,
  head: ({ params }) => ({ meta: [{ title: `Run ${params.id} · Atlas Control` }] }),
});

function RunDetail() {
  const { id } = Route.useParams();
  const run = useAtlas((s) => s.runs.find((r) => r.id === id));
  const workflow = useAtlas((s) => (run ? s.workflows.find((w) => w.id === run.workflow_id) : null));

  if (!run || !workflow) {
    return (
      <div className="grid flex-1 place-items-center">
        <div className="text-center">
          <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Run not found</div>
          <Link to="/runs" className="mt-3 inline-block text-sm text-primary hover:underline">← Back to runs</Link>
        </div>
      </div>
    );
  }

  const iconFor = (s: string) => {
    if (s === "success") return <CheckCircle2 className="size-4 text-[var(--color-success)]" />;
    if (s === "failed") return <XCircle className="size-4 text-destructive" />;
    if (s === "running") return <Loader2 className="size-4 animate-spin text-primary" />;
    if (s === "skipped") return <MinusCircle className="size-4 text-muted-foreground" />;
    return <Circle className="size-4 text-muted-foreground" />;
  };

  return (
    <>
      <PageHeader
        title={run.id}
        subtitle={run.workflow_name}
        meta={
          <div className="flex items-center gap-3">
            <StatusPill tone={run.state === "running" ? "primary" : run.state === "success" ? "success" : run.state === "failed" ? "danger" : "warning"}>
              {run.state}
            </StatusPill>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              started {run.started_at} · {(run.duration_ms / 1000).toFixed(1)}s · by {run.triggered_by}
            </span>
          </div>
        }
        actions={
          <div className="flex gap-2">
            <button className="inline-flex items-center gap-1.5 rounded border border-border bg-white/5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider hover:bg-white/10">
              <Download className="size-3.5" /> Export
            </button>
            <button className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-primary hover:bg-primary/20">
              <RotateCcw className="size-3.5" /> Replay
            </button>
            <Link to="/workflows/$id" params={{ id: workflow.id }} className="inline-flex items-center rounded bg-primary px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground">
              Open Workflow
            </Link>
          </div>
        }
      />
      <div className="grid flex-1 min-h-0 grid-cols-[320px_1fr] overflow-hidden">
        {/* Timeline */}
        <aside className="overflow-y-auto border-r border-border bg-card/50 p-6">
          <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Timeline</div>
          <ol className="relative space-y-1 border-l border-border pl-4">
            {workflow.nodes.map((n) => {
              const s = run.node_states[n.id] ?? "queued";
              return (
                <li key={n.id} className="relative -ml-4 flex items-center gap-3 rounded-md py-2 pl-3 pr-2 transition hover:bg-white/5">
                  {iconFor(s)}
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium">{n.label}</div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{n.kind} · {s}</div>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="mt-8 mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Artifacts</div>
          <div className="space-y-2">
            {["report.md", "extract.json", "broadcast.mp3"].map((f) => (
              <div key={f} className="flex items-center justify-between rounded border border-border bg-white/[0.03] px-3 py-2 text-xs">
                <span className="font-mono">{f}</span>
                <button className="text-primary hover:underline">open</button>
              </div>
            ))}
          </div>
        </aside>

        {/* Logs */}
        <section className="flex flex-col overflow-hidden bg-black/40">
          <div className="flex items-center justify-between border-b border-border bg-background/60 px-6 py-3">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Streaming Log</div>
            <div className="flex gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <button className="hover:text-foreground">All</button>
              <button className="hover:text-foreground">Info</button>
              <button className="hover:text-foreground">Warn</button>
              <button className="hover:text-foreground">Error</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-6 font-mono text-[11px] leading-relaxed">
            {run.log.map((l, i) => (
              <div key={i} className="flex gap-4 py-0.5">
                <span className="text-primary shrink-0">{l.ts}</span>
                <span className="text-muted-foreground shrink-0 w-24 truncate">[{l.node}]</span>
                <span className={
                  l.level === "success" ? "text-[var(--color-success)]" :
                  l.level === "error" ? "text-destructive" :
                  l.level === "warn" ? "text-[var(--color-chart-5)]" :
                  "text-foreground/90"
                }>{l.text}</span>
              </div>
            ))}
            {run.state === "running" && (
              <div className="mt-2 flex gap-4 py-0.5 opacity-70">
                <span className="text-primary">…</span>
                <span className="animate-pulse text-muted-foreground">awaiting next event</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}