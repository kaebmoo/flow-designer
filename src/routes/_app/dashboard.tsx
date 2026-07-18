import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader, StatusPill } from "@/components/atlas/page";
import { useAtlas } from "@/lib/atlas-store";
import { Plus, Play, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/_app/dashboard")({
  component: DashboardPage,
  head: () => ({ meta: [{ title: "Dashboard · Atlas Control" }] }),
});

function Metric({ label, value, hint, tone = "primary" }: { label: string; value: string; hint: string; tone?: "primary" | "success" | "warning" | "danger" }) {
  const toneCls = { primary: "text-primary", success: "text-[var(--color-success)]", warning: "text-accent", danger: "text-destructive" }[tone];
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`mt-2 text-3xl font-bold tabular-nums ${toneCls}`}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

function DashboardPage() {
  const workers = useAtlas((s) => s.workers);
  const runs = useAtlas((s) => s.runs);
  const workflows = useAtlas((s) => s.workflows);
  const online = workers.filter((w) => w.status === "online").length;
  const active = runs.filter((r) => r.state === "running" || r.state === "paused").length;

  return (
    <>
      <PageHeader
        title="Mission Control"
        subtitle="Live view of your worker fleet, active runs, and recent activity."
        actions={
          <Link to="/workflows" className="inline-flex items-center gap-2 rounded bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground shadow-[0_0_15px_color-mix(in_oklab,var(--color-primary)_25%,transparent)] transition hover:opacity-90">
            <Plus className="size-4" /> New Workflow
          </Link>
        }
      />

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="grid gap-4 md:grid-cols-4">
          <Metric label="Workers Online" value={`${online}/${workers.length}`} hint="Fleet health nominal" tone="success" />
          <Metric label="Active Runs" value={String(active)} hint="Includes paused approvals" />
          <Metric label="Workflows" value={String(workflows.filter((w) => w.status === "active").length)} hint={`${workflows.length} total defined`} />
          <Metric label="Success · 24h" value="98.1%" hint="214 runs · 4 failed" tone="success" />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          <section className="lg:col-span-2 rounded-lg border border-border bg-card">
            <header className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-bold uppercase tracking-wider">Active Runs</h2>
              <Link to="/runs" className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-primary hover:opacity-80">
                View all <ArrowRight className="size-3" />
              </Link>
            </header>
            <ul className="divide-y divide-border">
              {runs.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <Link to="/runs/$id" params={{ id: r.id }} className="flex items-center justify-between px-5 py-3 transition hover:bg-white/[0.03]">
                    <div className="flex items-center gap-4">
                      <StatusPill tone={r.state === "running" ? "primary" : r.state === "success" ? "success" : r.state === "failed" ? "danger" : r.state === "paused" ? "warning" : "muted"}>{r.state}</StatusPill>
                      <div>
                        <div className="text-sm font-medium">{r.workflow_name}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{r.id} · {r.triggered_by} · {r.started_at}</div>
                      </div>
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{(r.duration_ms / 1000).toFixed(1)}s</div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-lg border border-border bg-card">
            <header className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-bold uppercase tracking-wider">Fleet</h2>
              <Link to="/fleet" className="font-mono text-[10px] uppercase tracking-widest text-primary hover:opacity-80">Manage</Link>
            </header>
            <ul className="divide-y divide-border">
              {workers.slice(0, 5).map((w) => (
                <li key={w.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <div className="text-sm font-medium">{w.name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{w.role} · {w.last_seen}</div>
                  </div>
                  <StatusPill tone={w.status === "online" ? "success" : w.status === "degraded" ? "warning" : "danger"}>{w.status}</StatusPill>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="mt-8 rounded-lg border border-border bg-card">
          <header className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="text-sm font-bold uppercase tracking-wider">Workflows</h2>
            <Link to="/workflows" className="font-mono text-[10px] uppercase tracking-widest text-primary hover:opacity-80">All workflows</Link>
          </header>
          <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
            {workflows.map((w) => (
              <Link key={w.id} to="/workflows/$id" params={{ id: w.id }} className="group rounded-lg border border-border bg-background/50 p-4 transition hover:border-primary/40">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-bold">{w.name}</div>
                  <StatusPill tone={w.status === "active" ? "success" : w.status === "draft" ? "muted" : "warning"}>{w.status}</StatusPill>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{w.description}</div>
                <div className="mt-4 flex items-center gap-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  <span>{w.nodes.length} nodes</span>
                  <span>{w.runs_24h} runs / 24h</span>
                  <span className="ml-auto flex items-center gap-1 text-primary opacity-0 transition group-hover:opacity-100"><Play className="size-3" /> Open</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}