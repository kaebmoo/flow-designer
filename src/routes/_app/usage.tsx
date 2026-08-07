import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { Download } from "lucide-react";

import type { ReactNode } from "react";

import { DateRangeForm } from "@/components/atlas/date-range";
import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { Button } from "@/components/ui/button";
import { DEFAULT_USAGE_WINDOW_DAYS, defaultUsageFrom, parseDateBoundary } from "@/lib/atlas-dates";
import { toClientAtlasError, type UsageEventView } from "@/lib/atlas-mappers";
import { usageQuery } from "@/lib/atlas-queries";

/** URL input is untrusted: an unusable date falls back to "no bound" instead of crashing. */
function parseDateSearch(value: unknown): string | undefined {
  try {
    return parseDateBoundary(value, "date");
  } catch {
    return undefined;
  }
}

export const Route = createFileRoute("/_app/usage")({
  validateSearch: (search: { from?: string; to?: string } & SearchSchemaInput) => ({
    /** Both pushed down to Atlas — the only parameters `GET /api/usage` accepts. */
    from: parseDateSearch(search.from),
    to: parseDateSearch(search.to),
  }),
  component: UsagePage,
  head: () => ({ meta: [{ title: "Usage · Atlas Control" }] }),
});

/**
 * The rendered table is bounded even though Atlas's response is not.
 *
 * `GET /api/usage` has no limit — the range decides the size — so a wide range can return
 * thousands of rows. Rendering them all would violate the bounded-list rule; the newest slice
 * is shown, the cap is stated, and the CSV export carries the complete range.
 */
const RENDERED_EVENT_CAP = 200;

/** Every integer count on this page gets thousands separators, matching the token totals. */
const int = (n: number) => n.toLocaleString();

/**
 * One cost precision for the whole page. Atlas's per-event estimates are sub-cent, so six
 * fraction digits are needed to render them faithfully; the summary total uses the same scale
 * (plus grouping) rather than the old, inconsistent 4-vs-6 split.
 */
const usd = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 })}`;

/**
 * Map an Atlas run/job state token to a StatusPill tone so the Status column never relies on
 * text alone. Unknown states stay neutral rather than being coloured by guess.
 */
function statusTone(status: string): "primary" | "success" | "warning" | "danger" | "muted" {
  const s = status.toLowerCase();
  if (s === "succeeded" || s === "success" || s === "completed") return "success";
  if (s === "running" || s === "active") return "primary";
  if (s === "waiting_for_human" || s === "waiting" || s === "paused" || s === "pending")
    return "warning";
  if (
    s === "failed" ||
    s === "error" ||
    s === "interrupted" ||
    s === "cancelled" ||
    s === "canceled" ||
    s === "recovery_required"
  )
    return "danger";
  return "muted";
}

/**
 * Atlas's usage/metering ledger — admin/auditor only (`audit.read`).
 *
 * Every figure on this page is Atlas's own: the totals come from Atlas's `summarize_usage`,
 * never re-added from the rows. Atlas meters usage; it does not rate or invoice it. There are
 * no prices, packages, or quotas here because Atlas has none.
 */
function UsagePage() {
  const { from, to } = Route.useSearch();
  const navigate = Route.useNavigate();

  /**
   * The request Atlas actually receives is always bounded by default.
   *
   * `GET /api/usage` has no `limit`, so a bare visit would fetch the entire ledger — every
   * event ever recorded — into this server and the browser on page load. When the URL carries
   * no explicit bound at all, the last 30 days are requested instead; a user who wants a
   * wider window states one deliberately through the form (which then appears in the URL).
   * An explicitly chosen bound, even a one-sided one, is respected as given.
   */
  const bounded = from !== undefined || to !== undefined;
  const effectiveFrom = bounded ? from : defaultUsageFrom();
  const usage = useQuery(usageQuery({ from: effectiveFrom, to }));

  // The export carries the same range the page shows, including the default bound.
  const exportHref = `/api/exports/usage-csv?${[
    effectiveFrom ? `from=${encodeURIComponent(effectiveFrom)}` : "",
    to ? `to=${encodeURIComponent(to)}` : "",
  ]
    .filter(Boolean)
    .join("&")}`;

  return (
    <>
      <PageHeader
        title="Usage & Metering"
        subtitle="Atlas's append-only usage ledger: workflow runs, jobs, tokens, and wall time."
        actions={
          usage.isSuccess ? (
            <Button asChild size="sm" variant="outline">
              {/* Same-origin authenticated download; the bearer never reaches this URL. */}
              <a href={exportHref} download>
                <Download className="size-4" /> Export CSV
              </a>
            </Button>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/* Keyed by the applied range so browser Back/Forward re-seeds the inputs — a form
            showing 1990 above a table showing this month would misreport what is on screen. */}
        <DateRangeForm
          key={`${effectiveFrom ?? ""}|${to ?? ""}`}
          from={effectiveFrom}
          to={to}
          onApply={(next) => void navigate({ search: () => ({ from: next.from, to: next.to }) })}
        />
        {bounded ? null : (
          <p className="-mt-3 mb-6 text-xs text-muted-foreground">
            Defaulting to the last {DEFAULT_USAGE_WINDOW_DAYS} days (from {effectiveFrom}). Atlas
            has no limit on this endpoint, so an unbounded request would return the entire ledger —
            apply a wider range deliberately if you need one.
          </p>
        )}

        {usage.isPending ? (
          <LoadingState label="Loading usage" />
        ) : usage.isError ? (
          // `audit.read` belongs to admin and auditor only; anyone else sees the explicit
          // forbidden state, never fabricated numbers.
          <AtlasErrorState
            error={toClientAtlasError(usage.error)}
            onRetry={() => void usage.refetch()}
          />
        ) : (
          <>
            {/* No trend chart here by design: `GET /api/usage` returns period totals plus a flat
                event ledger — not a per-day/time-bucketed series. Rendering a trend axis would mean
                re-bucketing the raw rows client-side, which contradicts the page's own invariant
                (totals come from Atlas's summarize_usage, never re-derived from the rows) and the
                faithful-window rule. If Atlas later exposes bucketed usage, add the chart then. */}
            <div className="grid gap-4 md:grid-cols-4">
              <TotalCard
                label="Workflow runs"
                value={int(usage.data.totals.workflowRuns)}
                hint={`${int(usage.data.totals.successfulWorkflowRuns)} succeeded`}
              />
              <TotalCard
                label="Jobs"
                value={int(usage.data.totals.jobs)}
                hint={`${usage.data.totals.jobWallSeconds.toFixed(1)}s job wall time`}
              />
              <TotalCard
                label="Budget units"
                value={int(usage.data.totals.budgetUnits)}
                hint={`${usage.data.totals.wallSeconds.toFixed(1)}s run wall time`}
              />
              {/* The one accented headline KPI — cyan hairline + label, kept rare per the One
                  Signal Rule. Prompt/output are split into two labelled values, not a slash-string. */}
              <TotalCard
                label="Tokens"
                accent
                value={
                  <div className="flex items-baseline gap-6">
                    <span className="flex flex-col">
                      <span className="text-2xl font-bold tabular-nums text-foreground">
                        {int(usage.data.totals.tokensPrompt)}
                      </span>
                      <span className="mt-0.5 font-mono text-[10px] font-normal uppercase tracking-widest text-muted-foreground">
                        Prompt
                      </span>
                    </span>
                    <span className="flex flex-col">
                      <span className="text-2xl font-bold tabular-nums text-foreground">
                        {int(usage.data.totals.tokensOutput)}
                      </span>
                      <span className="mt-0.5 font-mono text-[10px] font-normal uppercase tracking-widest text-muted-foreground">
                        Output
                      </span>
                    </span>
                  </div>
                }
                hint="worker-reported"
              />
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              Estimated cost for{" "}
              {bounded ? "this range" : `the default last-${DEFAULT_USAGE_WINDOW_DAYS}-days window`}
              : <span className="font-mono">{usd(usage.data.totals.estimatedCostUsd)} USD</span> — a
              per-event visibility estimate Atlas froze at write time, not a billable charge. Atlas
              meters usage; it does not price, invoice, or enforce quotas.
            </p>

            <section className="mt-8">
              <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Usage events in range
              </h2>
              {usage.data.eventCount === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
                  Atlas recorded no usage events in this date range. Events appear as jobs and
                  workflow runs complete.
                </div>
              ) : (
                <>
                  {/* The shared DataTable wrapper is overflow-hidden, so 8 columns would clip on
                      a narrow screen. This scroll container + min-w-max inner lets the table keep
                      its natural width and scroll horizontally instead of cramming/clipping. */}
                  <div className="overflow-x-auto">
                    <div className="min-w-max">
                      <DataTable
                        rows={usage.data.events.slice(0, RENDERED_EVENT_CAP)}
                        rowKey={(row) => row.id}
                        columns={[
                          {
                            key: "createdAt",
                            header: "Recorded",
                            render: (row: UsageEventView) => (
                              <span className="font-mono text-xs">{row.createdAt}</span>
                            ),
                          },
                          {
                            key: "kind",
                            header: "Kind",
                            render: (row: UsageEventView) => (
                              <span className="font-mono text-[10px] uppercase tracking-widest">
                                {row.kind}
                              </span>
                            ),
                          },
                          {
                            key: "status",
                            header: "Status",
                            // A real Atlas state token → StatusPill carries tone + dot + label, so the
                            // state is never colour (or bare text) alone. Empty stays a plain dash.
                            render: (row: UsageEventView) =>
                              row.status ? (
                                <StatusPill tone={statusTone(row.status)}>{row.status}</StatusPill>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              ),
                          },
                          {
                            key: "units",
                            header: "Units",
                            render: (row: UsageEventView) => (
                              <span className="font-mono text-xs tabular-nums">
                                {int(row.units)}
                              </span>
                            ),
                          },
                          {
                            key: "tokens",
                            header: "Tokens in/out",
                            render: (row: UsageEventView) => (
                              <span className="font-mono text-xs tabular-nums">
                                {row.tokensPrompt === null ? "—" : int(row.tokensPrompt)} /{" "}
                                {row.tokensOutput === null ? "—" : int(row.tokensOutput)}
                              </span>
                            ),
                          },
                          {
                            key: "estimatedCostUsd",
                            header: "Est. cost",
                            render: (row: UsageEventView) => (
                              <span className="font-mono text-xs tabular-nums">
                                {row.estimatedCostUsd === null ? "—" : usd(row.estimatedCostUsd)}
                              </span>
                            ),
                          },
                          {
                            key: "subject",
                            header: "Run / job",
                            render: (row: UsageEventView) => (
                              <span className="font-mono text-xs text-muted-foreground">
                                {row.runId ?? row.jobId ?? "—"}
                              </span>
                            ),
                          },
                          {
                            key: "actor",
                            header: "Actor",
                            className: "text-right",
                            render: (row: UsageEventView) => (
                              <span className="text-xs text-muted-foreground">{row.actor}</span>
                            ),
                          },
                        ]}
                      />
                    </div>
                  </div>
                  <p className="mt-4 text-xs text-muted-foreground">
                    {usage.data.eventCount > RENDERED_EVENT_CAP
                      ? `Showing the newest ${RENDERED_EVENT_CAP} of ${usage.data.eventCount} events Atlas returned for this range — the CSV export contains all of them.`
                      : `${usage.data.eventCount} event${usage.data.eventCount === 1 ? "" : "s"} in this range, newest first.`}{" "}
                    Atlas offers no pagination on this endpoint; narrow the date range to reduce the
                    response.
                  </p>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}

function TotalCard({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  hint: string;
  /** The one headline KPI: a subtle cyan hairline + cyan label. Kept rare (One Signal Rule). */
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border bg-card p-5 ${
        accent ? "border-primary/25 border-t-2 border-t-primary/60" : "border-border"
      }`}
    >
      <div
        className={`font-mono text-[10px] uppercase tracking-widest ${
          accent ? "text-primary" : "text-muted-foreground"
        }`}
      >
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}
