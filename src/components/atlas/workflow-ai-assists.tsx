import { AlertTriangle, Check, Loader2, Sparkles, Users, Wrench, Zap } from "lucide-react";
import { useState } from "react";

import { StatusPill } from "@/components/atlas/page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useCreateTrigger,
  useExplainWorkflow,
  useRepairWorkflow,
  useSuggestWorkflowTriggers,
  useSuggestWorkflowWorkers,
} from "@/lib/atlas-mutations";
import type {
  AtlasTriggerDraft,
  AtlasWorkflowDraft,
  AtlasWorkerSuggestion,
} from "@/lib/atlas-types";
import {
  parseWorkflowGraph,
  parseWorkflowPolicy,
  serializeWorkflowGraph,
  serializeWorkflowPolicy,
  type WorkflowGraph,
  type WorkflowPolicy,
} from "@/lib/workflow-graph";
import { applyWorkerSuggestion, unresolvedAgentNodes } from "@/lib/workflow-ai-assists";
import { describeWorkflowDraftError, summarizeWorkflowDraft } from "@/lib/workflow-ai-draft";

type Assist = "explain" | "repair" | "workers" | "triggers";

export interface WorkflowAiAssistsProps {
  workflowId: string;
  workflowName: string;
  graph: WorkflowGraph;
  policy: WorkflowPolicy;
  repairMessage?: string | null;
  onApplyRepair: (draft: AtlasWorkflowDraft, graph: WorkflowGraph, policy: WorkflowPolicy) => void;
  onApplyWorker: (graph: WorkflowGraph) => void;
}

function AssistError({ error }: { error: unknown }) {
  const details = describeWorkflowDraftError(error);
  const forbidden = details.forbidden;
  return (
    <div
      role="alert"
      className={`space-y-2 rounded-md border px-3 py-2 text-xs leading-relaxed ${forbidden ? "border-accent/40 bg-accent/10" : "border-destructive/40 bg-destructive/10"}`}
    >
      <p className="flex gap-2">
        <AlertTriangle
          className={`mt-0.5 size-3.5 shrink-0 ${forbidden ? "text-accent" : "text-destructive"}`}
          aria-hidden="true"
        />
        <span>
          {forbidden ? "Atlas permission: " : null}
          {details.message}
        </span>
      </p>
      {details.needsBuilderSetup ? (
        <p className="pl-5 text-muted-foreground">
          Configure a worker tagged <code>workflow_builder</code>, then try again.
        </p>
      ) : null}
    </div>
  );
}

function Busy({ children }: { children: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {children}
    </p>
  );
}

function stateTone(state: AtlasWorkerSuggestion["state"]): "success" | "warning" | "danger" {
  return state === "matched" ? "success" : state === "fallback" ? "warning" : "danger";
}

function RepairPreview({
  draft,
  onApply,
  disabled,
}: {
  draft: AtlasWorkflowDraft;
  onApply: () => void;
  disabled: boolean;
}) {
  const summary = summarizeWorkflowDraft(draft);
  return (
    <div className="space-y-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Proposed repair
        </p>
        <h3 className="mt-1 text-base font-semibold">{draft.name}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {draft.description || "No description."}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-border bg-secondary/20 p-3 text-xs">
        <dt className="text-muted-foreground">Nodes</dt>
        <dd>
          {summary.nodeCount} ({summary.nodeTypes.join(", ") || "none"})
        </dd>
        <dt className="text-muted-foreground">Edges</dt>
        <dd>{summary.edgeCount}</dd>
        <dt className="text-muted-foreground">Policy fields</dt>
        <dd>{summary.policyKeys.join(", ") || "none"}</dd>
      </dl>
      <p className="whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-xs leading-relaxed text-muted-foreground">
        {draft.explanation}
      </p>
      {draft.warnings.length ? (
        <ul className="list-disc space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3 pl-7 text-xs">
          {draft.warnings.map((warning, index) => (
            <li key={`${warning}-${index}`}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Accepting replaces the unsaved canvas draft only. It never saves automatically.
      </p>
      <Button type="button" disabled={disabled} onClick={onApply}>
        <Check className="mr-1.5 size-3.5" aria-hidden="true" />
        Use repair in canvas
      </Button>
    </div>
  );
}

function TriggerSuggestion({
  trigger,
  index,
  pending,
  created,
  onCreate,
}: {
  trigger: AtlasTriggerDraft;
  index: number;
  pending: boolean;
  created: boolean;
  onCreate: () => void;
}) {
  const ready =
    typeof trigger.name === "string" &&
    trigger.name.trim().length > 0 &&
    typeof trigger.type === "string";
  return (
    <li className="rounded-md border border-border bg-secondary/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{trigger.name || "Unnamed trigger"}</p>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {trigger.type || "type missing"} · {trigger.enabled === false ? "disabled" : "enabled"}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!ready || pending || created}
          onClick={onCreate}
        >
          {pending ? (
            <Loader2
              className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          {created ? "Created" : pending ? "Creating…" : ready ? "Create trigger" : "Incomplete"}
        </Button>
      </div>
      <pre className="mt-2 max-h-28 overflow-auto rounded border border-border bg-background/60 p-2 text-[11px]">
        {JSON.stringify(trigger.config, null, 2)}
      </pre>
      {!ready ? (
        <p className="mt-2 text-[11px] text-warning">
          Atlas needs a trigger name and type before this can be created.
        </p>
      ) : null}
      <span className="sr-only">Suggested trigger {index + 1}</span>
    </li>
  );
}

export function WorkflowAiAssists({
  workflowId,
  workflowName,
  graph,
  policy,
  repairMessage,
  onApplyRepair,
  onApplyWorker,
}: WorkflowAiAssistsProps) {
  const [active, setActive] = useState<Assist | null>(null);
  const [appliedNodes, setAppliedNodes] = useState<Set<string>>(new Set());
  const [createdTriggers, setCreatedTriggers] = useState<Set<number>>(new Set());
  const [pendingTriggerIndex, setPendingTriggerIndex] = useState<number | null>(null);
  const [repairShapeError, setRepairShapeError] = useState<string | null>(null);
  const explain = useExplainWorkflow();
  const repair = useRepairWorkflow();
  const workers = useSuggestWorkflowWorkers();
  const triggers = useSuggestWorkflowTriggers();
  const createTrigger = useCreateTrigger();
  const unresolved = unresolvedAgentNodes(graph);
  const busy =
    explain.isPending ||
    repair.isPending ||
    workers.isPending ||
    triggers.isPending ||
    createTrigger.isPending;

  const close = () => {
    if (busy) return;
    setActive(null);
    explain.reset();
    repair.reset();
    workers.reset();
    triggers.reset();
    createTrigger.reset();
    setRepairShapeError(null);
    setPendingTriggerIndex(null);
  };

  const open = (next: Assist) => {
    if (busy) return;
    explain.reset();
    repair.reset();
    workers.reset();
    triggers.reset();
    createTrigger.reset();
    setRepairShapeError(null);
    setAppliedNodes(new Set());
    setCreatedTriggers(new Set());
    setPendingTriggerIndex(null);
    setActive(next);
    if (next === "explain") explain.mutate({ workflowId });
    if (next === "repair") {
      repair.mutate({
        workflowId,
        graph: serializeWorkflowGraph(graph),
        policy: serializeWorkflowPolicy(policy),
        triggers: [],
      });
    }
    if (next === "workers") {
      workers.mutate({
        graph: serializeWorkflowGraph(graph),
        policy: serializeWorkflowPolicy(policy),
      });
    }
    if (next === "triggers") triggers.mutate({ workflowId });
  };

  const acceptRepair = () => {
    const draft = repair.data;
    if (!draft) return;
    const nextGraph = parseWorkflowGraph(draft.graph);
    const nextPolicy = parseWorkflowPolicy(draft.policy);
    if (!nextGraph.ok || !nextPolicy.ok) {
      setRepairShapeError("Atlas returned a repair this editor cannot represent.");
      return;
    }
    onApplyRepair(draft, nextGraph.value, nextPolicy.value);
    close();
  };

  const applyWorker = (suggestion: AtlasWorkerSuggestion) => {
    if (!suggestion.worker_id) return;
    onApplyWorker(applyWorkerSuggestion(graph, suggestion));
    setAppliedNodes((previous) => new Set(previous).add(suggestion.node_id));
  };

  const createSuggestedTrigger = (trigger: AtlasTriggerDraft, index: number) => {
    if (!trigger.name || !trigger.type) return;
    setPendingTriggerIndex(index);
    createTrigger.mutate(
      {
        workflowDefinitionId: workflowId,
        name: trigger.name.trim(),
        type: trigger.type,
        enabled: trigger.enabled !== false,
        config: trigger.config,
      },
      {
        onSuccess: () => setCreatedTriggers((previous) => new Set(previous).add(index)),
        onSettled: () => setPendingTriggerIndex(null),
      },
    );
  };

  const activeError =
    active === "explain"
      ? explain.error
      : active === "repair"
        ? repair.error
        : active === "workers"
          ? workers.error
          : (createTrigger.error ?? triggers.error);
  const activeBusy =
    active === "explain"
      ? explain.isPending
      : active === "repair"
        ? repair.isPending
        : active === "workers"
          ? workers.isPending
          : triggers.isPending;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" aria-label="AI workflow assists">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => open("explain")}
        >
          <Sparkles className="mr-1.5 size-3.5" aria-hidden="true" /> Explain
        </Button>
        {repairMessage ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => open("repair")}
          >
            <Wrench className="mr-1.5 size-3.5" aria-hidden="true" /> Repair with AI
          </Button>
        ) : null}
        {unresolved.length ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => open("workers")}
          >
            <Users className="mr-1.5 size-3.5" aria-hidden="true" /> Suggest workers (
            {unresolved.length})
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => open("triggers")}
        >
          <Zap className="mr-1.5 size-3.5" aria-hidden="true" /> Suggest triggers
        </Button>
      </div>

      <Dialog open={active !== null} onOpenChange={(next) => (next ? undefined : close())}>
        <DialogContent
          className={`max-h-[90vh] overflow-y-auto sm:max-w-2xl ${busy ? "[&>button]:hidden" : ""}`}
        >
          <DialogHeader>
            <DialogTitle>
              {active === "explain"
                ? "Explain workflow"
                : active === "repair"
                  ? "Repair workflow with AI"
                  : active === "workers"
                    ? "Suggest workers"
                    : "Suggest triggers"}
            </DialogTitle>
            <DialogDescription>
              {active === "repair"
                ? "Atlas will return a validated proposal from the current canvas. It will not save until you accept it."
                : active === "workers"
                  ? "Atlas matches unresolved role-only nodes to real workers. Apply each worker explicitly."
                  : active === "triggers"
                    ? "Suggestions are display-only until you explicitly create each trigger."
                    : `A plain-language explanation of ${workflowName}.`}
            </DialogDescription>
          </DialogHeader>

          {activeBusy ? (
            <Busy>
              {active === "explain"
                ? "Asking Atlas to explain this workflow…"
                : "Asking Atlas for a proposal; this may take several minutes…"}
            </Busy>
          ) : null}
          {activeError ? <AssistError error={activeError} /> : null}

          {active === "explain" && explain.data ? (
            <p className="whitespace-pre-wrap rounded-md border border-border bg-card p-4 text-sm leading-relaxed">
              {explain.data}
            </p>
          ) : null}

          {active === "repair" && repair.data ? (
            <>
              <RepairPreview draft={repair.data} onApply={acceptRepair} disabled={busy} />
              {repairShapeError ? (
                <p role="alert" className="text-xs text-destructive">
                  {repairShapeError}
                </p>
              ) : null}
            </>
          ) : null}

          {active === "workers" && workers.data ? (
            workers.data.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No unresolved worker or manager nodes need a suggestion.
              </p>
            ) : (
              <ul className="space-y-2">
                {workers.data.map((suggestion) => (
                  <li
                    key={suggestion.node_id}
                    className="rounded-md border border-border bg-secondary/20 p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-mono text-xs">{suggestion.node_id}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          role: {suggestion.role || "omitted"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill tone={stateTone(suggestion.state)}>
                          {suggestion.state}
                        </StatusPill>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!suggestion.worker_id || appliedNodes.has(suggestion.node_id)}
                          onClick={() => applyWorker(suggestion)}
                        >
                          {appliedNodes.has(suggestion.node_id)
                            ? "Applied"
                            : suggestion.worker_id
                              ? "Apply worker"
                              : "No worker id"}
                        </Button>
                      </div>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {suggestion.reason}
                    </p>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {active === "triggers" && triggers.data ? (
            triggers.data.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Atlas returned no trigger suggestions.
              </p>
            ) : (
              <ul className="space-y-2">
                {triggers.data.map((trigger, index) => (
                  <TriggerSuggestion
                    key={`${trigger.name ?? "trigger"}-${index}`}
                    trigger={trigger}
                    index={index}
                    pending={pendingTriggerIndex === index}
                    created={createdTriggers.has(index)}
                    onCreate={() => createSuggestedTrigger(trigger, index)}
                  />
                ))}
              </ul>
            )
          ) : null}

          {repairMessage && active === "repair" ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Atlas rejected the previous save or validation with:{" "}
              <span className="text-foreground">{repairMessage}</span>
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
