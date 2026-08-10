import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { ChevronRight, Loader2, Plus, Workflow } from "lucide-react";
import { useState } from "react";

import { EmptyHint, FilterChip, PageHeader, StatusPill } from "@/components/atlas/page";
import { Button } from "@/components/ui/button";
import { useCreateWorkflow } from "@/lib/atlas-mutations";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { WindowNotice } from "@/components/atlas/window";
import { ATLAS_LIMIT_OPTIONS, parseLimitSearch } from "@/lib/atlas-search";
import { counted } from "@/lib/plural";
import { toClientAtlasError } from "@/lib/atlas-mappers";
import { workflowsQuery } from "@/lib/atlas-queries";
import { serializeWorkflowGraph, serializeWorkflowPolicy } from "@/lib/workflow-graph";
import { WORKFLOW_EXAMPLES, type WorkflowExample } from "@/lib/workflow-examples";
import { WorkflowPackImportDialog } from "@/components/atlas/workflow-pack-import-dialog";

export const Route = createFileRoute("/_app/workflows/")({
  /**
   * `limit` lives in the URL so a shared or reloaded link shows the same window.
   *
   * The input type is optional and the output is not: a link may omit the parameter, and the
   * component always receives a clamped number rather than having to default it again.
   */
  validateSearch: (search: { limit?: number } & SearchSchemaInput) => ({
    limit: parseLimitSearch(search.limit),
  }),
  component: WorkflowsIndex,
  head: () => ({ meta: [{ title: "Workflows · Atlas Control" }] }),
});

const appRoute = getRouteApi("/_app");

/** Sentinel id for the blank "New workflow" create, so its pending label is tracked like an example. */
const NEW_WORKFLOW_ID = "__new_workflow__";

/**
 * Workflow definitions, read from `GET /api/workflows?limit=`.
 *
 * The scaffold's "runs/24h" and "% ok" figures are gone: Atlas stores neither on a workflow
 * definition, and there is no aggregate endpoint that supplies them per workflow.
 *
 * "New workflow" creates the smallest graph Atlas accepts and opens it. There is no client-side
 * draft state: a workflow that exists only in the browser could not be validated (Atlas checks
 * a *stored* workflow by id) or run, so it would be a second, weaker kind of workflow to
 * explain. Creating it immediately means everything on the editor works from the first click.
 */
function WorkflowsIndex() {
  const { limit } = Route.useSearch();
  const navigate = Route.useNavigate();
  const routerNavigate = useNavigate();
  const identity = appRoute.useLoaderData();
  const [importOpen, setImportOpen] = useState(false);
  // Which control kicked off the in-flight create, so only that button shows "Creating…"
  // (`create.isPending` alone is global and would relabel every create button at once).
  const [pendingCreateId, setPendingCreateId] = useState<string | null>(null);
  const workflows = useQuery(workflowsQuery({ limit }));
  const create = useCreateWorkflow();
  const canImportPacks =
    identity.status === "authenticated" &&
    (identity.identity.role === "admin" || identity.identity.role === "operator");

  const createWorkflow = (example?: WorkflowExample) => {
    const template = example
      ? {
          name: example.name,
          description: example.description,
          graph: serializeWorkflowGraph(example.graph),
          policy: serializeWorkflowPolicy(example.policy),
        }
      : {
          name: "Untitled workflow",
          description: "",
          graph: {
            start: "worker_1",
            nodes: [{ id: "worker_1", type: "worker", prompt: "" }],
            edges: [],
          },
          policy: {},
        };

    setPendingCreateId(example ? example.id : NEW_WORKFLOW_ID);
    create.mutate(template, {
      onSuccess: (workflow) =>
        routerNavigate({ to: "/workflows/$id", params: { id: workflow.id } }),
      // Success navigates away; on error we re-enable the controls and clear the label.
      onSettled: () => setPendingCreateId(null),
    });
  };

  /**
   * Names already in the operator's list, so a template can say when it would make a second one.
   *
   * The same grid renders above the empty state and inside the disclosure below a populated
   * list, which means a workflow created from "Customer Complaint Handler" appears twice on one
   * page — once as the real thing, once as the template that produced it — and the button said
   * "Create example" both times. Atlas has no uniqueness constraint on a workflow name, so the
   * second create silently succeeds and leaves two identically named rows. Naming that before
   * the click is the whole fix; nothing here blocks it, because duplicating a starter is a
   * legitimate thing to want.
   */
  const existingNames = new Set(workflows.data?.items.map((item) => item.name) ?? []);

  // One grid of starter cards, reused whether the operator's list is empty (shown prominently)
  // or populated (tucked into a "Start from a template" disclosure below the list).
  const starterGrid = (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {WORKFLOW_EXAMPLES.map((example) => {
        const isPending = pendingCreateId === example.id;
        const alreadyCreated = existingNames.has(example.name);
        return (
          <div
            key={example.id}
            className="flex min-h-48 flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/35"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-bold leading-snug">{example.name}</h3>
                {/*
                  Beside the title, not in the footer: it is a fact about the workflow, and
                  putting it with the node/edge counts gave this one card a three-line footer
                  while its siblings had one, breaking the row's baseline.
                */}
                {alreadyCreated ? (
                  <span className="shrink-0 rounded border border-border px-1.5 py-px font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                    In your list
                  </span>
                ) : null}
              </div>
              <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                {example.description}
              </p>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {counted(example.graph.nodes.length, "node")} ·{" "}
                {counted(example.graph.edges.length, "edge")}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={create.isPending}
                onClick={() => createWorkflow(example)}
              >
                {isPending ? (
                  <Loader2
                    className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                {isPending ? "Creating…" : alreadyCreated ? "Create another" : "Create example"}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="Workflow definitions stored in Atlas."
        actions={
          <div className="flex max-w-full flex-wrap items-start justify-end gap-2">
            <div className="flex flex-col items-end gap-1">
              {/*
                The reason lives in the caption, and the button points at it.

                It used to be a `title` — which a disabled button can never show, because
                `disabled:pointer-events-none` suppresses hover and it is out of the tab order
                anyway. The caption beside it said `workflows.manage required` and was associated
                with nothing, so a screen-reader user got a disabled control and no reason at all.
              */}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canImportPacks}
                aria-describedby={canImportPacks ? undefined : "import-pack-permission"}
                onClick={() => setImportOpen(true)}
              >
                Import pack
              </Button>
              {!canImportPacks ? (
                <span
                  id="import-pack-permission"
                  className="font-mono text-[10px] uppercase tracking-widest text-warning"
                >
                  Needs the workflows.manage permission
                </span>
              ) : null}
            </div>
            <Button
              type="button"
              size="sm"
              disabled={create.isPending}
              onClick={() => createWorkflow()}
            >
              {pendingCreateId === NEW_WORKFLOW_ID ? (
                <Loader2
                  className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Plus className="mr-1.5 size-3.5" aria-hidden="true" />
              )}
              {pendingCreateId === NEW_WORKFLOW_ID ? "Creating…" : "New workflow"}
            </Button>
          </div>
        }
        meta={
          <div role="group" aria-label="Rows to load" className="flex items-center gap-1">
            <span className="mr-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Rows
            </span>
            {ATLAS_LIMIT_OPTIONS.map((option) => (
              <FilterChip
                key={option}
                active={limit === option}
                onClick={() => void navigate({ search: { limit: option } })}
              >
                {option}
              </FilterChip>
            ))}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/* Outside the list branches on purpose: creating the first workflow fails from the
            empty state, which is exactly where the message would otherwise be invisible. */}
        {create.error ? (
          <p role="alert" className="mb-4 text-xs text-destructive">
            {create.error.message}
          </p>
        ) : null}
        {workflows.isPending ? (
          <LoadingState label="Loading workflows" />
        ) : workflows.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(workflows.error)}
            onRetry={() => void workflows.refetch()}
          />
        ) : workflows.data.items.length === 0 ? (
          // No workflows yet: the operator's (empty) list still leads, then the starters are
          // shown prominently as the way forward.
          <>
            <section className="mb-8" aria-labelledby="your-workflows-heading">
              <h2
                id="your-workflows-heading"
                className="mb-3 text-sm font-bold uppercase tracking-wider"
              >
                Your workflows
              </h2>
              <EmptyHint>
                <Workflow
                  className="mx-auto mb-3 size-6 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="font-medium text-foreground">No workflow definitions in Atlas yet</p>
                <p className="mt-1">
                  Create a blank workflow, or start from one of the templates below.
                </p>
                <div className="mt-4 flex justify-center">
                  <Button
                    type="button"
                    size="sm"
                    disabled={create.isPending}
                    onClick={() => createWorkflow()}
                  >
                    {pendingCreateId === NEW_WORKFLOW_ID ? (
                      <Loader2
                        className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <Plus className="mr-1.5 size-3.5" aria-hidden="true" />
                    )}
                    {pendingCreateId === NEW_WORKFLOW_ID ? "Creating…" : "New workflow"}
                  </Button>
                </div>
              </EmptyHint>
            </section>
            <section aria-labelledby="starter-workflows-heading">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2
                    id="starter-workflows-heading"
                    className="text-sm font-bold uppercase tracking-wider"
                  >
                    Starter workflows
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Four Atlas-native examples you can create and customize.
                  </p>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Ready to use
                </span>
              </div>
              {starterGrid}
            </section>
          </>
        ) : (
          // Return visits lead with the operator's own list; starters collapse into a disclosure.
          <>
            <section className="mb-8" aria-labelledby="your-workflows-heading">
              <h2
                id="your-workflows-heading"
                className="mb-3 text-sm font-bold uppercase tracking-wider"
              >
                Your workflows
              </h2>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {workflows.data.items.map((w) => (
                  <Link
                    key={w.id}
                    to="/workflows/$id"
                    params={{ id: w.id }}
                    className="group flex flex-col rounded-lg border border-border bg-card p-5 transition hover:border-primary/40"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-base font-bold">{w.name}</div>
                        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {w.description || "No description."}
                        </div>
                      </div>
                      <StatusPill tone={w.status.tone}>{w.status.label}</StatusPill>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      <span>{counted(w.nodeCount, "node")}</span>
                      <span>{counted(w.edgeCount, "edge")}</span>
                      <span>v{w.version}</span>
                      <span className="w-full">updated {w.updatedAt}</span>
                    </div>
                  </Link>
                ))}
              </div>
              <WindowNotice
                count={workflows.data.items.length}
                limit={workflows.data.limit}
                mayHaveMore={workflows.data.mayHaveMore}
                noun="workflow"
              />
            </section>
            <details className="group rounded-lg border border-border bg-card/40">
              <summary className="flex cursor-pointer items-center gap-2 rounded-lg px-4 py-3 text-sm font-bold uppercase tracking-wider transition-colors hover:bg-highlight/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
                  aria-hidden="true"
                />
                Start from a template
              </summary>
              <div className="border-t border-border p-4">
                <p className="mb-3 text-xs text-muted-foreground">
                  Four Atlas-native examples you can create and customize.
                </p>
                {starterGrid}
              </div>
            </details>
          </>
        )}
      </div>
      <WorkflowPackImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
