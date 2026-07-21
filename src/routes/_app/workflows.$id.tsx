import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { PageHeader } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState, NotFoundState } from "@/components/atlas/states";
import { WorkflowEditor, type WorkflowDraft } from "@/components/atlas/workflow-editor";
import { clearSemanticWorkflowDraft } from "@/components/atlas/workflow-draft";
import { migrateLayoutVersion } from "@/components/atlas/workflow-layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toClientAtlasError } from "@/lib/atlas-mappers";
import {
  useDeleteWorkflow,
  useSaveWorkflow,
  useStartRun,
  useValidateWorkflow,
} from "@/lib/atlas-mutations";
import { editableWorkflowQuery } from "@/lib/atlas-queries";
import { mapAtlasValidationMessage, type ValidationIssue } from "@/lib/workflow-graph";

/**
 * The workflow editor, backed by Atlas.
 *
 * Loading it is allowed to fail in a way the page has to respect: `graph.ok === false` means
 * Atlas is storing a graph this editor's model cannot represent. Rather than loading the parts
 * that parsed — which would delete the rest on the next save — the page refuses to edit and
 * says why. That is the fail-closed rule made visible.
 */
export const Route = createFileRoute("/_app/workflows/$id")({
  loader: async ({ context, params }) => {
    try {
      return await context.queryClient.ensureQueryData(editableWorkflowQuery(params.id));
    } catch (error) {
      // Atlas's 404 is this route's not-found, not a crash. Everything else — forbidden,
      // timeout, Atlas down — is rethrown so `errorComponent` can say which.
      if (toClientAtlasError(error).kind === "not_found") throw notFound();
      throw error;
    }
  },
  component: WorkflowEditorRoute,
  pendingComponent: () => <LoadingState label="Loading workflow" />,
  errorComponent: ({ error, reset }) => (
    <AtlasErrorState error={toClientAtlasError(error)} onRetry={reset} />
  ),
  notFoundComponent: () => (
    <NotFoundState description="Atlas has no workflow definition with that id." />
  ),
  head: ({ params }) => ({ meta: [{ title: `Workflow ${params.id} · Atlas Control` }] }),
});

function WorkflowEditorRoute() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  /**
   * Seeded from the loader so hydration does not refetch.
   *
   * The loader populates the *server's* QueryClient and this app does not dehydrate it, so
   * without `initialData` the browser would start empty and immediately re-request — undoing
   * the reason the loader exists.
   */
  const { data: workflow } = useQuery({
    ...editableWorkflowQuery(id),
    initialData: Route.useLoaderData(),
  });

  const save = useSaveWorkflow();
  const validate = useValidateWorkflow();
  const startRun = useStartRun();
  const remove = useDeleteWorkflow();

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; message: string } | null>(null);
  const [atlasValidationIssues, setAtlasValidationIssues] = useState<ValidationIssue[]>([]);
  /**
   * Counts saves that landed, which is the signal the editor re-baselines on.
   *
   * `updated_at` cannot serve: Atlas stamps it to whole seconds, so a save that follows the
   * previous write inside the same second returns an identical value and looks like nothing
   * happened.
   */
  const [saveCount, setSaveCount] = useState(0);
  const [expectedVersionOverride, setExpectedVersionOverride] = useState<number | undefined>();
  const [conflictServer, setConflictServer] = useState<typeof workflow | null>(null);
  const [conflictLocalVersion, setConflictLocalVersion] = useState<number | undefined>();
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * Rejections from the server, anchored to a node, edge, or policy field.
   *
   * Two sources end up here. Our own server-side re-validation returns the full issue list with
   * targets already attached; Atlas returns one sentence, which `mapAtlasValidationMessage`
   * reads the subject out of. Either way the editor highlights the same thing the local checks
   * would have.
   */
  // Memoised because it feeds the editor's `issues` memo, which feeds the React Flow node list:
  // a fresh array on every render would defeat all of them and reconcile the whole canvas on
  // every keystroke in an inspector field.
  const serverIssues: ValidationIssue[] = useMemo(() => {
    const saveIssues = !save.error
      ? []
      : save.error.rejection
        ? save.error.rejection.issues
        : save.error.kind === "validation"
          ? [mapAtlasValidationMessage(save.error.message)]
          : [];
    return [...saveIssues, ...atlasValidationIssues];
  }, [save.error, atlasValidationIssues]);

  const onSave = (draft: WorkflowDraft) => {
    setValidation(null);
    setAtlasValidationIssues([]);
    save.mutate(
      {
        workflowId: id,
        name: draft.name,
        description: draft.description,
        graph: draft.graph,
        policy: draft.policy,
        defaultReply: draft.defaultReply,
        expectedVersion: draft.expectedVersion,
      },
      {
        onSuccess: (saved) => {
          migrateLayoutVersion(id, draft.expectedVersion, saved.version);
          clearSemanticWorkflowDraft(id, draft.expectedVersion);
          setExpectedVersionOverride(saved.version);
          setConflictServer(null);
          setSaveCount((count) => count + 1);
        },
        onError: async (error) => {
          if (error.kind !== "conflict") return;
          const server = await queryClient.fetchQuery(editableWorkflowQuery(id));
          setConflictServer(server);
          setConflictLocalVersion(draft.expectedVersion);
        },
      },
    );
  };

  if (!workflow.graph.ok) {
    return (
      <>
        <PageHeader
          title={workflow.name}
          subtitle={workflow.description || "No description."}
          meta={
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {workflow.id} · {workflow.status} · v{workflow.version} · updated{" "}
              {workflow.updatedAtLabel}
            </span>
          }
          actions={
            <Link
              to="/runs"
              search={{ limit: 100, workflow: workflow.id, state: undefined }}
              className="inline-flex items-center rounded border border-border bg-secondary/40 px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition hover:bg-secondary"
            >
              View runs
            </Link>
          }
        />
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div
            role="alert"
            className="max-w-2xl rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
          >
            <h2 className="text-sm font-semibold text-foreground">
              This workflow cannot be opened in the editor
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Atlas is storing a graph that uses something this editor does not model:{" "}
              <span className="font-mono text-foreground">{workflow.graph.reason}</span>
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Editing it here would mean saving back only the part that was understood, deleting the
              rest. It is left untouched instead. It can still be run, and its runs can still be
              inspected.
            </p>
          </div>
        </div>
      </>
    );
  }

  const { graph, policy } = workflow.graph;

  return (
    <>
      <PageHeader
        title={workflow.name}
        subtitle={workflow.description || "No description."}
        meta={
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {workflow.id} · {workflow.status} · v{workflow.version} · updated{" "}
            {workflow.updatedAtLabel}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/runs"
              search={{ limit: 100, workflow: workflow.id, state: undefined }}
              className="inline-flex items-center rounded border border-border bg-secondary/40 px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition hover:bg-secondary"
            >
              View runs
            </Link>
            <AlertDialog
              open={confirmingDelete}
              onOpenChange={(next) => {
                // No dismissal while the delete is in flight — Escape here would present an
                // unresolved mutation as abandoned.
                if (!next && remove.isPending) return;
                setConfirmingDelete(next);
              }}
            >
              <AlertDialogTrigger asChild>
                <Button type="button" size="sm" variant="outline" disabled={remove.isPending}>
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete “{workflow.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Atlas removes the definition and cascades its triggers and run history. This
                    cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={remove.isPending}>Keep it</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={remove.isPending}
                    onClick={(event) => {
                      // Keep the dialog open until Atlas confirms: closing on click would
                      // present a refusal as a completed delete. Success navigates away,
                      // which unmounts the dialog with the page.
                      event.preventDefault();
                      remove.mutate(
                        { workflowId: id },
                        {
                          onSuccess: () => navigate({ to: "/workflows", search: { limit: 100 } }),
                          // Close on refusal so the page-level alert underneath is readable.
                          onError: () => setConfirmingDelete(false),
                        },
                      );
                    }}
                  >
                    {remove.isPending ? "Deleting…" : "Delete workflow"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        }
      />

      {remove.error ? (
        <p role="alert" className="bg-destructive/10 px-8 py-2 text-xs text-destructive">
          {remove.error.message}
        </p>
      ) : null}

      {conflictServer ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/40 bg-warning/10 px-8 py-3 text-xs text-foreground"
        >
          <span>
            Atlas rejected this save because the server is now at version {conflictServer.version}.
            Your local draft is still intact; compare it before choosing what to do.
          </span>
          <span className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (conflictLocalVersion !== undefined) {
                  clearSemanticWorkflowDraft(id, conflictLocalVersion);
                }
                setConflictServer(null);
                setConflictLocalVersion(undefined);
                setExpectedVersionOverride(undefined);
                setReloadKey((key) => key + 1);
              }}
            >
              Reload server state
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setExpectedVersionOverride(conflictServer.version);
                setConflictServer(null);
                setConflictLocalVersion(undefined);
              }}
            >
              Keep local draft
            </Button>
          </span>
        </div>
      ) : null}

      <WorkflowEditor
        // Keyed on the workflow alone. Adding the timestamp would remount on every successful
        // save — discarding anything typed while the save was in flight — and on every refetch
        // that pulled in someone else's write, silently replacing the operator's draft with it.
        // The editor handles both cases itself: it re-baselines against what it sent, and warns
        // when the server moved underneath it.
        key={`${workflow.id}:${reloadKey}`}
        workflowId={workflow.id}
        graphVersion={workflow.version}
        initialName={workflow.name}
        initialDescription={workflow.description}
        initialGraph={graph}
        initialPolicy={policy}
        initialDefaultReply={workflow.defaultReply}
        savedAt={workflow.updatedAt}
        saveCount={saveCount}
        saving={save.isPending}
        serverIssues={serverIssues}
        saveError={save.error?.kind === "conflict" ? null : save.error ? save.error.message : null}
        expectedVersionOverride={expectedVersionOverride}
        onSave={onSave}
        validating={validate.isPending}
        atlasValidation={validation}
        onValidateWithAtlas={(draft) => {
          setValidation(null);
          setAtlasValidationIssues([]);
          validate.mutate(
            { workflowId: id, graph: draft.graph, policy: draft.policy },
            {
              onSuccess: () =>
                setValidation({
                  ok: true,
                  message:
                    "Atlas accepted this graph, including its worker and workspace references.",
                }),
              onError: (error) => {
                setValidation({ ok: false, message: error.message });
                if (error.kind === "validation") {
                  setAtlasValidationIssues([mapAtlasValidationMessage(error.message)]);
                }
              },
            },
          );
        }}
        running={startRun.isPending}
        onRun={() =>
          startRun.mutate(
            { workflowDefinitionId: id },
            {
              // Atlas answers with the real run row, so the id in this URL is Atlas's — not a
              // number minted in the browser the way the scaffold did it.
              onSuccess: (run) => navigate({ to: "/runs/$id", params: { id: run.id } }),
              onError: (error) => setValidation({ ok: false, message: error.message }),
            },
          )
        }
      />
    </>
  );
}
