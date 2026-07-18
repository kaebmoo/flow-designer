import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { useAtlas } from "@/lib/atlas-store";

const WorkflowEditor = lazy(() =>
  import("@/components/atlas/workflow-editor").then((m) => ({ default: m.WorkflowEditor }))
);

export const Route = createFileRoute("/_app/workflows/$id")({
  component: WorkflowDetail,
  head: ({ params }) => ({ meta: [{ title: `Workflow ${params.id} · Atlas Control` }] }),
});

function WorkflowDetail() {
  const { id } = Route.useParams();
  const workflow = useAtlas((s) => s.workflows.find((w) => w.id === id));
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!workflow) {
    return (
      <div className="grid flex-1 place-items-center text-center">
        <div>
          <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Workflow not found</div>
          <Link to="/workflows" className="mt-3 inline-block text-sm text-primary hover:underline">← Back to workflows</Link>
        </div>
      </div>
    );
  }
  if (!mounted) return <div className="grid flex-1 place-items-center text-xs text-muted-foreground">Loading canvas…</div>;
  return (
    <Suspense fallback={<div className="grid flex-1 place-items-center text-xs text-muted-foreground">Loading canvas…</div>}>
      <WorkflowEditor workflow={workflow} />
    </Suspense>
  );
}