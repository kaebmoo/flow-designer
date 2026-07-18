import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/atlas/page";

export const Route = createFileRoute("/_app/audit")({
  component: AuditPage,
  head: () => ({ meta: [{ title: "Audit Log · Atlas Control" }] }),
});

const events = [
  { ts: "14:23:04", actor: "operator_01", action: "workflow.run",     target: "wf_ingest",   level: "info" },
  { ts: "14:20:11", actor: "system",      action: "trigger.fired",    target: "trg_ingest",  level: "info" },
  { ts: "14:12:04", actor: "operator_02", action: "worker.disable",   target: "wrk_04",      level: "warn" },
  { ts: "14:04:22", actor: "operator_01", action: "workflow.update",  target: "wf_research", level: "info" },
  { ts: "13:44:16", actor: "system",      action: "run.failed",       target: "run_00212",   level: "error" },
  { ts: "13:22:00", actor: "operator_01", action: "approval.request", target: "run_00211",   level: "warn" },
];

function AuditPage() {
  return (
    <>
      <PageHeader title="Audit Log" subtitle="Immutable record of operator and system actions." />
      <div className="flex-1 overflow-y-auto bg-black/40 p-6 font-mono text-[11px] leading-relaxed">
        {events.map((e, i) => (
          <div key={i} className="flex gap-4 py-0.5">
            <span className="text-primary shrink-0">{e.ts}</span>
            <span className="w-24 shrink-0 text-muted-foreground">[{e.actor}]</span>
            <span className="w-40 shrink-0 uppercase tracking-widest text-foreground">{e.action}</span>
            <span className="text-muted-foreground">→ {e.target}</span>
            <span className={`ml-auto uppercase tracking-widest ${e.level === "error" ? "text-destructive" : e.level === "warn" ? "text-[var(--color-chart-5)]" : "text-muted-foreground"}`}>{e.level}</span>
          </div>
        ))}
      </div>
    </>
  );
}