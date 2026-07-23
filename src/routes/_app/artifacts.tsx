import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { useState } from "react";

import { ArtifactContentActions, ArtifactDownloadError } from "@/components/atlas/artifact-actions";
import { DataTable, PageHeader } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useArtifactDownloads } from "@/hooks/use-artifact-downloads";
import { toClientAtlasError, type ArtifactView } from "@/lib/atlas-mappers";
import { artifactsQuery } from "@/lib/atlas-queries";
import { ATLAS_LIMIT_OPTIONS, parseLimitSearch, parseStringSearch } from "@/lib/atlas-search";
import { ARTIFACT_KINDS } from "@/lib/atlas-types";

function parseKindSearch(value: unknown): string | undefined {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value)
    ? value
    : undefined;
}

export const Route = createFileRoute("/_app/artifacts")({
  validateSearch: (
    search: {
      limit?: number;
      kind?: string;
      run?: string;
      job?: string;
      key?: string;
    } & SearchSchemaInput,
  ) => ({
    limit: parseLimitSearch(search.limit),
    /** Pushed down to Atlas: these are real filters on `GET /api/artifacts`. */
    kind: parseKindSearch(search.kind),
    run: parseStringSearch(search.run),
    job: parseStringSearch(search.job),
    key: parseStringSearch(search.key),
  }),
  component: ArtifactsPage,
  head: () => ({ meta: [{ title: "Artifacts · Atlas Control" }] }),
});

/**
 * The global artifact ledger, read through Atlas's metadata-only `GET /api/artifacts`
 * opt-in.
 *
 * The route is a newest-first *display window*, and this page says so with Atlas's own
 * numbers: the response carries `total` (all artifacts matching the filters) next to the
 * windowed rows, so the footer can state "latest N of TOTAL" truthfully. The complete,
 * untruncated sets stay where they always were — each run detail page reads
 * `GET /api/workflow-runs/{id}/artifacts`, which Atlas iterates in full.
 */
function ArtifactsPage() {
  const { limit, kind, run, job, key } = Route.useSearch();
  const navigate = Route.useNavigate();

  const listing = useQuery(artifactsQuery({ limit, kind, runId: run, jobId: job, key }));

  return (
    <>
      <PageHeader
        title="Artifacts"
        subtitle="Files and records produced by workflow runs and jobs, newest first."
        meta={
          <div className="flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Artifact kind filter" className="flex flex-wrap gap-1">
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
            </div>
            <div role="group" aria-label="Artifact list limit" className="flex flex-wrap gap-1">
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
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/* Keyed by the applied filter so browser Back/Forward re-seeds the draft — the input
            must always show the run id the table below is actually filtered by. */}
        <ArtifactFilterForm
          key={`${run ?? ""}:${job ?? ""}:${key ?? ""}`}
          run={run}
          job={job}
          artifactKey={key}
          onApply={(next) =>
            void navigate({
              search: (prev) => ({ ...prev, run: next.run, job: next.job, key: next.key }),
            })
          }
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
            filtered={Boolean(kind || run || job || key)}
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
  const { pendingIds, downloadError, downloadArtifact } = useArtifactDownloads();

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
            render: (artifact) => (
              <ArtifactContentActions
                artifact={artifact}
                downloading={pendingIds.has(artifact.id)}
                onDownload={(row) => void downloadArtifact(row)}
              />
            ),
          },
        ]}
      />
      <ArtifactDownloadError error={downloadError} />
      <p className="mt-4 text-xs text-muted-foreground">
        Showing the {rows.length} newest of the {total} artifact{total === 1 ? "" : "s"} Atlas holds
        {filtered ? " for these filters" : ""} (window of {limit}). The complete set of one run
        stays on its run detail page, which Atlas serves untruncated.
      </p>
    </>
  );
}

/**
 * Atlas-side filters, holding their own drafts so browser Back/Forward re-seeds what the table
 * is actually filtered by.
 */
function ArtifactFilterForm({
  run,
  job,
  artifactKey,
  onApply,
}: {
  run: string | undefined;
  job: string | undefined;
  artifactKey: string | undefined;
  onApply: (next: {
    run: string | undefined;
    job: string | undefined;
    key: string | undefined;
  }) => void;
}) {
  const [runDraft, setRunDraft] = useState(run ?? "");
  const [jobDraft, setJobDraft] = useState(job ?? "");
  const [keyDraft, setKeyDraft] = useState(artifactKey ?? "");
  return (
    <form
      className="mb-4 flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onApply({
          run: runDraft.trim() || undefined,
          job: jobDraft.trim() || undefined,
          key: keyDraft.trim() || undefined,
        });
      }}
    >
      <div className="w-72">
        <Label htmlFor="artifact-run-filter" className="text-xs text-muted-foreground">
          Filter by run id (applied by Atlas)
        </Label>
        <Input
          id="artifact-run-filter"
          value={runDraft}
          onChange={(event) => setRunDraft(event.target.value)}
          placeholder="wfr_…"
          className="mt-1 font-mono text-xs"
        />
      </div>
      <div className="w-72">
        <Label htmlFor="artifact-job-filter" className="text-xs text-muted-foreground">
          Filter by job id (applied by Atlas)
        </Label>
        <Input
          id="artifact-job-filter"
          value={jobDraft}
          onChange={(event) => setJobDraft(event.target.value)}
          placeholder="job_..."
          className="mt-1 font-mono text-xs"
        />
      </div>
      <div className="w-72">
        <Label htmlFor="artifact-key-filter" className="text-xs text-muted-foreground">
          Filter by artifact key (applied by Atlas)
        </Label>
        <Input
          id="artifact-key-filter"
          value={keyDraft}
          onChange={(event) => setKeyDraft(event.target.value)}
          placeholder="report"
          className="mt-1 font-mono text-xs"
        />
      </div>
      <Button type="submit" variant="outline" size="sm">
        Apply filters
      </Button>
      {run || job || artifactKey ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onApply({ run: undefined, job: undefined, key: undefined })}
        >
          Clear
        </Button>
      ) : null}
    </form>
  );
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
      aria-pressed={active}
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
