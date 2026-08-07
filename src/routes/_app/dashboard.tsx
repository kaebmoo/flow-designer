import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  type LucideIcon,
  Play,
  ShieldAlert,
  Workflow,
  XCircle,
} from "lucide-react";
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

type MetricTone = "primary" | "success" | "warning" | "danger" | "neutral";

// Each tone pairs its hue with a distinct icon SHAPE so well/degraded reads without colour
// (Never-Colour-Alone). Cyan (`primary`) is rationed to the one live signal — active runs — and
// carries the Activity glyph; static counts default to `neutral` (foreground, no tint).
const METRIC_TONE: Record<MetricTone, { text: string; Icon: LucideIcon | null }> = {
  primary: { text: "text-primary", Icon: Activity },
  success: { text: "text-success", Icon: CheckCircle2 },
  warning: { text: "text-accent", Icon: AlertTriangle },
  danger: { text: "text-destructive", Icon: XCircle },
  neutral: { text: "text-foreground", Icon: null },
};

function Metric({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: MetricTone;
}) {
  const { text, Icon } = METRIC_TONE[tone];
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {label}
        </div>
        {Icon ? <Icon aria-hidden className={`size-4 shrink-0 ${text}`} /> : null}
      </div>
      <div className={`mt-2 text-3xl font-bold tabular-nums ${text}`}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

// Chart series tokens (chart-1..5), used by the distribution bars/legends below. Static class
// strings so Tailwind emits them; index maps series → token deterministically.
const CHART_BG = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"] as const;

/**
 * Compact distribution: a token-coloured segmented bar plus a legend. The bar is decorative
 * (aria-hidden); the legend carries every series as swatch + state token + count, so meaning
 * never rides on colour alone and the machine state tokens stay in JetBrains Mono.
 */
function Distribution({
  title,
  data,
}: {
  title: string;
  data: Array<{ state: string; count: number }>;
}) {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {title}
        </div>
        <div className="font-mono text-[10px] tabular-nums text-muted-foreground">{total}</div>
      </div>
      {total === 0 ? (
        <div className="mt-3 text-xs text-muted-foreground">No data reported by Atlas.</div>
      ) : (
        <>
          <div
            aria-hidden
            className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-secondary/40"
          >
            {data.map((d, i) => (
              <div
                key={d.state}
                className={CHART_BG[i % CHART_BG.length]}
                style={{ width: `${(d.count / total) * 100}%` }}
              />
            ))}
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
            {data.map((d, i) => (
              <li key={d.state} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`size-2 shrink-0 rounded-full ${CHART_BG[i % CHART_BG.length]}`}
                />
                <span className="truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  {d.state}
                </span>
                <span className="ml-auto font-mono text-[10px] tabular-nums text-foreground">
                  {d.count}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
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
      <div className="mt-1 text-xs text-muted-foreground">Loading…</div>
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

  // Actionable state, elevated above the neutral counts below. Failures are the run states the
  // design paints red/attention; approvals are Atlas's own pending-gate count.
  const approvals = m?.approvalsPending ?? 0;
  const failures = m
    ? m.runsByState
        .filter((d) => ["failed", "interrupted", "recovery_required"].includes(d.state))
        .reduce((sum, d) => sum + d.count, 0)
    : 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Live view of workers, runs, and recent activity."
        // Demoted to a secondary/outline link: it only navigates to the workflow list (which the
        // sidebar already offers), so it must not wear the cyan primary glow that the design
        // reserves for live status.
        actions={
          <Link
            to="/workflows"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-transparent px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-foreground transition hover:border-accent/50 hover:bg-accent/10 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
          <>
            {m && (approvals > 0 || failures > 0) ? (
              <div className="mb-4 flex flex-col gap-3 sm:flex-row">
                {approvals > 0 ? (
                  <Link
                    to="/runs"
                    className="group flex flex-1 items-center gap-3 rounded-lg border border-accent/40 bg-accent/10 px-5 py-4 transition hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <ShieldAlert aria-hidden className="size-5 shrink-0 text-accent" />
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-accent">
                        {approvals} approval{approvals === 1 ? "" : "s"} pending
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Human gates waiting on a decision
                      </div>
                    </div>
                    <ArrowRight
                      aria-hidden
                      className="ml-auto size-4 shrink-0 text-accent transition group-hover:translate-x-0.5"
                    />
                  </Link>
                ) : null}
                {failures > 0 ? (
                  <Link
                    to="/runs"
                    className="group flex flex-1 items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-5 py-4 transition hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <AlertTriangle aria-hidden className="size-5 shrink-0 text-destructive" />
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-destructive">
                        {failures} run{failures === 1 ? "" : "s"} need attention
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Failed, interrupted, or awaiting recovery
                      </div>
                    </div>
                    <ArrowRight
                      aria-hidden
                      className="ml-auto size-4 shrink-0 text-destructive transition group-hover:translate-x-0.5"
                    />
                  </Link>
                ) : null}
              </div>
            ) : null}
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
                    tone="primary"
                  />
                  <Metric
                    label="Workflows"
                    value={String(m.workflowDefinitions)}
                    hint={`${m.triggersEnabled} trigger${m.triggersEnabled === 1 ? "" : "s"} enabled`}
                    tone="neutral"
                  />
                  <Metric
                    label="Approvals Pending"
                    value={String(m.approvalsPending)}
                    hint={
                      m.approvalsPending > 0
                        ? "Human gates waiting on a decision"
                        : "Nothing waiting"
                    }
                    tone={m.approvalsPending > 0 ? "warning" : "neutral"}
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
          </>
        )}

        {/* Distributions the metrics view already carries: run states and worker status broken
            down with chart-1..5 tokens, each series labelled + counted so no meaning is
            colour-only. If a field is ever empty, the card says so rather than rendering blank. */}
        {m ? (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Distribution title="Runs by state" data={m.runsByState} />
            <Distribution title="Workers by status" data={m.workersByStatus} />
          </div>
        ) : null}

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
                            <div className="font-mono text-[10px] text-muted-foreground">
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
                        <div className="font-mono text-[10px] text-muted-foreground">
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
                      {/* Reveal on hover AND keyboard focus (group-focus-within); on touch/coarse
                          pointers, where hover never fires, keep it faintly but permanently
                          visible so the affordance is never hidden. */}
                      <span className="ml-auto flex items-center gap-1 text-primary opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-70">
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
