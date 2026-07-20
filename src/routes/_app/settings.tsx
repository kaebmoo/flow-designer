import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderNotice } from "@/components/atlas/states";
import { PageHeader } from "@/components/atlas/page";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: "Settings · Atlas Control" }] }),
});

function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Control plane configuration and integrations." />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <PlaceholderNotice />
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Control plane">
            <Row label="Instance name" value="atlas.prod.eu-west-1" />
            <Row label="Version" value="v2.4.1" />
            <Row label="Base URL" value="https://atlas.example.com" />
            <Row label="TLS" value="Let's Encrypt · auto-renew" />
          </Section>
          <Section title="Fleet defaults">
            <Row label="Worker heartbeat" value="10s" />
            <Row label="Job retry" value="3 × exponential" />
            <Row label="Global timeout" value="600s" />
            <Row label="Approval TTL" value="24h" />
          </Section>
          <Section title="Integrations">
            <Row label="Slack notifications" value="#atlas-ops · connected" />
            <Row label="OpenTelemetry" value="otel-collector.prod:4317" />
            <Row label="Object storage" value="s3://atlas-artifacts · us-east" />
          </Section>
          <Section title="Danger zone" tone="danger">
            <Row label="Pause all workflows" value="idle" />
            <Row label="Purge run history >30d" value="scheduled" />
          </Section>
        </div>
      </div>
    </>
  );
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: "danger";
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-lg border bg-card ${tone === "danger" ? "border-destructive/30" : "border-border"}`}
    >
      <header
        className={`border-b px-5 py-3 font-mono text-[10px] uppercase tracking-widest ${tone === "danger" ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground"}`}
      >
        {title}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <span className="text-sm">{label}</span>
      <span className="font-mono text-xs text-muted-foreground">{value}</span>
    </div>
  );
}
