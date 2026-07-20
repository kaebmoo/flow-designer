import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, DataTable, StatusPill } from "@/components/atlas/page";
import { Copy, Plus } from "lucide-react";

export const Route = createFileRoute("/_app/triggers")({
  component: TriggersPage,
  head: () => ({ meta: [{ title: "Triggers · Atlas Control" }] }),
});

const rows = [
  {
    id: "trg_ingest",
    kind: "webhook",
    path: "/api/v1/ingest",
    workflow: "Data Ingestion Pipeline",
    status: "active",
    auth: "HMAC",
  },
  {
    id: "trg_pr",
    kind: "webhook",
    path: "/api/v1/pr",
    workflow: "Coder → Reviewer",
    status: "disabled",
    auth: "Bearer",
  },
  {
    id: "trg_digest",
    kind: "cron",
    path: "0 9 * * *",
    workflow: "Daily Digest",
    status: "disabled",
    auth: "—",
  },
  {
    id: "trg_alert",
    kind: "event",
    path: "worker.offline",
    workflow: "On-call Notifier",
    status: "active",
    auth: "internal",
  },
];

function TriggersPage() {
  return (
    <>
      <PageHeader
        title="Triggers"
        subtitle="Webhooks, schedules, and internal events that fire workflows."
        actions={
          <button className="inline-flex items-center gap-2 rounded bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground hover:opacity-90">
            <Plus className="size-4" /> New Trigger
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            {
              key: "id",
              header: "ID",
              render: (r) => <span className="font-mono text-xs text-primary">{r.id}</span>,
            },
            {
              key: "kind",
              header: "Kind",
              render: (r) => <span className="font-mono text-xs uppercase">{r.kind}</span>,
            },
            {
              key: "path",
              header: "Path / Cron / Event",
              render: (r) => (
                <div className="flex items-center gap-2 font-mono text-xs">
                  {r.path}
                  <Copy className="size-3 text-muted-foreground hover:text-foreground" />
                </div>
              ),
            },
            { key: "workflow", header: "Workflow" },
            { key: "auth", header: "Auth" },
            {
              key: "status",
              header: "Status",
              render: (r) => (
                <StatusPill tone={r.status === "active" ? "success" : "muted"}>
                  {r.status}
                </StatusPill>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}
