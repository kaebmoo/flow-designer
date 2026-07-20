import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, StatusPill, DataTable } from "@/components/atlas/page";
import { useAtlas } from "@/lib/atlas-store";
import { useState } from "react";
import { Play, X } from "lucide-react";

export const Route = createFileRoute("/_app/jobs")({
  component: JobsPage,
  head: () => ({ meta: [{ title: "Jobs · Atlas Control" }] }),
});

function JobsPage() {
  const jobs = useAtlas((s) => s.jobs);
  const [filter, setFilter] = useState<"all" | "running" | "success" | "failed" | "queued">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const filtered = filter === "all" ? jobs : jobs.filter((j) => j.state === filter);
  const detail = jobs.find((j) => j.id === selected) ?? null;

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Every worker execution — routed manually or by a workflow."
        actions={
          <button className="inline-flex items-center gap-2 rounded bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground hover:opacity-90">
            <Play className="size-4" /> Run Ad-hoc Job
          </button>
        }
        meta={
          <div className="flex gap-1">
            {(["all", "running", "success", "failed", "queued"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-full border px-3 py-0.5 font-mono text-[10px] uppercase tracking-widest transition ${filter === f ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-white/[0.03] text-muted-foreground hover:text-foreground"}`}
              >
                {f}
              </button>
            ))}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <DataTable
          rows={filtered}
          rowKey={(j) => j.id}
          onRowClick={(j) => setSelected(j.id)}
          columns={[
            {
              key: "id",
              header: "Job",
              render: (j) => <span className="font-mono text-xs text-primary">{j.id}</span>,
            },
            {
              key: "prompt",
              header: "Prompt",
              render: (j) => <span className="line-clamp-1 text-sm">{j.prompt}</span>,
            },
            { key: "worker", header: "Worker" },
            {
              key: "workspace",
              header: "Workspace",
              render: (j) => <span className="font-mono text-xs">{j.workspace}</span>,
            },
            {
              key: "duration_ms",
              header: "Duration",
              render: (j) => (
                <span className="font-mono text-xs">{(j.duration_ms / 1000).toFixed(1)}s</span>
              ),
            },
            {
              key: "tokens",
              header: "Tokens",
              className: "text-right",
              render: (j) => (
                <span className="font-mono text-xs tabular-nums">{j.tokens.toLocaleString()}</span>
              ),
            },
            {
              key: "state",
              header: "State",
              render: (j) => (
                <StatusPill
                  tone={
                    j.state === "running"
                      ? "primary"
                      : j.state === "success"
                        ? "success"
                        : j.state === "failed"
                          ? "danger"
                          : "muted"
                  }
                >
                  {j.state}
                </StatusPill>
              ),
            },
          ]}
        />
      </div>

      {detail && (
        <aside className="fixed right-0 top-0 bottom-0 z-40 w-96 border-l border-border bg-card shadow-2xl animate-slide-in-right">
          <header className="flex items-center justify-between border-b border-border px-6 py-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Job
              </div>
              <h2 className="text-sm font-bold">{detail.id}</h2>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </header>
          <div className="space-y-5 overflow-y-auto p-6 text-sm">
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Prompt
              </div>
              <div className="rounded border border-border bg-background/50 p-3 font-mono text-xs">
                {detail.prompt}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Worker" value={detail.worker} />
              <Field label="Workspace" value={detail.workspace} />
              <Field label="Started" value={detail.started_at} />
              <Field label="Duration" value={`${(detail.duration_ms / 1000).toFixed(1)}s`} />
              <Field label="Session" value={detail.session ?? "—"} />
              <Field label="Tokens" value={detail.tokens.toLocaleString()} />
            </div>
            <div>
              <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Streamed Output
              </div>
              <pre className="max-h-64 overflow-auto rounded border border-border bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-foreground/90">{`> Analyzing payload...\n> Extracted 12 priority signals\n> Draft: "Based on the logs..."\n> Artifact saved: analysis_report.pdf`}</pre>
            </div>
          </div>
        </aside>
      )}
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-background/50 p-2">
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-xs">{value}</div>
    </div>
  );
}
