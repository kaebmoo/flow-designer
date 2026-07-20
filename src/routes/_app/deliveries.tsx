import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderNotice } from "@/components/atlas/states";
import { PageHeader, DataTable, StatusPill } from "@/components/atlas/page";

export const Route = createFileRoute("/_app/deliveries")({
  component: DeliveriesPage,
  head: () => ({ meta: [{ title: "Deliveries · Atlas Control" }] }),
});

const rows = [
  {
    id: "dlv_5501",
    target: "https://ops.example.com/hook",
    run: "run_00214",
    status: "success",
    code: 200,
    at: "14:23:04",
  },
  {
    id: "dlv_5500",
    target: "slack://#atlas-ops",
    run: "run_00213",
    status: "success",
    code: 200,
    at: "14:15:11",
  },
  {
    id: "dlv_5499",
    target: "https://legacy.example.com/in",
    run: "run_00212",
    status: "failed",
    code: 502,
    at: "13:44:16",
  },
  {
    id: "dlv_5498",
    target: "email://ops-lead@example.com",
    run: "run_00211",
    status: "pending",
    code: 0,
    at: "13:22:42",
  },
];

function DeliveriesPage() {
  return (
    <>
      <PageHeader title="Deliveries" subtitle="Return-path callbacks issued by workflows." />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <PlaceholderNotice endpoint="GET /api/deliveries" />
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
              key: "target",
              header: "Target",
              render: (r) => <span className="font-mono text-xs">{r.target}</span>,
            },
            { key: "run", header: "Run" },
            {
              key: "code",
              header: "HTTP",
              render: (r) => <span className="font-mono text-xs">{r.code || "—"}</span>,
            },
            { key: "at", header: "At" },
            {
              key: "status",
              header: "Status",
              render: (r) => (
                <StatusPill
                  tone={
                    r.status === "success"
                      ? "success"
                      : r.status === "failed"
                        ? "danger"
                        : "warning"
                  }
                >
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
