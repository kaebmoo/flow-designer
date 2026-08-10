import { Link } from "@tanstack/react-router";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useDraftWorkflow } from "@/lib/atlas-mutations";
import type { AtlasWorkflowDraft } from "@/lib/atlas-types";
import {
  canSubmitWorkflowDraft,
  describeWorkflowDraftError,
  MAX_DRAFT_PROMPT_LENGTH,
  summarizeWorkflowDraft,
} from "@/lib/workflow-ai-draft";

export interface WorkflowAiDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (draft: AtlasWorkflowDraft) => void;
  createPending: boolean;
  createError: unknown;
}

function ActionError({ error }: { error: unknown }) {
  const details = describeWorkflowDraftError(error);
  return (
    <div
      role="alert"
      className={`space-y-2 rounded-md border px-3 py-2 text-xs leading-relaxed ${
        details.forbidden
          ? "border-accent/40 bg-accent/10 text-foreground"
          : "border-destructive/40 bg-destructive/10 text-foreground"
      }`}
    >
      <p className="flex gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{details.message}</span>
      </p>
      {details.needsBuilderSetup ? (
        <p className="pl-5 text-muted-foreground">
          Configure a worker tagged <code>workflow_builder</code>, then try again.
        </p>
      ) : null}
    </div>
  );
}

function DraftSummary({ draft }: { draft: AtlasWorkflowDraft }) {
  const summary = summarizeWorkflowDraft(draft);
  return (
    <div className="rounded-md border border-border bg-secondary/20 p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-primary">Proposal shape</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
        <dt className="text-muted-foreground">Nodes</dt>
        <dd>{summary.nodeCount}</dd>
        <dt className="text-muted-foreground">Node types</dt>
        <dd>{summary.nodeTypes.length ? summary.nodeTypes.join(", ") : "None"}</dd>
        <dt className="text-muted-foreground">Edges</dt>
        <dd>{summary.edgeCount}</dd>
        <dt className="text-muted-foreground">Policy fields</dt>
        <dd>{summary.policyKeys.length ? summary.policyKeys.join(", ") : "None"}</dd>
      </dl>
    </div>
  );
}

function ProposedTriggers({ triggers }: { triggers: AtlasWorkflowDraft["triggers"] }) {
  return (
    <section className="rounded-md border border-warning/40 bg-warning/10 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-mono text-[10px] uppercase tracking-widest text-warning">
          Proposed triggers · display only
        </h3>
        <Link to="/triggers" className="text-xs text-primary underline-offset-4 hover:underline">
          Manage triggers
        </Link>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Creating this proposal saves the workflow only. No trigger is created automatically.
      </p>
      <pre className="mt-3 max-h-40 overflow-auto rounded border border-border bg-background/60 p-2 text-[11px]">
        {JSON.stringify(triggers, null, 2)}
      </pre>
    </section>
  );
}

export function WorkflowAiDraftDialog({
  open,
  onOpenChange,
  onCreate,
  createPending,
  createError,
}: WorkflowAiDraftDialogProps) {
  const draftRequest = useDraftWorkflow();
  const [prompt, setPrompt] = useState("");
  const draft = draftRequest.data;
  const busy = draftRequest.isPending || createPending;

  useEffect(() => {
    if (!open) {
      setPrompt("");
      draftRequest.reset();
    }
  }, [open, draftRequest]);

  const close = () => {
    if (!busy) onOpenChange(false);
  };

  const submit = () => {
    if (!canSubmitWorkflowDraft(prompt) || busy) return;
    draftRequest.mutate({ plainLanguagePrompt: prompt.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className={`max-h-[90vh] overflow-y-auto sm:max-w-2xl ${busy ? "[&>button]:hidden" : ""}`}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            Draft with AI
          </DialogTitle>
          <DialogDescription>
            Describe the workflow in plain language. Atlas returns a validated proposal; it is not
            saved until you choose Create as draft &amp; open.
          </DialogDescription>
        </DialogHeader>

        {!draft ? (
          <div className="space-y-4">
            <div>
              <Label htmlFor="workflow-ai-prompt">Workflow description</Label>
              <Textarea
                id="workflow-ai-prompt"
                className="mt-2 min-h-32 resize-y"
                value={prompt}
                maxLength={MAX_DRAFT_PROMPT_LENGTH}
                disabled={busy}
                placeholder="When a customer submits a complaint, classify it, draft a reply, and send urgent cases to a human."
                onChange={(event) => setPrompt(event.target.value)}
              />
              <div className="mt-2 flex justify-between gap-3 text-[11px] text-muted-foreground">
                <span>English or Thai · never stored as a browser draft</span>
                <span className="font-mono">
                  {prompt.length.toLocaleString()}/{MAX_DRAFT_PROMPT_LENGTH.toLocaleString()}
                </span>
              </div>
            </div>
            {draftRequest.isPending ? (
              <p role="status" className="flex gap-2 text-xs text-muted-foreground">
                <Loader2
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Drafting calls your configured model and may take several minutes. Keep this window
                open; the dialog stays open while the request is in flight.
              </p>
            ) : null}
            {draftRequest.error ? <ActionError error={draftRequest.error} /> : null}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Proposed workflow
              </p>
              <h3 className="mt-1 text-lg font-semibold">{draft.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {draft.description || "No description."}
              </p>
            </div>
            <DraftSummary draft={draft} />
            <section className="rounded-md border border-border bg-card p-4">
              <h3 className="font-mono text-[10px] uppercase tracking-widest text-primary">
                Why Atlas chose this
              </h3>
              <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {draft.explanation}
              </p>
            </section>
            {draft.warnings.length ? (
              <div className="rounded-md border border-warning/40 bg-warning/10 p-4 text-xs leading-relaxed">
                <p className="font-semibold text-warning">Review before creating</p>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  {draft.warnings.map((warning, index) => (
                    <li key={`${warning}-${index}`}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {draft.triggers.length ? (
              <ProposedTriggers triggers={draft.triggers} />
            ) : (
              <p className="text-xs text-muted-foreground">No trigger suggestions.</p>
            )}
            {createError ? <ActionError error={createError} /> : null}
          </div>
        )}

        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="outline" disabled={busy} onClick={close}>
            {draft ? "Discard" : "Cancel"}
          </Button>
          {draft ? (
            <Button type="button" disabled={busy} onClick={() => onCreate(draft)}>
              {createPending ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : null}
              {createPending ? "Creating…" : "Create as draft & open"}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!canSubmitWorkflowDraft(prompt) || busy}
              onClick={submit}
            >
              {draftRequest.isPending ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : null}
              {draftRequest.isPending ? "Drafting…" : "Generate proposal"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
