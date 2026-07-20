import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { toClientAtlasError } from "@/lib/atlas-mappers";
import { metricsQuery } from "@/lib/atlas-queries";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: "Settings · Atlas Control" }] }),
});

/**
 * Read-only, and honest about why.
 *
 * Atlas exposes **no settings API**: its configuration is environment variables (`ATLAS_*`)
 * read at process start, with no authenticated endpoint to view or change them. The only real
 * instance facts reachable by this session are the ones `GET /api/metrics` reports — version,
 * schema version, server time — so those are shown, labelled with their source, and nothing
 * else is. The previous revision of this page displayed a fabricated hostname, TLS status,
 * integrations, retention policy, and a "danger zone"; every one of those was mock data with
 * no backing endpoint, which is worse than showing nothing.
 */
function SettingsPage() {
  const metrics = useQuery(metricsQuery());

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Instance information reported by Atlas. Read-only — Atlas has no settings API."
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {metrics.isPending ? (
          <LoadingState label="Loading instance information" />
        ) : metrics.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(metrics.error)}
            onRetry={() => void metrics.refetch()}
          />
        ) : (
          <div className="max-w-2xl space-y-6">
            <section className="rounded-lg border border-border bg-card">
              <header className="border-b border-border px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Atlas instance · read-only, from GET /api/metrics
              </header>
              <dl className="divide-y divide-border">
                <Row label="Atlas version" value={metrics.data.atlasVersion} />
                <Row label="Schema version" value={String(metrics.data.schemaVersion)} />
                <Row label="Server time (UTC)" value={metrics.data.generatedAt} />
              </dl>
            </section>

            <section className="rounded-lg border border-border bg-card p-5 text-sm leading-relaxed text-muted-foreground">
              <h2 className="mb-2 font-semibold text-foreground">
                Why there is nothing to configure here
              </h2>
              <p>
                Atlas is configured through server-side environment variables (
                <code className="font-mono text-xs">ATLAS_HOST</code>,{" "}
                <code className="font-mono text-xs">ATLAS_DB</code>,{" "}
                <code className="font-mono text-xs">ATLAS_CORS_ORIGINS</code>,{" "}
                <code className="font-mono text-xs">ATLAS_OUTBOUND_ALLOWLIST</code>, …) read at
                process start. It exposes no authenticated endpoint to read or change them, so this
                UI cannot offer instance naming, TLS, integrations, retention policies, or fleet
                defaults without inventing them. If Atlas gains a safe settings API, this page is
                where it lands. Deployment configuration for this frontend is documented in{" "}
                <code className="font-mono text-xs">docs/CONFIGURATION.md</code>.
              </p>
            </section>
          </div>
        )}
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <dt className="text-sm">{label}</dt>
      <dd className="font-mono text-xs text-muted-foreground">{value}</dd>
    </div>
  );
}
