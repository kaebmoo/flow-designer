import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { PageHeader } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState, NotFoundState } from "@/components/atlas/states";
import { WorkflowEditor, type WorkflowDraft } from "@/components/atlas/workflow-editor";
import { WorkflowTestRunDialog } from "@/components/atlas/workflow-test-run-dialog";
import { WorkflowPackExportAction } from "@/components/atlas/workflow-pack-export-action";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { toClientAtlasError } from "@/lib/atlas-mappers";
import { isWorkflowStatus } from "@/lib/atlas-types";
import {
  useDeleteWorkflow,
  useSaveWorkflow,
  useStartRun,
  useValidateWorkflow,
} from "@/lib/atlas-mutations";
import { editableWorkflowQuery } from "@/lib/atlas-queries";
import { mapAtlasValidationMessage, type ValidationIssue } from "@/lib/workflow-graph";
import { observeWorkflowContract } from "@/lib/workflow-run-contract";

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

const appRoute = getRouteApi("/_app");

function WorkflowEditorRoute() {
  const { id } = Route.useParams();
  const identity = appRoute.useLoaderData();
  /**
   * UX only. Atlas re-checks the real role on every call and answers a viewer's start with 403
   * regardless of what this says, so this exists to avoid offering a control that can only fail —
   * never as the security boundary. `tests/e2e/test-run.spec.ts` asserts both halves.
   */
  const role = identity.status === "authenticated" ? identity.identity.role : null;
  const canStartRuns = role === "admin" || role === "operator";
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
  const [testRunOpen, setTestRunOpen] = useState(false);
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
   * The workflow version the mounted editor is showing.
   *
   * The editor is keyed on the workflow id alone, deliberately — remounting it on every refetch
   * would discard whatever was being typed. The cost is that a *background* refetch can pull in
   * another tab's save while the canvas keeps drawing the graph it loaded. Left alone, the Test
   * run dialog would then describe, and Atlas would then execute, a graph nobody on this screen
   * has seen. Comparing this against the live `workflow.version` is how that is detected.
   *
   * It advances on our own successful save (the editor re-baselines there) and on an explicit
   * reload, so neither of those is mistaken for someone else's write.
   */
  const [editorBaseVersion, setEditorBaseVersion] = useState(workflow.version);
  const serverMoved = workflow.version !== editorBaseVersion;

  /**
   * An open dialog is closed when that happens, rather than left showing a stale contract with
   * its Start button quietly disabled underneath.
   */
  useEffect(() => {
    if (serverMoved) setTestRunOpen(false);
  }, [serverMoved]);

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

  const repairMessage =
    save.error?.kind === "validation"
      ? save.error.message
      : validation?.ok === false && atlasValidationIssues.length > 0
        ? validation.message
        : null;

  /**
   * The observed run interface of the **saved** graph.
   *
   * Derived from `workflow.graph`, not from the editor's draft, because Atlas runs the stored
   * graph — and the Run live test button is disabled while the editor is dirty for the same reason.
   * Computed before the unparseable-graph return below so the hook order is unconditional.
   */
  const contract = useMemo(
    () =>
      workflow.graph.ok
        ? observeWorkflowContract(workflow.graph.graph, {
            workflowId: workflow.id,
            observedVersion: workflow.version,
          })
        : null,
    [workflow.graph, workflow.id, workflow.version],
  );

  /**
   * The workflow's authoritative interface, when it is one this client understands.
   *
   * `"unsupported"` is deliberately treated the same as `"absent"` here: this client cannot
   * render that version's shape to prefill or validate against, so Test Run falls back to the
   * Observed path rather than claiming a declared contract it cannot actually show.
   */
  const declaredInterface = workflow.interface.kind === "v1" ? workflow.interface.value : null;

  const onSave = (draft: WorkflowDraft) => {
    setValidation(null);
    setAtlasValidationIssues([]);
    save.mutate(
      {
        workflowId: id,
        name: draft.name,
        description: draft.description,
        // Send only a valid closed-vocabulary value; a legacy stored status the operator
        // did not touch is omitted so the save cannot be rejected for a field they never saw.
        status: isWorkflowStatus(draft.status) ? draft.status : undefined,
        graph: draft.graph,
        policy: draft.policy,
        defaultReply: draft.defaultReply,
        interface: draft.interface,
        expectedVersion: draft.expectedVersion,
      },
      {
        onSuccess: (saved) => {
          migrateLayoutVersion(id, draft.expectedVersion, saved.version);
          clearSemanticWorkflowDraft(id, draft.expectedVersion);
          setExpectedVersionOverride(saved.version);
          setEditorBaseVersion(saved.version);
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

  /**
   * The workflow-level actions, shared by both branches below.
   *
   * The editable branch renders them inside the editor's own header — the name and description
   * are edited where they are displayed, rather than repeated as cramped toolbar fields — and
   * the unparseable-graph branch renders them in its own `PageHeader`. Building them once is
   * what keeps the two honest: a workflow this editor refuses to open still has to be
   * exportable, inspectable, and deletable, and an earlier copy of that branch carried its own
   * hand-rolled pair of controls with Delete missing, which left such a workflow unremovable
   * from the UI entirely.
   */
  const headerActions = (
    <>
      <WorkflowPackExportAction definitionId={workflow.id} workflowName={workflow.name} />
      {/* Same control recipe as its siblings, so the three actions sit on one crisp line. */}
      <Button asChild size="sm" variant="outline">
        <Link to="/runs" search={{ limit: 100, workflow: workflow.id, state: undefined }}>
          View runs
        </Link>
      </Button>
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
              Atlas removes the definition and cascades its triggers and run history. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Keep it</AlertDialogCancel>
            {/*
              Destructive, not the default cyan.

              `AlertDialogAction` inherits `buttonVariants()`, so the action that cascades this
              workflow's triggers and its entire run history was rendering in the same runway
              cyan as Save, while "Keep it" — the safe choice — was the quiet outline. The
              weighting said the opposite of the copy directly above it.
            */}
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
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
    </>
  );

  if (!workflow.graph.ok) {
    return (
      <>
        {remove.error ? (
          <p role="alert" className="bg-destructive/10 px-8 py-2 text-xs text-destructive">
            {remove.error.message}
          </p>
        ) : null}
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
            <div className="flex max-w-full flex-wrap items-start justify-end gap-2">
              {headerActions}
            </div>
          }
        />
        <div className="flex-1 overflow-y-auto px-8 py-6">
          {/*
            No `role="alert"`: nothing here is dynamic.

            This block is the whole page at load, not an interruption during a task, and an
            assertive live region fired on every visit — talking over the heading a screen reader
            was already about to read. The `<h2>` and the prose carry it in the normal reading
            order, which is where a page-level explanation belongs.
          */}
          <div className="max-w-2xl rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
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
      {remove.error ? (
        <p role="alert" className="bg-destructive/10 px-8 py-2 text-xs text-destructive">
          {remove.error.message}
        </p>
      ) : null}

      {/*
        Suppressed while a save conflict is showing: that banner says the same thing about the
        same event, and offers the better pair of actions (reload, or keep the local draft).
        The Run live test guard itself is unconditional — it keys on `serverMoved`, not on this.
      */}
      {serverMoved && !conflictServer ? (
        <div
          role="alert"
          data-testid="workflow-server-moved"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/40 bg-warning/10 px-8 py-3 text-xs text-foreground"
        >
          <span>
            This workflow was saved elsewhere and is now at version {workflow.version}; the canvas
            below is still showing version {editorBaseVersion}. Live test is unavailable until you
            reload, because Atlas runs the stored graph, not the one drawn here. Anything unsaved in
            this tab is kept.
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setEditorBaseVersion(workflow.version);
              setExpectedVersionOverride(undefined);
              setReloadKey((key) => key + 1);
            }}
          >
            Reload server state
          </Button>
        </div>
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
                setEditorBaseVersion(workflow.version);
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
        serverMoved={serverMoved}
        initialName={workflow.name}
        initialDescription={workflow.description}
        initialStatus={workflow.status}
        updatedAtLabel={workflow.updatedAtLabel}
        headerActions={headerActions}
        initialGraph={graph}
        initialPolicy={policy}
        initialDefaultReply={workflow.defaultReply}
        initialInterface={workflow.interface}
        savedAt={workflow.updatedAt}
        saveCount={saveCount}
        saving={save.isPending}
        serverIssues={serverIssues}
        saveError={save.error?.kind === "conflict" ? null : save.error ? save.error.message : null}
        repairMessage={repairMessage}
        onRepairAccepted={() => {
          setValidation(null);
          setAtlasValidationIssues([]);
          save.reset();
          validate.reset();
        }}
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
        // Opens the dialog; it does not start anything. The only mutation is the explicit
        // `Start live test` click inside it. Withheld entirely once Atlas has moved past the
        // version this canvas is drawing — Atlas runs the stored graph, so testing from here
        // would run something the operator cannot see.
        onRun={serverMoved || !canStartRuns ? undefined : () => setTestRunOpen(true)}
        runDisabledReason={
          !canStartRuns
            ? "Your Atlas role cannot start workflow runs."
            : serverMoved
              ? `This workflow is now at version ${workflow.version} in Atlas; this canvas is showing version ${editorBaseVersion}. Reload before testing.`
              : undefined
        }
      />

      {contract === null ? null : (
        <WorkflowTestRunDialog
          open={testRunOpen}
          // The last attempt's error is cleared on *close*, not on open. Resetting inside the
          // opening click re-renders this toolbar in the same tick the browser is focusing the
          // button that was clicked, and the dialog then captures `body` as the element to
          // restore focus to on close — which strands a keyboard user at the top of the document.
          onOpenChange={(next) => {
            setTestRunOpen(next);
            if (!next) startRun.reset();
          }}
          contract={contract}
          declaredInterface={declaredInterface}
          workflowVersion={workflow.version}
          workflowName={workflow.name}
          pending={startRun.isPending}
          error={
            startRun.error
              ? {
                  kind: startRun.error.kind,
                  message: startRun.error.message,
                  code: startRun.error.code,
                }
              : null
          }
          onStart={(input, options) =>
            startRun.mutate(
              {
                workflowDefinitionId: id,
                input,
                // Explicit test mode: the only run class a Draft workflow may start.
                // Production/direct starts elsewhere send "production" and Atlas gates both.
                executionMode: "test",
                // Sent only in declared mode: Atlas compares it against the same definition row
                // it loads to start the run and answers 409 with no run created on a mismatch.
                expectedWorkflowVersion: declaredInterface ? workflow.version : undefined,
                // Held start: Atlas creates the run born-paused; the run page is where files
                // are attached and Resume is pressed.
                hold: options.hold ? true : undefined,
              },
              {
                // Atlas answers with the real run row, so the id in this URL is Atlas's — not a
                // number minted in the browser the way the scaffold did it.
                onSuccess: (run) => navigate({ to: "/runs/$id", params: { id: run.id } }),
                // The dialog stays open and renders `startRun.error`: closing on refusal would
                // discard the payload the operator would need to retype to try again.
              },
            )
          }
        />
      )}
    </>
  );
}
