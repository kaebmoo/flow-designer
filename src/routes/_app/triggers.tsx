import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { Check, Copy, Pencil, Play, Plus, Trash2 } from "lucide-react";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { WindowNotice } from "@/components/atlas/window";
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
import { Switch } from "@/components/ui/switch";
import {
  describeAtlasError,
  MANUALLY_FIREABLE_TRIGGER_TYPES,
  TRIGGER_TYPES,
  toClientAtlasError,
  type TriggerView,
  type WorkflowView,
} from "@/lib/atlas-mappers";
import {
  useCreateTrigger,
  useDeleteTrigger,
  useFireTrigger,
  useSetTriggerEnabled,
  useUpdateTrigger,
  type AtlasMutationError,
} from "@/lib/atlas-mutations";
import { triggersQuery, workflowsQuery, workersQuery } from "@/lib/atlas-queries";
import { ATLAS_LIMIT_OPTIONS, parseLimitSearch, parseStringSearch } from "@/lib/atlas-search";

export const Route = createFileRoute("/_app/triggers")({
  validateSearch: (search: { limit?: number; workflow?: string } & SearchSchemaInput) => ({
    limit: parseLimitSearch(search.limit),
    /** Pushed down to Atlas as `workflow_definition_id`, not filtered in the browser. */
    workflow: parseStringSearch(search.workflow),
  }),
  component: TriggersPage,
  head: () => ({ meta: [{ title: "Triggers · Atlas Control" }] }),
});

/**
 * How many workflow definitions to load for the pickers.
 *
 * Independent of the trigger window: a trigger list of 25 still has to name every workflow it
 * could point at. 500 is the largest window the UI offers anywhere, and Atlas clamps it anyway.
 */
const WORKFLOW_PICKER_LIMIT = 500;

/** Terminal run states Atlas emits `workflow_run_completed` for (`atlas/workflows.py:1201`). */
const COMPLETED_RUN_STATES = ["succeeded", "failed", "cancelled"] as const;

/** Artifact kinds Atlas stores (`docs/specs/workflow-trigger.schema.json`). */
const ARTIFACT_KINDS = ["text", "json", "markdown", "file_ref", "summary", "decision"] as const;

/**
 * The only statuses a `worker_status_changed` event can carry (`atlas/jobs.py:480,512,516-523`).
 * The `unknown` column default (`atlas/db.py:193`) is never emitted as a new status, so a trigger
 * filtered on it would be accepted by Atlas and then never fire.
 */
const WORKER_STATUSES = ["online", "offline"] as const;

/** Matches the height and focus ring of `Input`, which has no `select` counterpart. */
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const ICON_BUTTON_CLASS =
  "inline-flex size-7 items-center justify-center rounded border border-border text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground";

interface Notice {
  tone: "success" | "error";
  title: string;
  description: string;
}

/**
 * Turns a mutation failure into the same copy every other Atlas failure uses.
 *
 * The point of routing through `describeAtlasError` rather than printing `error.message` is the
 * 403: Atlas's own text for a denied write is terse, and shown raw it reads like a generic
 * failure. This makes a permission problem say so, and keeps a 5xx from leaking Atlas internals.
 */
function noticeFromMutationError(error: AtlasMutationError): Notice {
  const { title, description } = describeAtlasError({ kind: error.kind, message: error.message });
  return { tone: "error", title, description };
}

function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const isError = notice.tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`mb-4 flex items-start gap-3 rounded-lg border px-4 py-3 ${
        isError
          ? "border-destructive/40 bg-destructive/10"
          : "border-[var(--color-success)]/40 bg-[var(--color-success)]/10"
      }`}
    >
      <div className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">
        <span className="font-semibold">{notice.title}.</span> {notice.description}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * The endpoint an external producer POSTs to fire a webhook trigger.
 *
 * Atlas has no user-chosen webhook path — every trigger is fired at its own id-scoped route
 * (`atlas/app.py`, `POST /api/workflow-triggers/{id}/fire`), so there is nothing to invent here.
 *
 * The path is shown without an origin on purpose. `ATLAS_API_ORIGIN` is declared server-only in
 * `src/lib/env.server.ts` and never reaches the browser; printing an absolute URL would mean
 * shipping the private Atlas origin to every page that renders this table.
 */
function firePath(triggerId: string): string {
  return `/api/workflow-triggers/${triggerId}/fire`;
}

function TriggersPage() {
  const { limit, workflow } = Route.useSearch();
  const navigate = Route.useNavigate();

  const triggers = useQuery(triggersQuery({ limit, workflowDefinitionId: workflow }));
  const workflows = useQuery(workflowsQuery({ limit: WORKFLOW_PICKER_LIMIT }));

  const [notice, setNotice] = useState<Notice | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ trigger: TriggerView | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TriggerView | null>(null);

  const setEnabled = useSetTriggerEnabled();
  const fire = useFireTrigger();
  const remove = useDeleteTrigger();

  const workflowOptions: WorkflowView[] = workflows.data?.items ?? [];
  const workflowNames = new Map(workflowOptions.map((w) => [w.id, w.name]));

  async function copyFirePath(trigger: TriggerView) {
    const path = firePath(trigger.id);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(path);
      setCopiedId(trigger.id);
    } catch {
      setCopiedId(null);
      setNotice({
        tone: "error",
        title: "Could not copy",
        description:
          "This browser refused clipboard access. Select the endpoint text and copy it by hand.",
      });
    }
  }

  const rows = triggers.data ?? [];

  return (
    <>
      <PageHeader
        title="Triggers"
        subtitle="What starts a workflow run: a schedule, a webhook, an Atlas event, or a hand."
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Workflow
              </span>
              <select
                value={workflow ?? ""}
                onChange={(event) =>
                  void navigate({
                    search: (prev) => ({ ...prev, workflow: event.target.value || undefined }),
                  })
                }
                className={`${SELECT_CLASS} h-7 w-56 text-xs`}
              >
                <option value="" className="bg-card text-foreground">
                  All workflows
                </option>
                {/* A filter that came in by link may name a workflow outside the loaded page. */}
                {workflow && !workflowNames.has(workflow) ? (
                  <option value={workflow} className="bg-card text-foreground">
                    {workflow}
                  </option>
                ) : null}
                {workflowOptions.map((w) => (
                  <option key={w.id} value={w.id} className="bg-card text-foreground">
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Window
            </span>
            {ATLAS_LIMIT_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => void navigate({ search: (prev) => ({ ...prev, limit: option }) })}
                className={`rounded-full border px-3 py-0.5 font-mono text-[10px] uppercase tracking-widest transition ${
                  limit === option
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        }
        actions={
          <button
            type="button"
            onClick={() => setEditing({ trigger: null })}
            className="inline-flex items-center gap-2 rounded bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="size-4" /> New trigger
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}

        {triggers.isPending ? (
          <LoadingState label="Loading triggers" />
        ) : triggers.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(triggers.error)}
            onRetry={() => void triggers.refetch()}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable
                rows={rows}
                rowKey={(t) => t.id}
                empty={
                  workflow
                    ? "Atlas has no triggers for this workflow."
                    : "Atlas has no workflow triggers yet."
                }
                columns={[
                  {
                    key: "name",
                    header: "Trigger",
                    render: (t) => (
                      <div className="min-w-0">
                        <div className="truncate font-medium">{t.name}</div>
                        <div className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                          {t.typeLabel} · {t.id}
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: "workflow",
                    header: "Starts",
                    render: (t) => (
                      <Link
                        to="/workflows/$id"
                        params={{ id: t.workflowDefinitionId }}
                        className="text-xs text-primary hover:underline"
                      >
                        {workflowNames.get(t.workflowDefinitionId) ?? t.workflowDefinitionId}
                      </Link>
                    ),
                  },
                  {
                    key: "summary",
                    header: "Configuration",
                    render: (t) => (
                      <div className="min-w-0 space-y-1">
                        <div className="text-xs text-muted-foreground">{t.summary}</div>
                        {t.type === "webhook" ? (
                          <div className="flex items-center gap-2">
                            <code className="truncate font-mono text-[10px] text-foreground">
                              POST {firePath(t.id)}
                            </code>
                            <button
                              type="button"
                              onClick={() => void copyFirePath(t)}
                              title="Copy the fire endpoint path"
                              className={ICON_BUTTON_CLASS}
                            >
                              {copiedId === t.id ? (
                                <Check className="size-3" />
                              ) : (
                                <Copy className="size-3" />
                              )}
                              <span className="sr-only">Copy fire endpoint</span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ),
                  },
                  {
                    key: "timing",
                    header: "Fired",
                    render: (t) => (
                      <div className="font-mono text-[10px] leading-relaxed text-muted-foreground">
                        <div>last {t.lastFiredAt}</div>
                        <div>next {t.nextFireAt}</div>
                      </div>
                    ),
                  },
                  {
                    key: "lastEvent",
                    header: "Last event",
                    // Only the list route carries this; the by-id and write routes omit it.
                    render: (t) => (
                      <div className="min-w-0 space-y-1">
                        {t.lastEventState ? (
                          <StatusPill tone={t.lastEventState.tone}>
                            {t.lastEventState.label}
                          </StatusPill>
                        ) : (
                          <span className="font-mono text-[10px] text-muted-foreground">—</span>
                        )}
                        {t.lastEventError ? (
                          <div
                            title={t.lastEventError}
                            className="max-w-[16rem] truncate text-[10px] text-destructive"
                          >
                            {t.lastEventError}
                          </div>
                        ) : null}
                      </div>
                    ),
                  },
                  {
                    key: "enabled",
                    header: "Enabled",
                    render: (t) => (
                      <div className="flex items-center gap-2">
                        {/*
                          Not optimistic: the switch keeps showing Atlas's value until the refetch
                          lands, so it can never claim a state Atlas rejected. It is disabled only
                          for the row in flight, which is the feedback that the click registered.
                        */}
                        <Switch
                          checked={t.enabled}
                          disabled={
                            setEnabled.isPending && setEnabled.variables?.triggerId === t.id
                          }
                          aria-label={`${t.enabled ? "Disable" : "Enable"} ${t.name}`}
                          onCheckedChange={(next) => {
                            setNotice(null);
                            setEnabled.mutate(
                              { triggerId: t.id, enabled: next },
                              {
                                onSuccess: () =>
                                  setNotice({
                                    tone: "success",
                                    title: next ? "Trigger enabled" : "Trigger disabled",
                                    description: `Atlas now reports "${t.name}" as ${
                                      next ? "enabled" : "disabled"
                                    }.`,
                                  }),
                                onError: (error) => setNotice(noticeFromMutationError(error)),
                              },
                            );
                          }}
                        />
                      </div>
                    ),
                  },
                  {
                    key: "actions",
                    header: "",
                    className: "text-right",
                    render: (t) => {
                      const fireable = MANUALLY_FIREABLE_TRIGGER_TYPES.includes(t.type);
                      return (
                        <div className="flex items-center justify-end gap-1.5">
                          {/*
                            Every fire button goes down while one is in flight, not just this
                            row's. Atlas has no idempotency key on `/fire`, so a second click
                            anywhere in the table is a second run.
                          */}
                          <button
                            type="button"
                            disabled={!fireable || fire.isPending}
                            title={
                              fireable
                                ? `Fire "${t.name}" now`
                                : `Atlas fires ${t.typeLabel.toLowerCase()} triggers from its own events; they cannot be fired by hand.`
                            }
                            onClick={() => {
                              setNotice(null);
                              fire.mutate(
                                { triggerId: t.id },
                                {
                                  onSuccess: () =>
                                    setNotice({
                                      tone: "success",
                                      title: "Fire accepted",
                                      description: `Atlas accepted the fire request for "${t.name}". Its last-event column shows whether the run actually started.`,
                                    }),
                                  onError: (error) => setNotice(noticeFromMutationError(error)),
                                },
                              );
                            }}
                            className={ICON_BUTTON_CLASS}
                          >
                            <Play className="size-3" />
                            <span className="sr-only">Fire</span>
                          </button>
                          <button
                            type="button"
                            title={`Edit "${t.name}"`}
                            onClick={() => {
                              setNotice(null);
                              setEditing({ trigger: t });
                            }}
                            className={ICON_BUTTON_CLASS}
                          >
                            <Pencil className="size-3" />
                            <span className="sr-only">Edit</span>
                          </button>
                          <button
                            type="button"
                            title={`Delete "${t.name}"`}
                            onClick={() => {
                              setNotice(null);
                              setPendingDelete(t);
                            }}
                            className={`${ICON_BUTTON_CLASS} hover:border-destructive/50 hover:text-destructive`}
                          >
                            <Trash2 className="size-3" />
                            <span className="sr-only">Delete</span>
                          </button>
                        </div>
                      );
                    },
                  },
                ]}
              />
            </div>

            <WindowNotice
              count={rows.length}
              limit={limit}
              // `listTriggersFn` returns a bare array, so the full-window inference is made here.
              mayHaveMore={rows.length >= limit}
              noun="triggers"
            />
          </>
        )}
      </div>

      {editing ? (
        <TriggerFormDialog
          key={editing.trigger?.id ?? "new"}
          trigger={editing.trigger}
          workflows={workflowOptions}
          workflowsUnavailable={workflows.isError}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setNotice(saved);
          }}
        />
      ) : null}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          // No dismissal while the request is in flight: Escape here would clear the target
          // mid-mutation and hide Atlas's refusal as if nothing had been asked.
          if (open || remove.isPending) return;
          setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this trigger?</AlertDialogTitle>
            <AlertDialogDescription>
              Atlas deletes &ldquo;{pendingDelete?.name}&rdquo; and the whole history of times it
              fired. Runs it already started are kept. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={(event) => {
                // Deleting is async; letting the dialog close on click would hide the failure.
                event.preventDefault();
                const target = pendingDelete;
                if (!target) return;
                remove.mutate(
                  { triggerId: target.id },
                  {
                    onSuccess: () => {
                      setPendingDelete(null);
                      setNotice({
                        tone: "success",
                        title: "Trigger deleted",
                        description: `Atlas no longer has "${target.name}".`,
                      });
                    },
                    onError: (error) => {
                      setPendingDelete(null);
                      setNotice(noticeFromMutationError(error));
                    },
                  },
                );
              }}
            >
              {remove.isPending ? "Deleting…" : "Delete trigger"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// The create/edit form.
// ---------------------------------------------------------------------------

type ScheduleMode = "interval" | "daily";

interface TriggerDraft {
  name: string;
  type: string;
  enabled: boolean;
  workflowDefinitionId: string;
  /** A schedule is one of two shapes, so the form holds a choice rather than two optionals. */
  scheduleMode: ScheduleMode;
  intervalMinutes: string;
  dailyTime: string;
  sourceWorkflowDefinitionId: string;
  runState: string;
  artifactKey: string;
  artifactKind: string;
  workerId: string;
  workerStatus: string;
}

/** Atlas's floor: below 1/60 of a minute `next_fire_at` never advances past its 1s resolution. */
const MIN_INTERVAL_MINUTES = 1 / 60;
const DAILY_TIME_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function initialDraft(trigger: TriggerView | null): TriggerDraft {
  const config: Record<string, unknown> = trigger?.config ?? {};
  const hasDaily = typeof config.daily_time === "string";
  return {
    name: trigger?.name ?? "",
    type: trigger?.type ?? "manual",
    enabled: trigger?.enabled ?? true,
    workflowDefinitionId: trigger?.workflowDefinitionId ?? "",
    scheduleMode: hasDaily ? "daily" : "interval",
    intervalMinutes:
      typeof config.interval_minutes === "number" ? String(config.interval_minutes) : "60",
    dailyTime: hasDaily ? String(config.daily_time) : "09:00",
    sourceWorkflowDefinitionId: configString(config, "source_workflow_definition_id"),
    runState: configString(config, "state"),
    artifactKey: configString(config, "key"),
    artifactKind: configString(config, "kind"),
    workerId: configString(config, "worker_id"),
    workerStatus: configString(config, "status"),
  };
}

function omitEmpty(entries: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== ""));
}

/**
 * Builds exactly the keys Atlas allows for the chosen type, and nothing else.
 *
 * The four event/schedule types have closed configs — Atlas rejects an unknown key outright
 * (`atlas/workflows.py:1837-1844`) rather than ignoring it, so an omitted filter has to be
 * *absent*, not empty-string.
 */
function buildTriggerConfig(
  draft: TriggerDraft,
  original: TriggerView | null,
): Record<string, unknown> {
  switch (draft.type) {
    case "schedule":
      return draft.scheduleMode === "daily"
        ? { daily_time: draft.dailyTime }
        : { interval_minutes: Number(draft.intervalMinutes) };
    case "workflow_run_completed":
      return omitEmpty({
        source_workflow_definition_id: draft.sourceWorkflowDefinitionId,
        state: draft.runState,
      });
    case "artifact_created":
      return omitEmpty({
        source_workflow_definition_id: draft.sourceWorkflowDefinitionId,
        key: draft.artifactKey.trim(),
        kind: draft.artifactKind,
      });
    case "worker_status_changed":
      return omitEmpty({ worker_id: draft.workerId, status: draft.workerStatus });
    default:
      /**
       * `manual` and `webhook` take an open config that this form offers no fields for.
       *
       * Atlas replaces `config` wholesale on update rather than merging (`atlas/db.py:1511`), so
       * an object some other client wrote is echoed back untouched. Only a *type change* into
       * one of these clears it, because the old keys belonged to the old type.
       */
      return original !== null && original.type === draft.type ? { ...original.config } : {};
  }
}

function localProblems(draft: TriggerDraft, isCreate: boolean): string[] {
  const problems: string[] = [];
  if (draft.name.trim().length === 0) problems.push("A trigger needs a name.");
  if (isCreate && draft.workflowDefinitionId === "") {
    problems.push("Pick the workflow this trigger starts.");
  }
  if (!(TRIGGER_TYPES as readonly string[]).includes(draft.type)) {
    problems.push(`Atlas does not accept the type "${draft.type}". Pick one of the six below.`);
  }
  if (draft.type === "schedule") {
    if (draft.scheduleMode === "interval") {
      const minutes = Number(draft.intervalMinutes);
      if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES) {
        problems.push("The interval must be at least 1/60 of a minute (one second).");
      }
    } else if (!DAILY_TIME_PATTERN.test(draft.dailyTime)) {
      problems.push("The daily time must be HH:MM, between 00:00 and 23:59.");
    }
  }
  return problems;
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label
        htmlFor={htmlFor}
        className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
      >
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * A select over Atlas ids that never silently drops the value it was given.
 *
 * The workflow and worker lists are bounded windows, so a config can legitimately name an id
 * that is not in the loaded page. Merging the current value in keeps saving the form from
 * quietly rewriting a filter the user never touched.
 */
function IdSelect({
  id,
  value,
  onChange,
  anyLabel,
  options,
  unavailableNote,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  anyLabel: string;
  options: Array<{ id: string; label: string }>;
  unavailableNote?: string;
}) {
  const known = options.some((option) => option.id === value);
  return (
    <>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={SELECT_CLASS}
      >
        <option value="" className="bg-card text-foreground">
          {anyLabel}
        </option>
        {value !== "" && !known ? (
          <option value={value} className="bg-card text-foreground">
            {value}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.id} value={option.id} className="bg-card text-foreground">
            {option.label}
          </option>
        ))}
      </select>
      {unavailableNote ? (
        <p className="text-xs leading-relaxed text-accent">{unavailableNote}</p>
      ) : null}
    </>
  );
}

function TriggerFormDialog({
  trigger,
  workflows,
  workflowsUnavailable,
  onClose,
  onSaved,
}: {
  trigger: TriggerView | null;
  workflows: WorkflowView[];
  workflowsUnavailable: boolean;
  onClose: () => void;
  onSaved: (notice: Notice) => void;
}) {
  const isCreate = trigger === null;
  const [draft, setDraft] = useState<TriggerDraft>(() => initialDraft(trigger));
  const [showProblems, setShowProblems] = useState(false);

  const create = useCreateTrigger();
  const update = useUpdateTrigger();
  const pending = create.isPending || update.isPending;
  const failure = create.error ?? update.error;

  // Only fetched when the form actually offers a worker picker; Atlas polls nothing here, but
  // the request is still pointless for the other five types.
  const workers = useQuery({
    ...workersQuery(),
    enabled: draft.type === "worker_status_changed",
  });

  const workflowChoices = workflows.map((w) => ({ id: w.id, label: w.name }));
  const workerChoices = (workers.data ?? []).map((w) => ({ id: w.id, label: w.name }));

  const problems = localProblems(draft, isCreate);

  function patch(next: Partial<TriggerDraft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (problems.length > 0) {
      setShowProblems(true);
      return;
    }
    const config = buildTriggerConfig(draft, trigger);
    const name = draft.name.trim();

    if (trigger === null) {
      create.mutate(
        {
          workflowDefinitionId: draft.workflowDefinitionId,
          name,
          type: draft.type,
          enabled: draft.enabled,
          config,
        },
        {
          onSuccess: () =>
            onSaved({
              tone: "success",
              title: "Trigger created",
              description: `Atlas stored "${name}".`,
            }),
        },
      );
      return;
    }

    update.mutate(
      { triggerId: trigger.id, name, type: draft.type, enabled: draft.enabled, config },
      {
        onSuccess: () =>
          onSaved({
            tone: "success",
            title: "Trigger saved",
            description: `Atlas updated "${name}".`,
          }),
      },
    );
  }

  const typeOptions = (TRIGGER_TYPES as readonly string[]).includes(draft.type)
    ? (TRIGGER_TYPES as readonly string[])
    : [draft.type, ...TRIGGER_TYPES];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isCreate ? "New trigger" : "Edit trigger"}</DialogTitle>
          <DialogDescription>
            {isCreate
              ? "Atlas stores the trigger and starts evaluating it as soon as it is enabled."
              : "Changing the type or configuration makes Atlas recompute the next fire time."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <Field label="Name" htmlFor="trigger-name">
            <Input
              id="trigger-name"
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="Nightly digest"
              autoComplete="off"
            />
          </Field>

          {isCreate ? (
            <Field
              label="Workflow to start"
              htmlFor="trigger-workflow"
              hint={
                workflowsUnavailable
                  ? undefined
                  : "This cannot be changed later — Atlas ignores workflow_definition_id on update, so moving a trigger means deleting it and creating another."
              }
            >
              <IdSelect
                id="trigger-workflow"
                value={draft.workflowDefinitionId}
                onChange={(next) => patch({ workflowDefinitionId: next })}
                anyLabel="Choose a workflow…"
                options={workflowChoices}
                unavailableNote={
                  workflowsUnavailable
                    ? "Atlas did not return the workflow list, so there is nothing to pick from. Reload the page and try again."
                    : undefined
                }
              />
            </Field>
          ) : (
            <Field label="Workflow to start">
              <div className="rounded-md border border-border bg-secondary/20 px-3 py-2">
                <div className="font-mono text-xs text-foreground">
                  {workflows.find((w) => w.id === trigger.workflowDefinitionId)?.name ??
                    trigger.workflowDefinitionId}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Fixed for the life of the trigger. Atlas silently ignores
                  <code className="mx-1 font-mono">workflow_definition_id</code>
                  on an update, so offering it here would look like it worked. Delete this trigger
                  and create one on the other workflow instead.
                </p>
              </div>
            </Field>
          )}

          <Field label="Type" htmlFor="trigger-type">
            <select
              id="trigger-type"
              value={draft.type}
              onChange={(event) => patch({ type: event.target.value })}
              className={`${SELECT_CLASS} font-mono`}
            >
              {typeOptions.map((type) => (
                <option key={type} value={type} className="bg-card text-foreground">
                  {type}
                </option>
              ))}
            </select>
          </Field>

          <TriggerConfigFields
            draft={draft}
            patch={patch}
            workflowChoices={workflowChoices}
            workflowsUnavailable={workflowsUnavailable}
            workerChoices={workerChoices}
            workersUnavailable={workers.isError}
            triggerId={trigger?.id ?? null}
          />

          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <Label htmlFor="trigger-enabled" className="text-sm">
                Enabled
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                A disabled trigger is stored but never evaluated or fired.
              </p>
            </div>
            <Switch
              id="trigger-enabled"
              checked={draft.enabled}
              onCheckedChange={(next) => patch({ enabled: next })}
            />
          </div>

          {showProblems && problems.length > 0 ? (
            <ul className="space-y-1 rounded-md border border-accent/40 bg-accent/10 px-4 py-3 text-xs leading-relaxed text-foreground">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}

          {failure ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs leading-relaxed text-foreground">
              {(() => {
                const notice = noticeFromMutationError(failure);
                return (
                  <>
                    <span className="font-semibold">{notice.title}.</span> {notice.description}
                  </>
                );
              })()}
            </div>
          ) : null}

          <DialogFooter>
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="rounded-md border border-border px-4 py-2 text-sm text-foreground transition hover:bg-secondary disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {pending ? "Saving…" : isCreate ? "Create trigger" : "Save trigger"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TriggerConfigFields({
  draft,
  patch,
  workflowChoices,
  workflowsUnavailable,
  workerChoices,
  workersUnavailable,
  triggerId,
}: {
  draft: TriggerDraft;
  patch: (next: Partial<TriggerDraft>) => void;
  workflowChoices: Array<{ id: string; label: string }>;
  workflowsUnavailable: boolean;
  workerChoices: Array<{ id: string; label: string }>;
  workersUnavailable: boolean;
  triggerId: string | null;
}) {
  const workflowNote = workflowsUnavailable
    ? "Atlas did not return the workflow list, so only the current value is offered."
    : undefined;

  switch (draft.type) {
    case "schedule":
      return (
        <fieldset className="space-y-3 rounded-md border border-border px-3 py-3">
          <legend className="px-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Schedule
          </legend>
          <p className="text-xs leading-relaxed text-muted-foreground">
            A schedule is one shape or the other. Atlas stores an interval or a daily time, never
            both and never neither.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <input
                type="radio"
                name="schedule-mode"
                className="accent-primary"
                checked={draft.scheduleMode === "interval"}
                onChange={() => patch({ scheduleMode: "interval" })}
              />
              Every N minutes
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <input
                type="radio"
                name="schedule-mode"
                className="accent-primary"
                checked={draft.scheduleMode === "daily"}
                onChange={() => patch({ scheduleMode: "daily" })}
              />
              Once a day at
            </label>
          </div>
          {draft.scheduleMode === "interval" ? (
            <Field
              label="Interval (minutes)"
              htmlFor="trigger-interval"
              hint="At least 1/60 — below one second Atlas cannot advance the next fire time."
            >
              <Input
                id="trigger-interval"
                type="number"
                min={MIN_INTERVAL_MINUTES}
                step="any"
                value={draft.intervalMinutes}
                onChange={(event) => patch({ intervalMinutes: event.target.value })}
              />
            </Field>
          ) : (
            <Field
              label="Daily time (Atlas host time)"
              htmlFor="trigger-daily"
              // Atlas resolves daily_time against its own host clock — `local_now =
              // base.astimezone()` in atlas/workflows.py:1885 — so this is neither UTC nor the
              // browser's timezone, and the label must not imply either.
              hint="HH:MM, 00:00 to 23:59, in the Atlas host's timezone — not your browser's."
            >
              <Input
                id="trigger-daily"
                type="time"
                value={draft.dailyTime}
                onChange={(event) => patch({ dailyTime: event.target.value })}
              />
            </Field>
          )}
        </fieldset>
      );

    case "workflow_run_completed":
      return (
        <fieldset className="space-y-3 rounded-md border border-border px-3 py-3">
          <legend className="px-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Match
          </legend>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Leave a filter on &ldquo;any&rdquo; to omit it. Atlas allows only these two keys and
            rejects anything else.
          </p>
          <Field label="Source workflow" htmlFor="config-source-workflow">
            <IdSelect
              id="config-source-workflow"
              value={draft.sourceWorkflowDefinitionId}
              onChange={(next) => patch({ sourceWorkflowDefinitionId: next })}
              anyLabel="Any workflow"
              options={workflowChoices}
              unavailableNote={workflowNote}
            />
          </Field>
          <Field label="Run state" htmlFor="config-run-state">
            <select
              id="config-run-state"
              value={draft.runState}
              onChange={(event) => patch({ runState: event.target.value })}
              className={SELECT_CLASS}
            >
              <option value="" className="bg-card text-foreground">
                Any state
              </option>
              {COMPLETED_RUN_STATES.map((state) => (
                <option key={state} value={state} className="bg-card text-foreground">
                  {state}
                </option>
              ))}
            </select>
          </Field>
        </fieldset>
      );

    case "artifact_created":
      return (
        <fieldset className="space-y-3 rounded-md border border-border px-3 py-3">
          <legend className="px-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Match
          </legend>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Leave a filter empty to omit it. Atlas allows only these three keys and rejects anything
            else.
          </p>
          <Field label="Source workflow" htmlFor="config-artifact-workflow">
            <IdSelect
              id="config-artifact-workflow"
              value={draft.sourceWorkflowDefinitionId}
              onChange={(next) => patch({ sourceWorkflowDefinitionId: next })}
              anyLabel="Any workflow"
              options={workflowChoices}
              unavailableNote={workflowNote}
            />
          </Field>
          <Field label="Artifact key" htmlFor="config-artifact-key" hint="Matched exactly.">
            <Input
              id="config-artifact-key"
              value={draft.artifactKey}
              onChange={(event) => patch({ artifactKey: event.target.value })}
              placeholder="Any key"
              autoComplete="off"
            />
          </Field>
          <Field label="Artifact kind" htmlFor="config-artifact-kind">
            <select
              id="config-artifact-kind"
              value={draft.artifactKind}
              onChange={(event) => patch({ artifactKind: event.target.value })}
              className={SELECT_CLASS}
            >
              <option value="" className="bg-card text-foreground">
                Any kind
              </option>
              {ARTIFACT_KINDS.map((kind) => (
                <option key={kind} value={kind} className="bg-card text-foreground">
                  {kind}
                </option>
              ))}
            </select>
          </Field>
        </fieldset>
      );

    case "worker_status_changed":
      return (
        <fieldset className="space-y-3 rounded-md border border-border px-3 py-3">
          <legend className="px-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Match
          </legend>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Atlas emits this when a poll changes a worker&rsquo;s status. Only these two keys are
            allowed.
          </p>
          <Field label="Worker" htmlFor="config-worker">
            <IdSelect
              id="config-worker"
              value={draft.workerId}
              onChange={(next) => patch({ workerId: next })}
              anyLabel="Any worker"
              options={workerChoices}
              unavailableNote={
                workersUnavailable
                  ? "Atlas did not return the worker list, so only the current value is offered."
                  : undefined
              }
            />
          </Field>
          <Field label="New status" htmlFor="config-worker-status">
            <select
              id="config-worker-status"
              value={draft.workerStatus}
              onChange={(event) => patch({ workerStatus: event.target.value })}
              className={SELECT_CLASS}
            >
              <option value="" className="bg-card text-foreground">
                Any status
              </option>
              {WORKER_STATUSES.map((status) => (
                <option key={status} value={status} className="bg-card text-foreground">
                  {status}
                </option>
              ))}
              {/* An older trigger may hold a status we no longer offer (`unknown`). Keep it
                  selectable so opening the form does not silently rewrite the saved filter. */}
              {draft.workerStatus &&
              !(WORKER_STATUSES as readonly string[]).includes(draft.workerStatus) ? (
                <option value={draft.workerStatus} className="bg-card text-foreground">
                  {draft.workerStatus} (never fires)
                </option>
              ) : null}
            </select>
          </Field>
        </fieldset>
      );

    case "webhook":
      return (
        <div className="space-y-2 rounded-md border border-border px-3 py-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            A webhook trigger has no configuration in Atlas — no path, no secret, no auth mode.
            Anything that can authenticate against the Atlas API fires it by POSTing here:
          </p>
          <code className="block break-all rounded border border-border bg-secondary/20 px-3 py-2 font-mono text-xs text-foreground">
            POST {triggerId === null ? "/api/workflow-triggers/{id}/fire" : firePath(triggerId)}
          </code>
          {triggerId === null ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              The id is minted by Atlas on create; the real endpoint appears in the table
              afterwards, with a copy button.
            </p>
          ) : null}
        </div>
      );

    default:
      return (
        <p className="rounded-md border border-border px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          A manual trigger has no configuration. It fires only when someone presses Fire on this
          page or calls the Atlas fire endpoint directly.
        </p>
      );
  }
}
