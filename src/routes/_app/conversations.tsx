import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderNotice } from "@/components/atlas/states";
import { PageHeader, DataTable } from "@/components/atlas/page";

export const Route = createFileRoute("/_app/conversations")({
  component: ConversationsPage,
  head: () => ({ meta: [{ title: "Conversations · Atlas Control" }] }),
});

const rows = [
  { id: "conv_1204", worker: "Reporter · Local", workspace: "thclaws", jobs: 8, last: "2m ago" },
  { id: "conv_1198", worker: "Coder · Company Mac", workspace: "atlas", jobs: 14, last: "34m ago" },
  { id: "conv_1187", worker: "Research · GPU-01", workspace: "finance", jobs: 3, last: "2h ago" },
  {
    id: "conv_1150",
    worker: "Anchor · Local 2",
    workspace: "thclaws",
    jobs: 22,
    last: "yesterday",
  },
];

function ConversationsPage() {
  return (
    <>
      <PageHeader
        title="Conversations"
        subtitle="Bindings that let Atlas continue against the same thClaws session across jobs."
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <PlaceholderNotice endpoint="GET /api/conversations" />
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            {
              key: "id",
              header: "Conversation",
              render: (r) => <span className="font-mono text-xs text-primary">{r.id}</span>,
            },
            { key: "worker", header: "Worker" },
            {
              key: "workspace",
              header: "Workspace",
              render: (r) => <span className="font-mono text-xs">{r.workspace}</span>,
            },
            { key: "jobs", header: "Jobs" },
            {
              key: "last",
              header: "Last Activity",
              className: "text-right",
              render: (r) => <span className="text-muted-foreground">{r.last}</span>,
            },
          ]}
        />
      </div>
    </>
  );
}
