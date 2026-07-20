import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Play, Workflow } from "lucide-react";
import type { ReactNode } from "react";

import { PageHeader, StatusPill } from "@/components/atlas/page";
import { AtlasErrorState } from "@/components/atlas/states";
import { metricsQuery, runsQuery, workersQuery, workflowsQuery } from "@/lib/atlas-queries";
import { formatDurationMs, toClientAtlasError } from "@/lib/atlas-mappers";

export const Route = createFileRoute("/_app/dashboard")({
  component: DashboardPage,
  head: () => ({ meta: [{ title: "Dashboard · Atlas Control" }] }),
});

/** How many rows each preview panel asks Atlas for. Each is a window, never a total. */
const PREVIEW_RUNS = 5;
const PREVIEW_WORKFLOWS = 6;
const PREVIEW_WORKERS = 5;

function Metric({
  label,
  value,
  hint,
  tone = "primary",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "primary" | "success" | "warning" | "danger";
}) {
  const toneCls = {
    primary: "text-primary",
    success: "text-[var(--color-success)]",
    warning: "text-accent",
    danger: "text-destructive",
  }[tone];
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`mt-2 text-3xl font-bold tabular-nums ${toneCls}`}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

function MetricSkeleton({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 text-3xl font-bold tabular-nums text-muted-foreground">—</div>
      <div className="mt-1 text-xs text-muted-foreground">Loading from Atlas…</div>
    </div>
  );
}

/**
 * Renders one panel's loading/error state inline.
 *
 * Each panel owns its own query so that, say, an Atlas metrics failure does not blank the run
 * list next to it — an operator watching a degraded Atlas still sees whatever is answering.
 */
function PanelState({
  isPending,
  error,
  onRetry,
  children,
}: {
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (isPending) {
    return (
      <div className="px-5 py-8 text-center font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (error) {
    return <AtlasErrorState error={toClientAtlasError(error)} onRetry={onRetry} />;
  }
  return <>{children}</>;
}

function DashboardPage() {
  const metrics = useQuery(metricsQuery());
  const runs = useQuery(runsQuery({ limit: PREVIEW_RUNS }));
  const workflows = useQuery(workflowsQuery({ limit: PREVIEW_WORKFLOWS }));
  const workers = useQuery(workersQuery());

  const m = metrics.data;

  return (
    <>
      <PageHeader
        title="Mission Control"
        subtitle="Live view of your worker fleet, active runs, and recent activity."
        // Labelled for what it does: a link to the workflow list. Creating a workflow is a
        // mutation and lands in Phase 3, so "New Workflow" promised an action this button has
        // never performed.
        actions={
          <Link
            to="/workflows"
            className="inline-flex items-center gap-2 rounded bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground shadow-[0_0_15px_color-mix(in_oklab,var(--color-primary)_25%,transparent)] transition hover:opacity-90"
          >
            <Workflow className="size-4" /> View Workflows
          </Link>
        }
        meta={
          m ? (
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Atlas {m.atlasVersion} · aggregates as of {m.generatedAt}
            </span>
          ) : null
        }
      />

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/*
          Headline numbers come from `GET /api/metrics`, which Atlas computes with COUNT(*)
          over the whole table. They are deliberately not derived from the preview lists
          below: those are bounded windows, and counting them would present a page total as a
          fleet total.
        */}
        {metrics.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(metrics.error)}
            onRetry={() => metrics.refetch()}
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-4">
            {m ? (
              <>
                <Metric
                  label="Workers Online"
                  value={`${m.workersOnline}/${m.workersTotal}`}
                  hint={
                    m.workersTotal === 0
                      ? "No workers registered"
                      : "Online or healthy at last poll"
                  }
                  tone={m.workersOnline > 0 ? "success" : "warning"}
                />
                <Metric
                  label="Active Runs"
                  value={String(m.runsActive)}
                  hint={`${m.runsTotal} runs recorded in total`}
                />
                <Metric
                  label="Workflows"
                  value={String(m.workflowDefinitions)}
                  hint={`${m.triggersEnabled} trigger${m.triggersEnabled === 1 ? "" : "s"} enabled`}
                />
                <Metric
                  label="Approvals Pending"
                  value={String(m.approvalsPending)}
                  hint={
                    m.approvalsPending > 0 ? "Human gates waiting on a decision" : "Nothing waiting"
                  }
                  tone={m.approvalsPending > 0 ? "warning" : "primary"}
                />
              </>
            ) : (
              <>
                <MetricSkeleton label="Workers Online" />
                <MetricSkeleton label="Active Runs" />
                <MetricSkeleton label="Workflows" />
                <MetricSkeleton label="Approvals Pending" />
              </>
            )}
          </div>
        )}

        {/*
          Atlas exposes no windowed success rate to a `read` role: the only time-bounded
          aggregate is `/api/usage`, which requires `audit.read`. Rather than compute a
          "24h success rate" from a handful of visible rows and present it as a fleet metric,
          the card is absent and the limitation is stated. See docs/ATLAS_LIMITATIONS.md.
        */}
        {m ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Counts are Atlas lifetime totals. Atlas provides no 24-hour success-rate aggregate to
            this role, so none is shown.
          </p>
        ) : null}

        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          <section className="lg:col-span-2 rounded-lg border border-border bg-card">
            <header className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-bold uppercase tracking-wider">Recent Runs</h2>
              <Link
                to="/runs"
                className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-primary hover:opacity-80"
              >
                View all <ArrowRight className="size-3" />
              </Link>
            </header>
            <PanelState
              isPending={runs.isPending}
              error={runs.error}
              onRetry={() => void runs.refetch()}
            >
              {runs.data?.items.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                  No workflow runs recorded yet.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {runs.data?.items.map((r) => (
                    <li key={r.id}>
                      <Link
                        to="/runs/$id"
                        params={{ id: r.id }}
                        className="flex items-center justify-between px-5 py-3 transition hover:bg-secondary/40"
                      >
                        <div className="flex items-center gap-4">
                          <StatusPill tone={r.state.tone}>{r.state.label}</StatusPill>
                          <div>
                            <div className="text-sm font-medium">{r.name}</div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              {r.id} · started {r.startedAt}
                            </div>
                          </div>
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {formatDurationMs(r.durationMs)}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </PanelState>
          </section>

          <section className="rounded-lg border border-border bg-card">
            <header className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-bold uppercase tracking-wider">Fleet</h2>
              <Link
                to="/fleet"
                className="font-mono text-[10px] uppercase tracking-widest text-primary hover:opacity-80"
              >
                Manage
              </Link>
            </header>
            <PanelState
              isPending={workers.isPending}
              error={workers.error}
              onRetry={() => void workers.refetch()}
            >
              {workers.data?.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                  No workers registered in Atlas.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {workers.data?.slice(0, PREVIEW_WORKERS).map((w) => (
                    <li key={w.id} className="flex items-center justify-between px-5 py-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{w.name}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {w.role || "no role"} · seen {w.lastSeenAt}
                        </div>
                      </div>
                      <StatusPill tone={w.status.tone}>{w.status.label}</StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </PanelState>
          </section>
        </div>

        <section className="mt-8 rounded-lg border border-border bg-card">
          <header className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="text-sm font-bold uppercase tracking-wider">Workflows</h2>
            <Link
              to="/workflows"
              className="font-mono text-[10px] uppercase tracking-widest text-primary hover:opacity-80"
            >
              All workflows
            </Link>
          </header>
          <PanelState
            isPending={workflows.isPending}
            error={workflows.error}
            onRetry={() => void workflows.refetch()}
          >
            {workflows.data?.items.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                No workflow definitions in Atlas yet.
              </div>
            ) : (
              <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
                {workflows.data?.items.map((w) => (
                  <Link
                    key={w.id}
                    to="/workflows/$id"
                    params={{ id: w.id }}
                    className="group rounded-lg border border-border bg-background/50 p-4 transition hover:border-primary/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm font-bold">{w.name}</div>
                      <StatusPill tone={w.status.tone}>{w.status.label}</StatusPill>
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {w.description || "No description."}
                    </div>
                    <div className="mt-4 flex items-center gap-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      <span>{w.nodeCount} nodes</span>
                      <span>v{w.version}</span>
                      <span className="ml-auto flex items-center gap-1 text-primary opacity-0 transition group-hover:opacity-100">
                        <Play className="size-3" /> Open
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </PanelState>
        </section>
      </div>
    </>
  );
}
