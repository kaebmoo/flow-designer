import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, DataTable } from "@/components/atlas/page";
import { useAtlas } from "@/lib/atlas-store";
import { Plus } from "lucide-react";

export const Route = createFileRoute("/_app/workspaces")({
  component: WorkspacesPage,
  head: () => ({ meta: [{ title: "Workspaces · Atlas Control" }] }),
});

type Row = { key: string; worker: string; dir: string; jobs: number };

function WorkspacesPage() {
  const workers = useAtlas((s) => s.workers);
  const rows: Row[] = workers.flatMap((w) =>
    w.workspaces.map((ws) => ({ key: ws, worker: w.name, dir: `/Users/${w.role}/${ws}`, jobs: Math.floor(Math.random() * 40) })),
  );
  return (
    <>
      <PageHeader
        title="Workspaces"
        subtitle="Project directories exposed by each worker. The workspace_key resolves on the worker machine."
        actions={
          <button className="inline-flex items-center gap-2 rounded bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground hover:opacity-90"><Plus className="size-4" /> Map Workspace</button>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <DataTable
          rows={rows}
          rowKey={(r) => `${r.worker}-${r.key}`}
          columns={[
            { key: "key", header: "Workspace Key", render: (r) => <span className="font-mono text-sm text-primary">{r.key}</span> },
            { key: "worker", header: "Worker" },
            { key: "dir", header: "Directory (on worker)", render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.dir}</span> },
            { key: "jobs", header: "Jobs · 24h", className: "text-right", render: (r) => <span className="font-mono">{r.jobs}</span> },
          ]}
        />
      </div>
    </>
  );
}