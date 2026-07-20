import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { Download } from "lucide-react";

import { DateRangeForm } from "@/components/atlas/date-range";
import { DataTable, PageHeader } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { Button } from "@/components/ui/button";
import { parseDateBoundary } from "@/lib/atlas-dates";
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
  const usage = useQuery(usageQuery({ from, to }));

  const exportHref = `/api/exports/usage-csv?${[
    from ? `from=${encodeURIComponent(from)}` : "",
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
        <DateRangeForm
          from={from}
          to={to}
          onApply={(next) => void navigate({ search: () => ({ from: next.from, to: next.to }) })}
        />

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
            <div className="grid gap-4 md:grid-cols-4">
              <TotalCard
                label="Workflow runs"
                value={String(usage.data.totals.workflowRuns)}
                hint={`${usage.data.totals.successfulWorkflowRuns} succeeded`}
              />
              <TotalCard
                label="Jobs"
                value={String(usage.data.totals.jobs)}
                hint={`${usage.data.totals.jobWallSeconds.toFixed(1)}s job wall time`}
              />
              <TotalCard
                label="Budget units"
                value={String(usage.data.totals.budgetUnits)}
                hint={`${usage.data.totals.wallSeconds.toFixed(1)}s run wall time`}
              />
              <TotalCard
                label="Tokens"
                value={`${usage.data.totals.tokensPrompt.toLocaleString()} / ${usage.data.totals.tokensOutput.toLocaleString()}`}
                hint="prompt / output, worker-reported"
              />
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              Estimated cost for {from || to ? "this range" : "the whole ledger"}:{" "}
              <span className="font-mono">
                ${usage.data.totals.estimatedCostUsd.toFixed(4)} USD
              </span>{" "}
              — a per-event visibility estimate Atlas froze at write time, not a billable charge.
              Atlas meters usage; it does not price, invoice, or enforce quotas.
            </p>

            <section className="mt-8">
              <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Usage events {from || to ? "in range" : "(entire ledger)"}
              </h2>
              {usage.data.eventCount === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
                  {from || to
                    ? "Atlas recorded no usage events in this date range."
                    : "Atlas has recorded no usage events yet. Events appear as jobs and workflow runs complete."}
                </div>
              ) : (
                <>
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
                        render: (row: UsageEventView) => row.status || "—",
                      },
                      {
                        key: "units",
                        header: "Units",
                        render: (row: UsageEventView) => (
                          <span className="font-mono text-xs tabular-nums">{row.units}</span>
                        ),
                      },
                      {
                        key: "tokens",
                        header: "Tokens in/out",
                        render: (row: UsageEventView) => (
                          <span className="font-mono text-xs tabular-nums">
                            {row.tokensPrompt ?? "—"} / {row.tokensOutput ?? "—"}
                          </span>
                        ),
                      },
                      {
                        key: "estimatedCostUsd",
                        header: "Est. cost",
                        render: (row: UsageEventView) => (
                          <span className="font-mono text-xs tabular-nums">
                            {row.estimatedCostUsd === null
                              ? "—"
                              : `$${row.estimatedCostUsd.toFixed(6)}`}
                          </span>
                        ),
                      },
                      {
                        key: "subject",
                        header: "Run / job",
                        render: (row: UsageEventView) => (
                          <span className="font-mono text-[11px] text-muted-foreground">
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

function TotalCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}
