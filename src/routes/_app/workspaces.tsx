import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { AlertTriangle, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { useReturnFocus } from "@/hooks/use-return-focus";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  describeAtlasError,
  toClientAtlasError,
  type WorkerView,
  type WorkspaceView,
} from "@/lib/atlas-mappers";
import { AtlasMutationError, useDeleteWorkspace, useUpsertWorkspace } from "@/lib/atlas-mutations";
import { workersQuery, workspacesQuery } from "@/lib/atlas-queries";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/workspaces")({
  component: WorkspacesPage,
  head: () => ({ meta: [{ title: "Workspaces · Atlas Control" }] }),
});

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * The kinds whose message Atlas actually wrote for the caller.
 *
 * Everything else gets this UI's copy: a permission failure, for instance, is literally
 * `{"error": "forbidden"}` (`atlas/app.py:241`) and reaches the browser as that one word.
 */
const KINDS_WITH_ATLAS_COPY = new Set<AtlasMutationError["kind"]>(["validation", "conflict"]);

/** Reports a refused mutation through the same copy every other Atlas failure state uses. */
function MutationAlert({ error }: { error: AtlasMutationError | null }) {
  if (!error) return null;
  const { title, description } = describeAtlasError({
    kind: error.kind,
    message: KINDS_WITH_ATLAS_COPY.has(error.kind) ? error.message : "",
  });
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        <span className="font-medium">{title}.</span> {description}
      </span>
    </div>
  );
}

/**
 * Carries a control's explanation on a wrapper rather than on the control.
 *
 * `buttonVariants` sets `disabled:pointer-events-none` (`src/components/ui/button.tsx`), so a
 * disabled button never receives a hover and a `title` on it can never be rendered. The wrapper
 * still receives the pointer, which is the only way these reasons reach the screen.
 */
function ControlReason({
  reason,
  children,
}: {
  reason: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex" title={reason}>
      {children}
    </span>
  );
}

/**
 * Workspaces, read from `GET /api/workspaces`, with the mutations Atlas exposes for them.
 *
 * The directory is whatever Atlas recorded for the worker machine, and Atlas exposes no
 * per-workspace job count, so no such column is shown. Writing needs the `resources.manage`
 * permission — admin or operator (`atlas/app.py:70-72,1211`) — which is used to disable
 * controls and explain why; Atlas re-checks on every call and remains the only authority.
 */
function WorkspacesPage() {
  const identity = appRoute.useLoaderData();
  const role = identity.status === "authenticated" ? identity.identity.role : null;
  const roleLabel = identity.status === "authenticated" ? identity.identity.roleLabel : "unknown";
  const canManage = role === "admin" || role === "operator";

  const workspaces = useQuery(workspacesQuery());
  // A workspace cannot exist without a worker, so the form needs the fleet to offer a choice.
  const workers = useQuery(workersQuery());

  const [form, setForm] = useState<{ workspace: WorkspaceView | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceView | null>(null);
  const deleteFocus = useReturnFocus();

  // A failed background refetch flips a query that already holds data to status `error`, so
  // whether a worker can be chosen is decided by the data itself, never by the status.
  const workerList = workers.data;
  const noWorkers = workerList !== undefined && workerList.length === 0;
  const workerListReason =
    workerList !== undefined
      ? null
      : workers.isError
        ? "Atlas's worker list could not be loaded, so no worker can be chosen."
        : "Waiting for Atlas's worker list.";
  const addReason = !canManage
    ? `Mapping a workspace requires the operator or admin role — yours is ${roleLabel}.`
    : (workerListReason ??
      (noWorkers ? "Atlas has no workers. Register one on the Fleet page first." : null));
  const editReason = !canManage
    ? `Editing a workspace requires the operator or admin role — yours is ${roleLabel}.`
    : workerListReason;

  return (
    <>
      <PageHeader
        title="Workspaces"
        subtitle="Project directories exposed by each worker. The workspace_key resolves on the worker machine."
        meta={
          <div className="space-y-1">
            {workspaces.data ? (
              <span className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {workspaces.data.length} workspace{workspaces.data.length === 1 ? "" : "s"} mapped
              </span>
            ) : null}
            {canManage ? null : (
              <span className="block text-[11px] text-muted-foreground">
                Mapping and removing workspaces requires the Atlas operator or admin role — yours is{" "}
                {roleLabel}.
              </span>
            )}
            {canManage && noWorkers ? (
              <span className="block text-[11px] text-muted-foreground">
                Atlas has no workers, and a workspace must belong to one. Register a worker on the
                Fleet page first.
              </span>
            ) : null}
          </div>
        }
        actions={
          <ControlReason reason={addReason ?? undefined}>
            <Button
              size="sm"
              disabled={addReason !== null}
              onClick={() => setForm({ workspace: null })}
            >
              <Plus aria-hidden="true" />
              Map workspace
            </Button>
          </ControlReason>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {workspaces.isPending ? (
          <LoadingState label="Loading workspaces" />
        ) : workspaces.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(workspaces.error)}
            onRetry={() => void workspaces.refetch()}
          />
        ) : (
          <DataTable
            rows={workspaces.data}
            rowKey={(w) => w.id}
            empty="Atlas has no workspaces mapped to a worker."
            columns={[
              {
                key: "workspaceKey",
                header: "Workspace Key",
                render: (w) => (
                  <span className="font-mono text-sm text-primary">{w.workspaceKey}</span>
                ),
              },
              {
                key: "company",
                header: "Company",
                render: (w) => <span className="text-sm">{w.company || "—"}</span>,
              },
              {
                key: "workerName",
                header: "Worker",
                render: (w) => (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{w.workerName}</span>
                    <StatusPill tone={w.workerStatus.tone}>{w.workerStatus.label}</StatusPill>
                  </div>
                ),
              },
              {
                key: "workspaceDir",
                header: "Directory (on worker)",
                render: (w) => (
                  <span className="font-mono text-xs text-muted-foreground">{w.workspaceDir}</span>
                ),
              },
              {
                key: "tags",
                header: "Tags",
                render: (w) =>
                  w.tags.length === 0 ? (
                    <span className="font-mono text-xs text-muted-foreground">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {w.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded border border-border bg-secondary/40 px-1.5 py-0.5 font-mono text-[10px]"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ),
              },
              {
                key: "actions",
                header: "Actions",
                className: "text-right",
                render: (w) => (
                  <div className="flex justify-end gap-1">
                    <ControlReason
                      reason={editReason === null ? `Edit ${w.workspaceKey}` : editReason}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={editReason !== null}
                        onClick={() => setForm({ workspace: w })}
                      >
                        <Pencil aria-hidden="true" />
                        <span className="sr-only">Edit {w.workspaceKey}</span>
                      </Button>
                    </ControlReason>
                    <ControlReason
                      reason={
                        canManage
                          ? `Delete ${w.workspaceKey}`
                          : `Deleting a workspace requires the operator or admin role — yours is ${roleLabel}.`
                      }
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canManage}
                        onClick={(event) => {
                          deleteFocus.capture(event.currentTarget);
                          setPendingDelete(w);
                        }}
                      >
                        <Trash2 className="text-destructive" aria-hidden="true" />
                        <span className="sr-only">Delete {w.workspaceKey}</span>
                      </Button>
                    </ControlReason>
                  </div>
                ),
              },
            ]}
          />
        )}
      </div>

      {/* Mounted on the data, not the status: unmounting on a failed background refetch would
          throw away everything the operator has typed. */}
      {form && workerList ? (
        <WorkspaceFormDialog
          key={form.workspace?.id ?? "new-workspace"}
          workspace={form.workspace}
          workers={workerList}
          workersStale={workers.isError}
          existing={workspaces.data ?? []}
          onClose={() => setForm(null)}
        />
      ) : null}

      {pendingDelete ? (
        <DeleteWorkspaceDialog
          key={pendingDelete.id}
          workspace={pendingDelete}
          onClose={() => {
            setPendingDelete(null);
            deleteFocus.restore();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Add and edit are one dialog because Atlas has one endpoint.
 *
 * `POST /api/workspaces` upserts on `id` **or** `(worker_id, workspace_key)`
 * (`atlas/db.py:2162-2165`), so mapping a key a worker already exposes rewrites that mapping
 * rather than adding a second one. The form warns while the key can still be changed.
 */
function WorkspaceFormDialog({
  workspace,
  workers,
  workersStale,
  existing,
  onClose,
}: {
  workspace: WorkspaceView | null;
  workers: WorkerView[];
  /** The worker list is still the one this dialog opened with, but Atlas refused to refresh it. */
  workersStale: boolean;
  existing: WorkspaceView[];
  onClose: () => void;
}) {
  const upsert = useUpsertWorkspace();

  const [workerId, setWorkerId] = useState(workspace?.workerId ?? "");
  const [workspaceKey, setWorkspaceKey] = useState(workspace?.workspaceKey ?? "");
  const [workspaceDir, setWorkspaceDir] = useState(workspace?.workspaceDir ?? "");
  const [company, setCompany] = useState(workspace?.company ?? "");
  const [tags, setTags] = useState((workspace?.tags ?? []).join(", "));

  // Atlas checks worker_id, then workspace_key, then workspace_dir, and reports only the first
  // failure (`atlas/db.py:2158-2160`). Surfacing them in that order means the message here and
  // the message Atlas would return never disagree.
  const missing =
    workerId.trim().length === 0
      ? "Choose the worker this workspace lives on."
      : workspaceKey.trim().length === 0
        ? "A workspace key is required."
        : workspaceDir.trim().length === 0
          ? "A directory on the worker is required."
          : null;

  const collision =
    missing === null
      ? existing.find(
          (w) =>
            w.id !== workspace?.id &&
            w.workerId === workerId &&
            w.workspaceKey === workspaceKey.trim(),
        )
      : undefined;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (missing !== null) return;
    upsert.mutate(
      {
        workspaceId: workspace?.id,
        workerId,
        workspaceKey: workspaceKey.trim(),
        workspaceDir: workspaceDir.trim(),
        company: company.trim(),
        tags: parseTags(tags),
      },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {workspace ? `Edit ${workspace.workspaceKey}` : "Map a workspace"}
            </DialogTitle>
            <DialogDescription>
              Atlas matches a workspace by id, or by worker and key, and writes whichever it finds.
              There is no separate create and update.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {workersStale ? (
              <div
                role="status"
                className="flex gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs leading-relaxed text-foreground"
              >
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent"
                  aria-hidden="true"
                />
                <span>
                  Atlas&apos;s worker list could not be refreshed, so the workers offered here are
                  the ones loaded earlier and may be out of date. Nothing typed here is lost —
                  finish or cancel, then reload the page.
                </span>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="workspace-worker">Worker</Label>
              <Select value={workerId} onValueChange={setWorkerId}>
                <SelectTrigger id="workspace-worker">
                  <SelectValue placeholder="Choose a worker" />
                </SelectTrigger>
                <SelectContent>
                  {workers.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                        {w.baseUrl}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="workspace-key">Workspace key</Label>
              <Input
                id="workspace-key"
                value={workspaceKey}
                onChange={(e) => setWorkspaceKey(e.target.value)}
                placeholder="acme-web"
                autoComplete="off"
                required
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                How jobs address this workspace. Unique per worker.
              </p>
            </div>

            {collision ? (
              <div
                role="alert"
                className="flex gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs leading-relaxed text-foreground"
              >
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent"
                  aria-hidden="true"
                />
                <span>
                  That worker already exposes{" "}
                  <span className="font-medium">{collision.workspaceKey}</span>, pointing at{" "}
                  <span className="font-mono">{collision.workspaceDir}</span>. Saving overwrites
                  that mapping instead of adding a second one.
                </span>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="workspace-dir">Directory on the worker</Label>
              <Input
                id="workspace-dir"
                value={workspaceDir}
                onChange={(e) => setWorkspaceDir(e.target.value)}
                placeholder="/srv/projects/acme-web"
                autoComplete="off"
                required
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Resolved on the worker machine. Atlas never checks that it exists.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="workspace-company">Company</Label>
              <Input
                id="workspace-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Acme"
                autoComplete="off"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="workspace-tags">Tags</Label>
              <Input
                id="workspace-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="frontend, staging"
                autoComplete="off"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">Comma separated.</p>
            </div>

            {missing ? <p className="text-[11px] text-muted-foreground">{missing}</p> : null}
            <MutationAlert error={upsert.error} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={upsert.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={missing !== null || upsert.isPending}>
              {upsert.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {collision
                ? "Overwrite existing mapping"
                : workspace
                  ? "Save workspace"
                  : "Map workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirms `DELETE /api/workspaces/{id}`.
 *
 * Unlike a worker, this never fails on history: Atlas declares `jobs.workspace_id` as
 * `ON DELETE SET NULL` (`atlas/db.py:246,269`), so past jobs survive with no workspace rather
 * than blocking the delete. That is the consequence worth stating — the rows stay, the link
 * does not.
 */
function DeleteWorkspaceDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceView;
  onClose: () => void;
}) {
  const remove = useDeleteWorkspace();

  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {workspace.workspaceKey}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the mapping from {workspace.workerName} to{" "}
            <span className="font-mono">{workspace.workspaceDir}</span>. Nothing on the worker
            machine is touched.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-xs leading-relaxed">
          <p className="text-muted-foreground">
            Jobs that ran in this workspace are kept, but they lose their link to it and will show
            no workspace afterwards. Any future job addressing{" "}
            <span className="font-mono">{workspace.workspaceKey}</span> on this worker will fail to
            route until it is mapped again.
          </p>
          <MutationAlert error={remove.error} />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={remove.isPending}
            // Radix closes on click; the dialog has to stay open to report Atlas's refusal.
            onClick={(event) => {
              event.preventDefault();
              remove.mutate({ workspaceId: workspace.id }, { onSuccess: onClose });
            }}
          >
            {remove.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Delete workspace
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
