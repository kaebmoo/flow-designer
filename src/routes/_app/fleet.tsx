import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, StatusPill, DataTable } from "@/components/atlas/page";
import { useAtlas } from "@/lib/atlas-store";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/_app/fleet")({
  component: FleetPage,
  head: () => ({ meta: [{ title: "Fleet · Atlas Control" }] }),
});

function FleetPage() {
  const workers = useAtlas((s) => s.workers);
  const addWorker = useAtlas((s) => s.addWorker);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", base_url: "", role: "reporter", tags: "" });

  return (
    <>
      <PageHeader
        title="Fleet"
        subtitle="Every thClaws worker Atlas can route to. Health is polled continuously."
        actions={
          <>
            <button className="inline-flex items-center gap-2 rounded border border-border bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10">
              <RefreshCw className="size-3.5" /> Re-poll all
            </button>
            <button
              onClick={() => setOpen(true)}
              className="inline-flex items-center gap-2 rounded bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground hover:opacity-90"
            >
              <Plus className="size-4" /> Add Worker
            </button>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <DataTable
          rows={workers}
          rowKey={(w) => w.id}
          columns={[
            {
              key: "name",
              header: "Worker",
              render: (w) => (
                <div>
                  <div className="text-sm font-medium">{w.name}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{w.base_url}</div>
                </div>
              ),
            },
            {
              key: "role",
              header: "Role",
              render: (w) => <span className="font-mono text-xs">{w.role}</span>,
            },
            {
              key: "tags",
              header: "Tags",
              render: (w) => (
                <div className="flex flex-wrap gap-1">
                  {w.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded border border-border bg-white/5 px-1.5 py-0.5 font-mono text-[10px]"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ),
            },
            {
              key: "workspaces",
              header: "Workspaces",
              render: (w) => (
                <span className="font-mono text-xs text-muted-foreground">
                  {w.workspaces.join(", ") || "—"}
                </span>
              ),
            },
            {
              key: "version",
              header: "Version",
              render: (w) => (
                <span className="font-mono text-xs text-muted-foreground">{w.version}</span>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (w) => (
                <StatusPill
                  tone={
                    w.status === "online"
                      ? "success"
                      : w.status === "degraded"
                        ? "warning"
                        : "danger"
                  }
                >
                  {w.status}
                </StatusPill>
              ),
            },
            {
              key: "last_seen",
              header: "Last Seen",
              className: "text-right",
              render: (w) => (
                <span className="font-mono text-xs text-muted-foreground">{w.last_seen}</span>
              ),
            },
          ]}
        />
      </div>

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 animate-scale-in">
            <h2 className="text-lg font-bold">Add Worker</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Atlas will poll `/healthz` and `/v1/agent/info` after save.
            </p>
            <div className="mt-5 space-y-4">
              {[
                { k: "name", label: "Name", ph: "Local thClaws" },
                { k: "base_url", label: "Base URL", ph: "http://127.0.0.1:4317" },
                { k: "role", label: "Role", ph: "reporter · anchor · coder..." },
                { k: "tags", label: "Tags (comma separated)", ph: "local, news" },
              ].map((f) => (
                <label key={f.k} className="block">
                  <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {f.label}
                  </span>
                  <input
                    value={(form as Record<string, string>)[f.k]}
                    onChange={(e) => setForm({ ...form, [f.k]: e.target.value })}
                    placeholder={f.ph}
                    className="w-full rounded border border-border bg-background/50 px-3 py-2 text-sm outline-none focus:border-primary/50"
                  />
                </label>
              ))}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded border border-border px-3 py-1.5 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!form.name || !form.base_url) return;
                  addWorker({
                    name: form.name,
                    base_url: form.base_url,
                    role: form.role,
                    tags: form.tags
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    workspaces: [],
                    version: "1.4.2",
                  });
                  setOpen(false);
                  setForm({ name: "", base_url: "", role: "reporter", tags: "" });
                }}
                className="rounded bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground"
              >
                Save & Poll
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
