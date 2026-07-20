import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, DataTable } from "@/components/atlas/page";
import { Download } from "lucide-react";

export const Route = createFileRoute("/_app/artifacts")({
  component: ArtifactsPage,
  head: () => ({ meta: [{ title: "Artifacts · Atlas Control" }] }),
});

const rows = [
  {
    id: "art_9210",
    name: "analysis_report.pdf",
    kind: "pdf",
    size: "412 KB",
    run: "run_00214",
    created: "2m ago",
  },
  {
    id: "art_9209",
    name: "extract.json",
    kind: "json",
    size: "24 KB",
    run: "run_00213",
    created: "18m ago",
  },
  {
    id: "art_9208",
    name: "broadcast.mp3",
    kind: "audio",
    size: "3.1 MB",
    run: "run_00212",
    created: "1h ago",
  },
  {
    id: "art_9207",
    name: "patch.diff",
    kind: "diff",
    size: "6 KB",
    run: "run_00211",
    created: "yesterday",
  },
];

function ArtifactsPage() {
  return (
    <>
      <PageHeader title="Artifacts" subtitle="Files produced by workers and workflows." />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            {
              key: "name",
              header: "Name",
              render: (r) => <span className="font-mono text-sm">{r.name}</span>,
            },
            {
              key: "kind",
              header: "Kind",
              render: (r) => (
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {r.kind}
                </span>
              ),
            },
            { key: "size", header: "Size" },
            {
              key: "run",
              header: "Run",
              render: (r) => <span className="font-mono text-xs text-primary">{r.run}</span>,
            },
            { key: "created", header: "Created" },
            {
              key: "action",
              header: "",
              render: () => (
                <button className="inline-flex items-center gap-1 rounded border border-border bg-white/5 px-2 py-1 text-xs hover:bg-white/10">
                  <Download className="size-3" /> download
                </button>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}
