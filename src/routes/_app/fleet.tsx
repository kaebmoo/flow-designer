import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { AlertTriangle, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
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
  describeAtlasError,
  toClientAtlasError,
  type WorkerView,
  type WorkspaceView,
} from "@/lib/atlas-mappers";
import {
  AtlasMutationError,
  useDeleteWorker,
  usePollAllWorkers,
  usePollWorker,
  useUpsertWorker,
} from "@/lib/atlas-mutations";
import { workersQuery, workspacesQuery } from "@/lib/atlas-queries";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/fleet")({
  component: FleetPage,
  head: () => ({ meta: [{ title: "Fleet · Atlas Control" }] }),
});

/**
 * Atlas stores `base_url` with its trailing slashes removed and matches an upsert against that
 * stored value (`atlas/db.py:1959-1966`). The collision warning below is only truthful if it
 * compares the same canonical form Atlas will compare, hence normalising both sides.
 */
function canonicalBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString().replace(/\/+$/, "");
}

/** Workers registered outside this UI may hold a base_url Atlas never URL-normalised. */
function storedBaseUrlKey(value: string): string {
  return canonicalBaseUrl(value) ?? value.trim().replace(/\/+$/, "");
}

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

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-muted-foreground">{children}</p>;
}

/**
 * The worker fleet, read from `GET /api/workers`, with the mutations Atlas exposes for it.
 *
 * Every write here needs the Atlas `admin` permission except polling, which needs
 * `workers.poll` (`atlas/app.py:1207-1211`). The role from the session is used to disable
 * controls and say why — Atlas re-checks on every call and remains the only authority.
 */
function FleetPage() {
  const identity = appRoute.useLoaderData();
  const role = identity.status === "authenticated" ? identity.identity.role : null;
  const roleLabel = identity.status === "authenticated" ? identity.identity.roleLabel : "unknown";
  const canManage = role === "admin";
  const canPoll = role === "admin" || role === "operator";

  const workers = useQuery(workersQuery());
  // Read for the delete dialog: Atlas cascades a worker's workspaces away with it, and the
  // operator has to see which ones before confirming.
  const workspaces = useQuery(workspacesQuery());

  const [form, setForm] = useState<{ worker: WorkerView | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkerView | null>(null);

  const pollWorker = usePollWorker();
  const pollAll = usePollAllWorkers();
  // Atlas polls sequentially and each poll dials a remote machine, so a second poll fired on
  // top of a running one just queues behind it while the UI looks broken.
  const pollBusy = pollWorker.isPending || pollAll.isPending;
  const pollingWorkerId = pollWorker.isPending ? pollWorker.variables?.workerId : undefined;
  const pollError = pollWorker.error ?? pollAll.error;
  // One reason for every poll control, because they are all disabled by the same two facts.
  const pollReason = !canPoll
    ? `Polling requires the operator or admin role — yours is ${roleLabel}.`
    : pollBusy
      ? "A poll is already running. Atlas dials workers one at a time."
      : null;

  return (
    <>
      <PageHeader
        title="Fleet"
        subtitle="Every thClaws worker Atlas can route to. Health reflects Atlas's last poll."
        meta={
          <div className="space-y-1">
            {workers.data ? (
              <span className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {workers.data.length} worker{workers.data.length === 1 ? "" : "s"} registered
              </span>
            ) : null}
            {canManage ? null : (
              <span className="block text-[11px] text-muted-foreground">
                Adding, editing, and removing workers requires the Atlas admin role — yours is{" "}
                {roleLabel}.{canPoll ? " You can still re-poll." : " Polling is also unavailable."}
              </span>
            )}
          </div>
        }
        actions={
          <>
            <ControlReason reason={pollReason ?? "Atlas dials every worker in turn."}>
              <Button
                variant="outline"
                size="sm"
                disabled={!canPoll || pollBusy}
                onClick={() => pollAll.mutate(undefined)}
              >
                {pollAll.isPending ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
                Poll all
              </Button>
            </ControlReason>
            <ControlReason
              reason={
                canManage
                  ? undefined
                  : `Registering a worker requires the Atlas admin role — yours is ${roleLabel}.`
              }
            >
              <Button size="sm" disabled={!canManage} onClick={() => setForm({ worker: null })}>
                <Plus aria-hidden="true" />
                Add worker
              </Button>
            </ControlReason>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/* A single-worker poll disables every other poll control too, so it needs the banner
            just as much as a fleet-wide one. */}
        {pollBusy ? (
          <div
            role="status"
            className="mb-4 flex gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary"
          >
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
            <span>
              {pollAll.isPending
                ? "Atlas is polling every worker one after another, waiting for each machine to answer."
                : "Atlas is polling a worker and waiting for that machine to answer."}{" "}
              This can take a while, cannot be cancelled, and the other poll buttons stay disabled
              until it finishes.
            </span>
          </div>
        ) : null}

        {pollError ? (
          <div className="mb-4">
            <MutationAlert error={pollError} />
          </div>
        ) : null}

        {workers.isPending ? (
          <LoadingState label="Loading fleet" />
        ) : workers.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(workers.error)}
            onRetry={() => void workers.refetch()}
          />
        ) : (
          <DataTable
            rows={workers.data}
            rowKey={(w) => w.id}
            empty="Atlas has no workers registered."
            columns={[
              {
                key: "name",
                header: "Worker",
                render: (w) => (
                  <div>
                    <div className="text-sm font-medium">{w.name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{w.baseUrl}</div>
                  </div>
                ),
              },
              {
                key: "role",
                header: "Role",
                render: (w) => <span className="font-mono text-xs">{w.role || "—"}</span>,
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
                key: "agentVersion",
                header: "Agent",
                render: (w) => (
                  <span className="font-mono text-xs text-muted-foreground">
                    {/* Null until Atlas has polled the worker at least once. */}
                    {w.agentVersion ?? "not polled"}
                  </span>
                ),
              },
              {
                key: "lastError",
                header: "Last Error",
                render: (w) =>
                  w.lastError ? (
                    <span className="line-clamp-1 font-mono text-[11px] text-destructive">
                      {w.lastError}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">—</span>
                  ),
              },
              {
                key: "status",
                header: "Status",
                render: (w) => <StatusPill tone={w.status.tone}>{w.status.label}</StatusPill>,
              },
              {
                key: "lastSeenAt",
                header: "Last Seen",
                render: (w) => (
                  <span className="font-mono text-xs text-muted-foreground">{w.lastSeenAt}</span>
                ),
              },
              {
                key: "actions",
                header: "Actions",
                className: "text-right",
                render: (w) => (
                  <div className="flex justify-end gap-1">
                    <ControlReason
                      reason={
                        pollReason ??
                        "Atlas dials this worker now. It waits for the machine to answer."
                      }
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canPoll || pollBusy}
                        onClick={() => pollWorker.mutate({ workerId: w.id })}
                      >
                        {pollingWorkerId === w.id ? (
                          <Loader2 className="animate-spin" aria-hidden="true" />
                        ) : (
                          <RefreshCw aria-hidden="true" />
                        )}
                        <span className="sr-only">Poll {w.name}</span>
                      </Button>
                    </ControlReason>
                    <ControlReason
                      reason={
                        canManage
                          ? `Edit ${w.name}`
                          : `Editing a worker requires the Atlas admin role — yours is ${roleLabel}.`
                      }
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canManage}
                        onClick={() => setForm({ worker: w })}
                      >
                        <Pencil aria-hidden="true" />
                        <span className="sr-only">Edit {w.name}</span>
                      </Button>
                    </ControlReason>
                    <ControlReason
                      reason={
                        canManage
                          ? `Delete ${w.name}`
                          : `Deleting a worker requires the Atlas admin role — yours is ${roleLabel}.`
                      }
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canManage}
                        onClick={() => setPendingDelete(w)}
                      >
                        <Trash2 className="text-destructive" aria-hidden="true" />
                        <span className="sr-only">Delete {w.name}</span>
                      </Button>
                    </ControlReason>
                  </div>
                ),
              },
            ]}
          />
        )}
      </div>

      {form ? (
        <WorkerFormDialog
          key={form.worker?.id ?? "new-worker"}
          worker={form.worker}
          existing={workers.data ?? []}
          onClose={() => setForm(null)}
        />
      ) : null}

      {pendingDelete ? (
        <DeleteWorkerDialog
          key={pendingDelete.id}
          worker={pendingDelete}
          cascade={
            workspaces.isPending
              ? { state: "pending" }
              : workspaces.isError
                ? { state: "error" }
                : {
                    state: "ready",
                    items: workspaces.data.filter((w) => w.workerId === pendingDelete.id),
                  }
          }
          onClose={() => setPendingDelete(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Add and edit are one dialog because Atlas has one endpoint.
 *
 * `POST /api/workers` upserts on `id` **or** `base_url`, so "add a worker" at a URL Atlas
 * already knows quietly edits that worker instead of creating a second one. The form says so
 * while there is still time to change the URL, and relabels its submit button to match what
 * will actually happen.
 *
 * Editing has no such well-defined outcome. `SELECT ... WHERE id = ? OR base_url = ?`
 * (`atlas/db.py:1966`) can match two rows there, and `fetchone()` picks one of them: either the
 * update writes a `base_url` another row already holds and trips `base_url TEXT NOT NULL UNIQUE`
 * (`atlas/db.py:189`) as a raw SQLite 500, or it silently rewrites the *other* worker and leaves
 * the edited one untouched while the dialog reports success. So a taken URL is a hard block when
 * editing, not an offer to overwrite.
 */
function WorkerFormDialog({
  worker,
  existing,
  onClose,
}: {
  worker: WorkerView | null;
  existing: WorkerView[];
  onClose: () => void;
}) {
  const upsert = useUpsertWorker();

  const [name, setName] = useState(worker?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(worker?.baseUrl ?? "");
  const [workerRole, setWorkerRole] = useState(worker?.role ?? "");
  const [tags, setTags] = useState((worker?.tags ?? []).join(", "));
  const [token, setToken] = useState("");

  const canonical = canonicalBaseUrl(baseUrl);
  const urlInvalid = baseUrl.trim().length > 0 && canonical === null;
  // A match on a *different* row is the interesting one: for the worker being edited, matching
  // its own base_url is simply the edit succeeding.
  const otherWorkerAtUrl =
    canonical === null
      ? undefined
      : existing.find((w) => w.id !== worker?.id && storedBaseUrlKey(w.baseUrl) === canonical);
  // Creating, the upsert is a well-defined overwrite of that worker and can be offered as one.
  const collision = worker === null ? otherWorkerAtUrl : undefined;
  // Editing, it is not — see the note above this component.
  const urlTaken = worker === null ? undefined : otherWorkerAtUrl;

  const ready = name.trim().length > 0 && canonical !== null && urlTaken === undefined;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    upsert.mutate(
      {
        workerId: worker?.id,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        role: workerRole.trim(),
        tags: parseTags(tags),
        // Empty means "keep what Atlas already holds" (`atlas/db.py:1972-1974`), so an empty
        // field must be sent as absent rather than as an empty credential.
        token: token.trim() || undefined,
      },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{worker ? `Edit ${worker.name}` : "Register a worker"}</DialogTitle>
            <DialogDescription>
              Atlas matches a worker by id or base URL and writes whichever it finds. There is no
              separate create and update.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="worker-name">Name</Label>
              <Input
                id="worker-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="build-01"
                autoComplete="off"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="worker-base-url">Base URL</Label>
              <Input
                id="worker-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://worker.internal:8080"
                autoComplete="off"
                inputMode="url"
                required
              />
              {urlInvalid ? (
                <p className="text-[11px] text-destructive">
                  Atlas accepts only an http or https URL here.
                </p>
              ) : urlTaken ? (
                <p className="text-[11px] leading-relaxed text-destructive">
                  This base URL already belongs to {urlTaken.name}. Atlas allows one worker per base
                  URL, so this cannot be saved — use a different URL, or edit {urlTaken.name}{" "}
                  instead.
                </p>
              ) : (
                <FieldHint>Atlas removes a trailing slash before storing this.</FieldHint>
              )}
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
                  Atlas already has a worker at this base URL:{" "}
                  <span className="font-medium">{collision.name}</span>. Saving will overwrite that
                  worker&apos;s name, role, and tags — it will not create a second one.
                </span>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="worker-role">Role</Label>
              <Input
                id="worker-role"
                value={workerRole}
                onChange={(e) => setWorkerRole(e.target.value)}
                placeholder="builder"
                autoComplete="off"
              />
              <FieldHint>
                A free-text label Atlas&apos;s router matches against. Optional.
              </FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="worker-tags">Tags</Label>
              <Input
                id="worker-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="gpu, eu-west"
                autoComplete="off"
              />
              <FieldHint>Comma separated.</FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="worker-token">Worker token</Label>
              <Input
                id="worker-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Leave empty to keep the stored token"
                autoComplete="new-password"
              />
              <FieldHint>
                {worker
                  ? worker.tokenSet
                    ? "Atlas holds a token for this worker. It is never sent to the browser, so it cannot be shown here — leave this empty to keep it, or type a new one to replace it."
                    : "Atlas holds no token for this worker. Leaving this empty keeps it that way."
                  : "Atlas stores this encrypted and never returns it. Leave it empty if the worker needs no credential."}
              </FieldHint>
            </div>

            <MutationAlert error={upsert.error} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={upsert.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || upsert.isPending}>
              {upsert.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {collision
                ? `Overwrite ${collision.name}`
                : worker
                  ? "Save worker"
                  : "Register worker"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type CascadePreview =
  | { state: "pending" }
  | { state: "error" }
  | { state: "ready"; items: WorkspaceView[] };

/**
 * Confirms `DELETE /api/workers/{id}`, whose two outcomes look nothing alike.
 *
 * Atlas refuses outright when the worker has job history, but a worker with workspaces and no
 * jobs deletes silently and takes every one of its workspaces with it
 * (`workspaces.worker_id ... ON DELETE CASCADE`, `atlas/db.py:211`). The cascade is invisible
 * from the fleet table, so it is spelled out here — and the confirm stays disabled until the
 * workspace list is loaded, because a cascade that cannot be shown must not be agreed to.
 */
function DeleteWorkerDialog({
  worker,
  cascade,
  onClose,
}: {
  worker: WorkerView;
  cascade: CascadePreview;
  onClose: () => void;
}) {
  const remove = useDeleteWorker();

  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {worker.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Atlas refuses this while the worker has any job history, to keep the audit trail intact.
            If it has none, the worker is removed immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-xs leading-relaxed">
          {cascade.state === "pending" ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Checking which workspaces would be deleted with it…
            </p>
          ) : cascade.state === "error" ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
              Atlas&apos;s workspace list could not be loaded, so the workspaces this delete would
              cascade cannot be shown. Reload the page before deciding.
            </p>
          ) : cascade.items.length === 0 ? (
            <p className="text-muted-foreground">No workspaces are mapped to this worker.</p>
          ) : (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
              <p className="font-medium">
                {cascade.items.length} workspace{cascade.items.length === 1 ? "" : "s"} will be
                deleted with it:
              </p>
              <ul className="mt-1.5 space-y-0.5 font-mono text-[11px]">
                {cascade.items.map((w) => (
                  <li key={w.id}>
                    {w.workspaceKey} <span className="opacity-70">— {w.workspaceDir}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <MutationAlert error={remove.error} />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={cascade.state !== "ready" || remove.isPending}
            // Radix closes on click; the dialog has to stay open to report Atlas's refusal.
            onClick={(event) => {
              event.preventDefault();
              remove.mutate({ workerId: worker.id }, { onSuccess: onClose });
            }}
          >
            {remove.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Delete worker
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
