import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { useState } from "react";

import { DataTable, PageHeader } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toClientAtlasError, type ArtifactView, type ClientAtlasError } from "@/lib/atlas-mappers";
import { artifactsQuery } from "@/lib/atlas-queries";
import { ATLAS_LIMIT_OPTIONS, parseLimitSearch, parseStringSearch } from "@/lib/atlas-search";
import { ARTIFACT_KINDS, type AtlasErrorKind } from "@/lib/atlas-types";

function parseKindSearch(value: unknown): string | undefined {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value)
    ? value
    : undefined;
}

export const Route = createFileRoute("/_app/artifacts")({
  validateSearch: (
    search: { limit?: number; kind?: string; run?: string } & SearchSchemaInput,
  ) => ({
    limit: parseLimitSearch(search.limit),
    /** Both pushed down to Atlas — `kind` and `run_id` are real filters on `GET /api/artifacts`. */
    kind: parseKindSearch(search.kind),
    run: parseStringSearch(search.run),
  }),
  component: ArtifactsPage,
  head: () => ({ meta: [{ title: "Artifacts · Atlas Control" }] }),
});

/**
 * The global artifact ledger, read from `GET /api/artifacts` (Atlas ec62be1).
 *
 * The route is a newest-first *display window*, and this page says so with Atlas's own
 * numbers: the response carries `total` (all artifacts matching the filters) next to the
 * windowed rows, so the footer can state "latest N of TOTAL" truthfully. The complete,
 * untruncated sets stay where they always were — each run detail page reads
 * `GET /api/workflow-runs/{id}/artifacts`, which Atlas iterates in full.
 */
function ArtifactsPage() {
  const { limit, kind, run } = Route.useSearch();
  const navigate = Route.useNavigate();

  const listing = useQuery(artifactsQuery({ limit, kind, runId: run }));

  return (
    <>
      <PageHeader
        title="Artifacts"
        subtitle="Files and records produced by workflow runs and jobs, newest first."
        meta={
          <div className="flex flex-wrap items-center gap-1">
            <FilterChip
              active={kind === undefined}
              onClick={() => void navigate({ search: (prev) => ({ ...prev, kind: undefined }) })}
            >
              all
            </FilterChip>
            {ARTIFACT_KINDS.map((option) => (
              <FilterChip
                key={option}
                active={kind === option}
                onClick={() => void navigate({ search: (prev) => ({ ...prev, kind: option }) })}
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
        {/* Keyed by the applied filter so browser Back/Forward re-seeds the draft — the input
            must always show the run id the table below is actually filtered by. */}
        <RunFilterForm
          key={run ?? ""}
          run={run}
          onApply={(next) => void navigate({ search: (prev) => ({ ...prev, run: next }) })}
        />

        {listing.isPending ? (
          <LoadingState label="Loading artifacts" />
        ) : listing.isError ? (
          // A 403 lands here as the explicit forbidden state rather than an empty table.
          <AtlasErrorState
            error={toClientAtlasError(listing.error)}
            onRetry={() => void listing.refetch()}
          />
        ) : (
          <ArtifactsTable
            rows={listing.data.artifacts}
            total={listing.data.total}
            limit={listing.data.limit}
            filtered={Boolean(kind || run)}
          />
        )}
      </div>
    </>
  );
}

function ArtifactsTable({
  rows,
  total,
  limit,
  filtered,
}: {
  rows: ArtifactView[];
  total: number;
  limit: number;
  filtered: boolean;
}) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<ClientAtlasError | null>(null);

  /**
   * Fetched rather than left to a plain `<a href download>`: that anchor cannot fail visibly —
   * a 403 or 400 body would land on disk as a file containing the refusal with nothing on
   * screen. Checking the response first puts the refusal in the page. Same-origin: the route
   * handler adds the Atlas bearer server-side, so the token never reaches browser code.
   */
  async function downloadArtifact(artifact: ArtifactView) {
    setDownloadError(null);
    setDownloadingId(artifact.id);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/content`);
      if (!response.ok) {
        setDownloadError(await readDownloadError(response));
        return;
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = artifact.filename ?? artifact.key;
      link.click();
      // The click only *starts* the save; revoking in this task could cancel it.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch {
      setDownloadError({
        kind: "network",
        message: "The browser could not reach this origin to fetch the artifact.",
      });
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <>
      <DataTable
        rows={rows}
        rowKey={(artifact) => artifact.id}
        empty={
          filtered
            ? "Atlas has no artifacts matching these filters."
            : "Atlas has recorded no artifacts yet. They appear when workflow runs produce outputs, or when a node sets collect_files so the worker's files are snapshotted after its turn."
        }
        columns={[
          {
            key: "key",
            header: "Key",
            render: (artifact) => (
              <span className="font-mono text-xs text-primary">{artifact.key}</span>
            ),
          },
          {
            key: "kind",
            header: "Kind",
            render: (artifact) => <span className="font-mono text-xs">{artifact.kind}</span>,
          },
          {
            key: "origin",
            header: "Produced by",
            render: (artifact) =>
              artifact.runId ? (
                <Link
                  to="/runs/$id"
                  params={{ id: artifact.runId }}
                  className="font-mono text-xs hover:text-primary hover:underline"
                >
                  {artifact.runId}
                </Link>
              ) : artifact.jobId ? (
                <span className="font-mono text-xs text-muted-foreground">
                  job {artifact.jobId}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              ),
          },
          {
            key: "sizeBytes",
            header: "Size",
            render: (artifact) => (
              <span className="font-mono text-xs tabular-nums">
                {formatBytes(artifact.sizeBytes)}
              </span>
            ),
          },
          {
            key: "createdAt",
            header: "Created",
            render: (artifact) => (
              <span className="font-mono text-xs text-muted-foreground">{artifact.createdAt}</span>
            ),
          },
          {
            key: "content",
            header: "Content",
            className: "text-right",
            render: (artifact) =>
              artifact.downloadable ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={downloadingId === artifact.id}
                  onClick={() => void downloadArtifact(artifact)}
                >
                  {downloadingId === artifact.id ? "Downloading…" : "Download"}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Inline {artifact.kind} — open its run for the preview.
                </span>
              ),
          },
        ]}
      />
      {downloadError ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {downloadError.message}
        </p>
      ) : null}
      <p className="mt-4 text-xs text-muted-foreground">
        Showing the {rows.length} newest of the {total} artifact{total === 1 ? "" : "s"} Atlas holds
        {filtered ? " for these filters" : ""} (window of {limit}). The complete set of one run
        stays on its run detail page, which Atlas serves untruncated.
      </p>
    </>
  );
}

/**
 * The run-id filter, holding its own draft so the caller can `key` it by the applied value.
 */
function RunFilterForm({
  run,
  onApply,
}: {
  run: string | undefined;
  onApply: (next: string | undefined) => void;
}) {
  const [draft, setDraft] = useState(run ?? "");
  return (
    <form
      className="mb-4 flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft.trim() || undefined);
      }}
    >
      <div className="w-72">
        <Label htmlFor="artifact-run-filter" className="text-xs text-muted-foreground">
          Filter by run id (applied by Atlas)
        </Label>
        <Input
          id="artifact-run-filter"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="wfr_…"
          className="mt-1 font-mono text-xs"
        />
      </div>
      <Button type="submit" variant="outline" size="sm">
        Apply
      </Button>
      {run ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onApply(undefined)}>
          Clear
        </Button>
      ) : null}
    </form>
  );
}

const DOWNLOAD_ERROR_KINDS: Record<number, AtlasErrorKind> = {
  400: "validation",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  504: "timeout",
};

async function readDownloadError(response: Response): Promise<ClientAtlasError> {
  const kind = DOWNLOAD_ERROR_KINDS[response.status] ?? "server";
  const body = await response.text().catch(() => "");
  return { kind, message: body.trim() || "The download could not be completed." };
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
