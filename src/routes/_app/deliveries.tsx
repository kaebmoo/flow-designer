import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { getRouteApi } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import { useState } from "react";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { WindowNotice } from "@/components/atlas/window";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ATLAS_LIMIT_OPTIONS, parseLimitSearch, parseStringSearch } from "@/lib/atlas-search";
import { toClientAtlasError, type DeliveryView } from "@/lib/atlas-mappers";
import { useRetryDelivery } from "@/lib/atlas-mutations";
import { deliveriesQuery } from "@/lib/atlas-queries";

const appRoute = getRouteApi("/_app");

/** The exact status vocabulary Atlas stores and filters on (`atlas/outbound.py`). */
const DELIVERY_STATUSES = ["pending", "delivered", "failed", "blocked"] as const;

function parseStatusSearch(value: unknown): string | undefined {
  return typeof value === "string" && (DELIVERY_STATUSES as readonly string[]).includes(value)
    ? value
    : undefined;
}

export const Route = createFileRoute("/_app/deliveries")({
  validateSearch: (
    search: { limit?: number; status?: string; run?: string } & SearchSchemaInput,
  ) => ({
    limit: parseLimitSearch(search.limit),
    /** Both pushed down to Atlas — `status` and `run_id` are real filters on this route. */
    status: parseStatusSearch(search.status),
    run: parseStringSearch(search.run),
  }),
  component: DeliveriesPage,
  head: () => ({ meta: [{ title: "Deliveries · Atlas Control" }] }),
});

function DeliveriesPage() {
  const { limit, status, run } = Route.useSearch();
  const navigate = Route.useNavigate();
  const identity = appRoute.useLoaderData();
  const role = identity.status === "authenticated" ? identity.identity.role : null;
  /**
   * UX gate only — retry is `POST`, which Atlas guards with `workflows.run` (admin/operator).
   * An auditor holds `deliveries.read` and sees the ledger but cannot retry; Atlas would
   * answer 403 regardless of what this renders.
   */
  const canRetry = role === "admin" || role === "operator";

  const deliveries = useQuery(deliveriesQuery({ limit, runId: run, status }));
  const [runDraft, setRunDraft] = useState(run ?? "");

  const rows = deliveries.data ?? [];

  return (
    <>
      <PageHeader
        title="Deliveries"
        subtitle="Outbound webhook deliveries of completed workflow runs."
        meta={
          <div className="flex flex-wrap items-center gap-1">
            <FilterChip
              active={status === undefined}
              onClick={() => void navigate({ search: (prev) => ({ ...prev, status: undefined }) })}
            >
              all
            </FilterChip>
            {DELIVERY_STATUSES.map((option) => (
              <FilterChip
                key={option}
                active={status === option}
                onClick={() => void navigate({ search: (prev) => ({ ...prev, status: option }) })}
              >
                {option}
              </FilterChip>
            ))}
            <span className="mx-2 h-4 w-px bg-border" aria-hidden="true" />
            {ATLAS_LIMIT_OPTIONS.map((option) => (
              <FilterChip
                key={option}
                active={limit === option}
                onClick={() => void navigate({ search: (prev) => ({ ...prev, limit: option }) })}
              >
                {option}
              </FilterChip>
            ))}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <form
          className="mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate({
              search: (prev) => ({ ...prev, run: runDraft.trim() || undefined }),
            });
          }}
        >
          <div className="w-72">
            <Label htmlFor="delivery-run-filter" className="text-xs text-muted-foreground">
              Filter by run id (applied by Atlas)
            </Label>
            <Input
              id="delivery-run-filter"
              value={runDraft}
              onChange={(event) => setRunDraft(event.target.value)}
              placeholder="wfr_…"
              className="mt-1 font-mono text-xs"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Apply
          </Button>
          {run ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setRunDraft("");
                void navigate({ search: (prev) => ({ ...prev, run: undefined }) });
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>

        {deliveries.isPending ? (
          <LoadingState label="Loading deliveries" />
        ) : deliveries.isError ? (
          // A viewer lands here: the role holds no `deliveries.read`, so Atlas answers 403
          // and this renders the explicit forbidden state rather than an empty table.
          <AtlasErrorState
            error={toClientAtlasError(deliveries.error)}
            onRetry={() => void deliveries.refetch()}
          />
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              empty={
                status || run
                  ? "Atlas has no deliveries matching these filters."
                  : "Atlas has recorded no outbound deliveries yet. They appear when a completed run is delivered to a webhook."
              }
              columns={[
                {
                  key: "id",
                  header: "Delivery",
                  render: (row: DeliveryView) => (
                    <span className="font-mono text-xs text-primary">{row.id}</span>
                  ),
                },
                {
                  key: "runId",
                  header: "Run",
                  render: (row: DeliveryView) => (
                    <Link
                      to="/runs/$id"
                      params={{ id: row.runId }}
                      className="font-mono text-xs hover:text-primary hover:underline"
                    >
                      {row.runId}
                    </Link>
                  ),
                },
                {
                  key: "url",
                  header: "Target",
                  render: (row: DeliveryView) => (
                    <span className="break-all font-mono text-xs">{row.url}</span>
                  ),
                },
                {
                  key: "attempts",
                  header: "Attempts",
                  render: (row: DeliveryView) => (
                    <span className="font-mono text-xs tabular-nums">
                      {row.attempts}/{row.maxAttempts}
                    </span>
                  ),
                },
                {
                  key: "lastError",
                  header: "Last error",
                  render: (row: DeliveryView) =>
                    row.lastError ? (
                      <span className="text-xs text-muted-foreground">{row.lastError}</span>
                    ) : (
                      "—"
                    ),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (row: DeliveryView) => (
                    <StatusPill tone={row.status.tone}>{row.status.label}</StatusPill>
                  ),
                },
                {
                  key: "action",
                  header: "",
                  className: "text-right",
                  render: (row: DeliveryView) => <RetryCell row={row} canRetry={canRetry} />,
                },
              ]}
            />
            <WindowNotice
              count={rows.length}
              limit={limit}
              mayHaveMore={rows.length >= limit}
              noun="deliveries"
            />
          </>
        )}
      </div>
    </>
  );
}

/**
 * One bounded manual retry, offered only where it means something.
 *
 * Atlas re-drives `failed` deliveries and re-validates `blocked` ones against the current
 * allowlist; a `pending` row is still owned by an attempt loop and a `delivered` row is done.
 * The mutation never auto-retries — this button is the retry.
 */
function RetryCell({ row, canRetry }: { row: DeliveryView; canRetry: boolean }) {
  const retry = useRetryDelivery();
  const retryable = row.status.label === "failed" || row.status.label === "blocked";
  if (!retryable || !canRetry) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={retry.isPending}
        onClick={() => retry.mutate({ deliveryId: row.id })}
      >
        <RotateCcw className="size-3" /> {retry.isPending ? "Retrying…" : "Retry"}
      </Button>
      {retry.isError ? (
        <span role="alert" className="text-[10px] text-destructive">
          {retry.error.kind === "forbidden"
            ? "Atlas refused: retrying requires workflows.run."
            : retry.error.message}
        </span>
      ) : null}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-0.5 font-mono text-[10px] uppercase tracking-widest transition ${
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
