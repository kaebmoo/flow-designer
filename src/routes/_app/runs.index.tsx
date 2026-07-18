import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader, StatusPill, DataTable } from "@/components/atlas/page";
import { useAtlas } from "@/lib/atlas-store";
import { useState } from "react";

export const Route = createFileRoute("/_app/runs/")({
  component: RunsIndex,
  head: () => ({ meta: [{ title: "Runs · Atlas Control" }] }),
});

function RunsIndex() {
  const runs = useAtlas((s) => s.runs);
  const [filter, setFilter] = useState<"all" | "running" | "success" | "failed" | "paused">("all");
  const filtered = filter === "all" ? runs : runs.filter((r) => r.state === filter);

  return (
    <>
      <PageHeader
        title="Runs"
        subtitle="Every workflow execution — live and historical."
        meta={
          <div className="flex gap-1">
            {(["all", "running", "success", "failed", "paused"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`rounded-full border px-3 py-0.5 font-mono text-[10px] uppercase tracking-widest transition ${filter === f ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-white/[0.03] text-muted-foreground hover:text-foreground"}`}>
                {f}
              </button>
            ))}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <DataTable
          rows={filtered}
          rowKey={(r) => r.id}
          columns={[
            { key: "id", header: "Run", render: (r) => (
              <Link to="/runs/$id" params={{ id: r.id }} className="font-mono text-xs text-primary hover:underline">{r.id}</Link>
            )},
            { key: "workflow_name", header: "Workflow", render: (r) => (
              <Link to="/workflows/$id" params={{ id: r.workflow_id }} className="hover:text-primary">{r.workflow_name}</Link>
            )},
            { key: "triggered_by", header: "Trigger", render: (r) => <span className="font-mono text-xs">{r.triggered_by}</span> },
            { key: "started_at", header: "Started" },
            { key: "duration_ms", header: "Duration", render: (r) => <span className="font-mono text-xs">{(r.duration_ms / 1000).toFixed(1)}s</span> },
            { key: "state", header: "State", render: (r) => (
              <StatusPill tone={r.state === "running" ? "primary" : r.state === "success" ? "success" : r.state === "failed" ? "danger" : r.state === "paused" ? "warning" : "muted"}>
                {r.state}
              </StatusPill>
            )},
          ]}
        />
      </div>
    </>
  );
}