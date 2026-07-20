import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Package } from "lucide-react";

import { PageHeader } from "@/components/atlas/page";
import { metricsQuery } from "@/lib/atlas-queries";

export const Route = createFileRoute("/_app/artifacts")({
  component: ArtifactsPage,
  head: () => ({ meta: [{ title: "Artifacts · Atlas Control" }] }),
});

/**
 * Atlas has **no global artifact listing** — this page says so instead of faking one.
 *
 * What exists (Atlas `595ef62`): run-scoped `GET /api/workflow-runs/{id}/artifacts`,
 * job-scoped `GET /api/jobs/{id}/artifacts`, metadata at `GET /api/artifacts/{id}`, and bytes
 * for `file_ref` artifacts at `GET /api/artifacts/{id}/content`. `GET /api/artifacts` is not
 * routed at all (`POST` there *creates* an inline artifact). Synthesising a "global ledger" by
 * fetching every run's artifacts would misrepresent the API's shape and hammer Atlas — so
 * artifacts are reached through the run they belong to, which is where the existing metadata
 * and download UI lives.
 */
function ArtifactsPage() {
  const metrics = useQuery(metricsQuery());

  return (
    <>
      <PageHeader title="Artifacts" subtitle="Files and records produced by workflow runs." />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-2xl space-y-6">
          <section className="rounded-lg border border-border bg-card p-6">
            <div className="flex items-start gap-4">
              <Package className="mt-1 size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="space-y-3 text-sm leading-relaxed">
                <p className="font-semibold text-foreground">
                  Atlas has no global artifact list, so this page cannot show one.
                </p>
                <p className="text-muted-foreground">
                  Artifacts belong to the workflow run (or job) that produced them, and Atlas
                  exposes them only through that scope: each run detail page lists its artifacts
                  with metadata, inline previews, and authenticated downloads for file artifacts.
                </p>
                <p className="text-muted-foreground">
                  {metrics.data
                    ? `Atlas currently reports ${metrics.data.artifacts} artifact${
                        metrics.data.artifacts === 1 ? "" : "s"
                      } across all runs (lifetime total from GET /api/metrics).`
                    : metrics.isError
                      ? "The lifetime artifact count could not be loaded from Atlas metrics."
                      : "Loading the lifetime artifact count from Atlas metrics…"}
                </p>
                <Link
                  to="/runs"
                  className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-primary hover:opacity-80"
                >
                  Browse runs to reach their artifacts <ArrowRight className="size-3" />
                </Link>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card">
            <header className="border-b border-border px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              What the Atlas artifact API provides
            </header>
            <dl className="divide-y divide-border text-sm">
              {[
                [
                  "GET /api/workflow-runs/{id}/artifacts",
                  "All artifacts of one run (complete, not truncated).",
                ],
                ["GET /api/jobs/{id}/artifacts", "Files collected by one standalone job."],
                ["GET /api/artifacts/{id}", "Metadata and inline content for one artifact."],
                [
                  "GET /api/artifacts/{id}/content",
                  "File bytes for file_ref artifacts, downloaded through this origin with Atlas authorization.",
                ],
              ].map(([endpoint, description]) => (
                <div
                  key={endpoint}
                  className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-baseline sm:gap-4"
                >
                  <dt className="shrink-0 font-mono text-xs text-primary">{endpoint}</dt>
                  <dd className="text-muted-foreground">{description}</dd>
                </div>
              ))}
            </dl>
            <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
              A cross-run listing, artifact search, and deletion do not exist in Atlas. If they are
              needed, that is a backend capability to add — not something this UI can simulate
              truthfully.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
