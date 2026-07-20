import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderNotice } from "@/components/atlas/states";
import { PageHeader, DataTable, StatusPill } from "@/components/atlas/page";
import { KeyRound, Plus } from "lucide-react";

export const Route = createFileRoute("/_app/users")({
  component: UsersPage,
  head: () => ({ meta: [{ title: "Users & Tokens · Atlas Control" }] }),
});

const users = [
  { id: "u_1", name: "Operator 01", email: "op1@atlas.dev", role: "sys_admin", status: "active" },
  { id: "u_2", name: "Operator 02", email: "op2@atlas.dev", role: "operator", status: "active" },
  { id: "u_3", name: "Ops Lead", email: "lead@atlas.dev", role: "reviewer", status: "active" },
  { id: "u_4", name: "Guest", email: "guest@atlas.dev", role: "viewer", status: "invited" },
];

const tokens = [
  { id: "tok_a1", label: "CI · GitHub Actions", scope: "workflow:run", last: "2m ago" },
  { id: "tok_a2", label: "Webhook inlet", scope: "trigger:fire", last: "5m ago" },
  { id: "tok_a3", label: "Ops CLI", scope: "admin", last: "1h ago" },
];

function UsersPage() {
  return (
    <>
      <PageHeader
        title="Users & Tokens"
        subtitle="Access management for the control plane."
        actions={
          <button className="inline-flex items-center gap-2 rounded bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground hover:opacity-90">
            <Plus className="size-4" /> Invite User
          </button>
        }
      />
      <div className="flex-1 space-y-6 overflow-y-auto px-8 py-6">
        <PlaceholderNotice endpoint="GET /api/users" />
        <section>
          <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Users
          </div>
          <DataTable
            rows={users}
            rowKey={(u) => u.id}
            columns={[
              { key: "name", header: "Name" },
              {
                key: "email",
                header: "Email",
                render: (u) => <span className="font-mono text-xs">{u.email}</span>,
              },
              {
                key: "role",
                header: "Role",
                render: (u) => (
                  <span className="font-mono text-[10px] uppercase tracking-widest">{u.role}</span>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (u) => (
                  <StatusPill tone={u.status === "active" ? "success" : "warning"}>
                    {u.status}
                  </StatusPill>
                ),
              },
            ]}
          />
        </section>
        <section>
          <div className="mb-3 flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              API Tokens
            </div>
            <button className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-primary hover:bg-primary/20">
              <KeyRound className="size-3" /> Mint token
            </button>
          </div>
          <DataTable
            rows={tokens}
            rowKey={(t) => t.id}
            columns={[
              {
                key: "id",
                header: "ID",
                render: (t) => <span className="font-mono text-xs text-primary">{t.id}</span>,
              },
              { key: "label", header: "Label" },
              {
                key: "scope",
                header: "Scope",
                render: (t) => (
                  <span className="font-mono text-[10px] uppercase tracking-widest">{t.scope}</span>
                ),
              },
              { key: "last", header: "Last used", className: "text-right" },
            ]}
          />
        </section>
      </div>
    </>
  );
}
