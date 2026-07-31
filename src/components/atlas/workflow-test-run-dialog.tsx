/**
 * The Test Run dialog: enter run input, read the observed contract, start one real Atlas run.
 *
 * Two rules shape everything here.
 *
 *  1. **Opening it has no side effect.** The editor's old one-click Run posted immediately, so
 *     there was no moment at which an operator could see what would be sent. This dialog reads
 *     and validates; only the explicit `Start test run` click mutates anything.
 *  2. **Nothing generated here contains anything real.** Snippets and downloads are built from
 *     the contract's illustrative skeleton, never from the textarea, never from the deployment's
 *     Atlas origin, and never from a bearer — the browser does not have one to leak. That is what
 *     makes offering copy and download safe at all.
 *
 * The entered input is deliberately not persisted anywhere: no localStorage, no sessionStorage,
 * no search param, no log. A test payload is business data — often the most sensitive data in the
 * system — and a convenience that survives the dialog closing is a convenience that survives a
 * shared machine.
 *
 * The mutation lives in the route, not here. This component reports an explicit intent to start
 * with a parsed object; the route owns single-flight, Atlas's error, and navigation to the real
 * `wfr_…` id.
 */

import { useEffect, useMemo, useRef, useState } from "react";

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  contractJson,
  contractMarkdown,
  contractSnippets,
  MAX_RENDERED_OUTPUTS,
  MAX_RENDERED_PATHS,
  parseRunInput,
  preflightRunInput,
  type ObservedContract,
} from "@/lib/workflow-run-contract";
import type { JsonObject } from "@/lib/workflow-graph";

/** The label the Integration tab carries. Asserted verbatim by the browser tests. */
export const OBSERVED_BADGE = "Observed · not enforced by Atlas";

export interface WorkflowTestRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ObservedContract;
  workflowName: string;
  /** True while the route's start mutation is in flight. Blocks a second submit. */
  pending: boolean;
  /** Atlas's own refusal, shown verbatim. Null when the last attempt did not fail. */
  error: string | null;
  onStart: (input: JsonObject) => void;
}

/**
 * Copies text and reports it, without a library and without a persistent success state.
 *
 * The confirmation clears itself so a stale "Copied" can never suggest the *current* panel is
 * what sits on the clipboard.
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2_000);
          },
          () => {
            // A denied clipboard permission is the browser's decision, not an app failure. The
            // text is on screen and selectable either way, so this stays silent.
          },
        );
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/** Saves generated text through an object URL. No server round trip, so no payload leaves. */
function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Snippet({ title, language, code }: { title: string; language: string; code: string }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {title}
        </span>
        <CopyButton value={code} label="Copy" />
      </div>
      <pre className="max-h-64 overflow-auto px-3 py-2 text-[11px] leading-relaxed">
        <code data-language={language}>{code}</code>
      </pre>
    </div>
  );
}

function IntegrationTab({ contract }: { contract: ObservedContract }) {
  const snippets = useMemo(() => contractSnippets(contract), [contract]);
  const json = useMemo(() => contractJson(contract), [contract]);
  const markdown = useMemo(() => contractMarkdown(contract), [contract]);

  return (
    <div className="space-y-6">
      <p
        data-testid="observed-badge"
        role="note"
        className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-foreground"
      >
        <span className="font-bold uppercase tracking-wider">{OBSERVED_BADGE}</span> — everything
        under “Observed workflow facts” was read out of this graph&apos;s prompt text. Atlas stores
        no input schema for a workflow, so it cannot reject bad business input before creating a
        run. Nothing below promises a type, a default, which fields matter on which branch, or that
        an artifact will exist.
      </p>

      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-primary">
          Official Atlas API facts
        </h3>
        <dl className="grid gap-2 rounded-lg border border-border bg-card px-3 py-3 text-xs sm:grid-cols-[13rem_1fr]">
          <dt className="text-muted-foreground">Start a run</dt>
          <dd className="font-mono text-[11px]">
            POST /api/workflow-runs — {`{ workflow_definition_id, input }`}
          </dd>

          <dt className="text-muted-foreground">Response</dt>
          <dd>
            <span className="font-mono text-[11px]">202</span> with the real run row; its id is{" "}
            <span className="font-mono text-[11px]">wfr_…</span>.
          </dd>

          <dt className="text-muted-foreground">Progress</dt>
          <dd>
            Poll <span className="font-mono text-[11px]">GET /api/workflow-runs/{`{id}`}</span>.
            Atlas has no run-level event stream.
          </dd>

          <dt className="text-muted-foreground">Outputs</dt>
          <dd className="font-mono text-[11px]">GET /api/workflow-runs/{`{id}`}/artifacts</dd>

          <dt className="text-muted-foreground">Waiting states</dt>
          <dd className="font-mono text-[11px]">
            queued · running · paused · waiting_for_human · recovery_required
          </dd>

          <dt className="text-muted-foreground">Terminal states</dt>
          <dd className="font-mono text-[11px]">succeeded · failed · cancelled</dd>

          <dt className="text-muted-foreground">Approvals</dt>
          <dd className="font-mono text-[11px]">
            POST /api/approvals/{`{id}`}/approve | /reject | /choose
          </dd>

          <dt className="text-muted-foreground">Reply webhook</dt>
          <dd>
            Optional, through <span className="font-mono text-[11px]">input._meta.reply</span>.
            Atlas signs the callback.
          </dd>

          <dt className="text-muted-foreground">Duplicate protection</dt>
          <dd>
            <strong>None on this route</strong> — two POSTs are two runs. A trigger&apos;s{" "}
            <span className="font-mono text-[11px]">/fire</span> does accept a dedupe key.
          </dd>
        </dl>
      </section>

      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-warning">
          Observed workflow facts
        </h3>
        <div className="space-y-3 rounded-lg border border-warning/40 bg-card px-3 py-3">
          <p className="text-xs">
            Workflow{" "}
            <span className="font-mono text-[11px] text-primary">{contract.workflowId}</span>,
            observed at version{" "}
            <span className="font-mono text-[11px]">{contract.observedVersion}</span>. Atlas offers
            no way to pin a run to a version, so an edit between reading this and calling the API is
            not detected.
          </p>

          <div>
            <h4 className="mb-1 text-xs font-semibold">Observed input paths</h4>
            {contract.inputPaths.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No <span className="font-mono">{`{input.*}`}</span> reference appears in any prompt
                Atlas interpolates.
              </p>
            ) : (
              <ul className="space-y-1" data-testid="observed-input-paths">
                {contract.inputPaths.slice(0, MAX_RENDERED_PATHS).map((path) => (
                  <li key={path.path} className="text-xs">
                    <span className="font-mono text-[11px] text-primary">{path.path}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      — read by {path.nodeIds.join(", ")}
                      {path.referencedByStartWorker
                        ? "; the start node renders it before any branch is chosen"
                        : "; only on the branch that reaches those nodes"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {contract.inputPaths.length > MAX_RENDERED_PATHS ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Showing {MAX_RENDERED_PATHS} of {contract.inputPaths.length}. The Input JSON tab
                checks every one of them, and the generated example carries them all.
              </p>
            ) : null}
          </div>

          <div>
            <h4 className="mb-1 text-xs font-semibold">Possible outputs</h4>
            {contract.outputs.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No worker node declares an output artifact key.
              </p>
            ) : (
              <ul className="space-y-1" data-testid="observed-outputs">
                {contract.outputs.slice(0, MAX_RENDERED_OUTPUTS).map((output) => (
                  <li key={`${output.nodeId}:${output.key}`} className="text-xs">
                    <span className="font-mono text-[11px] text-primary">{output.key}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      — possible output of {output.nodeId}, observed kind {output.kind}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {contract.diagnostics.length > 0 ? (
            <div>
              <h4 className="mb-1 text-xs font-semibold">Diagnostics</h4>
              <ul className="space-y-1" data-testid="observed-diagnostics">
                {contract.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}:${index}`} className="text-xs">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-warning">
                      {diagnostic.severity}
                    </span>{" "}
                    <span className="text-muted-foreground">{diagnostic.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="text-xs leading-relaxed text-muted-foreground">
            Limitations: an output appears only on the branch Atlas takes and only when its node
            succeeds; a <span className="font-mono">collect_files</span> pattern yields no known key
            because matches are discovered while the worker runs; prompt text carries no type
            information. An <span className="font-mono">attachments</span> field in JSON is text or
            metadata, never an uploaded file — Atlas&apos;s{" "}
            <span className="font-mono text-[11px]">POST /api/workflow-runs/{`{id}`}/files</span>{" "}
            needs a run that already exists, so it cannot stage binary input for the start node.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-mono text-[10px] uppercase tracking-widest text-primary">
            Backend examples
          </h3>
          <span className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                downloadText(
                  `${contract.workflowId}-observed-contract.json`,
                  json,
                  "application/json",
                )
              }
            >
              Download JSON
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                downloadText(
                  `${contract.workflowId}-observed-contract.md`,
                  markdown,
                  "text/markdown",
                )
              }
            >
              Download Markdown
            </Button>
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          These use <span className="font-mono">$ATLAS_BASE_URL</span> and{" "}
          <span className="font-mono">$ATLAS_TOKEN</span> placeholders and the illustrative example
          object — never this deployment&apos;s Atlas origin, a bearer, or anything typed on the
          Input JSON tab. Call Atlas from your application&apos;s backend: a bearer in browser
          JavaScript is readable by anything running on the page.
        </p>
        <Snippet title="cURL" language="bash" code={snippets.curl} />
        <Snippet
          title="TypeScript (server-side)"
          language="typescript"
          code={snippets.typescript}
        />
        <Snippet title="Python (server-side)" language="python" code={snippets.python} />
        <Snippet title="Approvals (cURL)" language="bash" code={snippets.approval} />
        <Snippet
          title="Signed reply webhook (server-side)"
          language="typescript"
          code={snippets.webhook}
        />
      </section>
    </div>
  );
}

export function WorkflowTestRunDialog({
  open,
  onOpenChange,
  contract,
  workflowName,
  pending,
  error,
  onStart,
}: WorkflowTestRunDialogProps) {
  const initial = useMemo(
    () => `${JSON.stringify(contract.skeleton ?? {}, null, 2)}\n`,
    [contract.skeleton],
  );
  const [text, setText] = useState(initial);

  // Reset on every open rather than on mount. The dialog stays mounted between openings, and
  // carrying the previous attempt's payload forward would be exactly the quiet persistence this
  // component exists to avoid.
  useEffect(() => {
    // Cleared on close as well as re-seeded on open: the payload is business data, and leaving
    // it in component state while the dialog is shut means a stray render, a React DevTools
    // inspection, or a later reopen can still surface it.
    setText(open ? initial : "");
  }, [open, initial]);

  /**
   * What focus returns to when the dialog closes.
   *
   * Radix restores focus to `DialogTrigger`'s ref, and this dialog is opened by an ordinary
   * button in the editor toolbar rather than by a `DialogTrigger` — so that ref is null, Radix's
   * own `onCloseAutoFocus` focuses nothing, and a keyboard user is left on `<body>` at the top of
   * the document with no way back to where they were.
   *
   * Captured during the render that opens the dialog. That render happens synchronously inside
   * the click handler, before Radix's effects move focus into the content — an effect here would
   * run *after* the portal's own effects and would only ever see the dialog.
   */
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  /**
   * A synchronous latch, because `pending` is not one.
   *
   * `pending` is React state derived from the mutation, so it is only true on a *later* render.
   * Two clicks dispatched inside one task — a double-click, an automated burst, a stuck key —
   * both observe the old value and both call `onStart`. Atlas has no dedupe key on
   * `POST /api/workflow-runs`, so that is two real runs and two workers' worth of budget. A ref
   * flips during the first click's own handler, which no second click in any task can race.
   */
  const submitting = useRef(false);
  const wasPending = useRef(false);

  if (open !== wasOpen.current) {
    if (open && typeof document !== "undefined") {
      opener.current = document.activeElement as HTMLElement | null;
    }
    // A dialog reopened after a refusal must be submittable again.
    if (open) submitting.current = false;
    wasOpen.current = open;
  }

  // Released only on the true→false edge, so the latch survives the renders between the click
  // and the mutation reporting itself as pending.
  useEffect(() => {
    if (wasPending.current && !pending) submitting.current = false;
    wasPending.current = pending;
  }, [pending]);

  const parsed = useMemo(() => parseRunInput(text), [text]);
  const preflight = useMemo(
    () => (parsed.ok ? preflightRunInput(contract, parsed.value) : null),
    [parsed, contract],
  );

  const blocking = preflight?.blocking ?? [];
  const warnings = preflight?.warnings ?? [];
  const problem = !parsed.ok ? parsed.message : null;
  const canStart = parsed.ok && blocking.length === 0 && !pending;

  const describedBy =
    [problem || blocking.length > 0 ? "test-run-problem" : null, "test-run-cost"]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // No dismissal mid-flight: Escape here would present an unresolved start as abandoned,
        // and Atlas may already have created the run.
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      {/* Radix owns focus containment and Escape; the restore target is supplied above. */}
      <DialogContent
        className="max-h-[90vh] max-w-3xl overflow-y-auto"
        // `preventDefault` here suppresses Radix's own restore, which would focus the null
        // `DialogTrigger` ref. Radix composes this handler ahead of its internal one and skips
        // that one once the default is prevented.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Test run — {workflowName}</DialogTitle>
          <DialogDescription>
            Sends this JSON to Atlas as the run input. Atlas runs the <em>saved</em> graph, not the
            canvas on screen.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="input">
          <TabsList>
            <TabsTrigger value="input">Input JSON</TabsTrigger>
            <TabsTrigger value="integration">Integration</TabsTrigger>
          </TabsList>

          <TabsContent value="input" className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="test-run-input">Run input JSON</Label>
              <Textarea
                id="test-run-input"
                data-testid="test-run-input"
                spellCheck={false}
                // Nothing autocompletes here: the browser would otherwise offer a previous run's
                // business data back on the next test.
                autoComplete="off"
                className="min-h-56 font-mono text-xs"
                value={text}
                onChange={(event) => setText(event.target.value)}
                aria-invalid={problem !== null || blocking.length > 0}
                aria-describedby={describedBy}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {contract.skeleton === null
                  ? "The example is empty because two observed paths overlap — see the Integration tab. Edit this freely."
                  : contract.inputPaths.length === 0
                    ? "This graph references no run input, so the example is an empty object. Edit it freely; Atlas accepts any JSON object."
                    : "The example is generated from the paths this graph references. Its values are placeholders showing shape, not defaults or types — replace them."}{" "}
                Nothing typed here is saved, and it never appears in a generated example or
                download.
              </p>
            </div>

            {problem !== null || blocking.length > 0 ? (
              <div
                id="test-run-problem"
                role="alert"
                data-testid="test-run-problem"
                className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {problem !== null ? (
                  <p>{problem}</p>
                ) : (
                  <ul className="space-y-1">
                    {blocking.map((finding) => (
                      <li key={finding.path}>{finding.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            {warnings.length > 0 ? (
              <div
                role="status"
                data-testid="test-run-warnings"
                className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
              >
                <p className="mb-1 font-semibold">
                  Observed, not enforced — these may not apply to the branch this run takes:
                </p>
                <ul className="space-y-1">
                  {warnings.map((finding) => (
                    <li key={finding.path} className="text-muted-foreground">
                      {finding.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p
              id="test-run-cost"
              className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs leading-relaxed"
            >
              <strong>This starts a real Atlas run.</strong> Workers execute, budget units are
              consumed, and any webhook reply this workflow configures is sent. There is no dry run
              and no undo — a started run can only be cancelled.
            </p>

            {error ? (
              <p
                role="alert"
                data-testid="test-run-error"
                className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </p>
            ) : null}
          </TabsContent>

          <TabsContent value="integration">
            <IntegrationTab contract={contract} />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="start-test-run"
            aria-busy={pending}
            disabled={!canStart}
            onClick={() => {
              // The latch first, and synchronously: `disabled` and `pending` both only take
              // effect on a later render, so they cannot stop a second click in this same task.
              if (submitting.current || !canStart) return;
              // Re-parsed rather than reusing the memo's value: the button is the trust boundary
              // for this component, and a `canStart` that drifted from the text would start a run
              // with something the operator did not see.
              const result = parseRunInput(text);
              if (!result.ok) return;
              submitting.current = true;
              onStart(result.value);
            }}
          >
            {pending ? "Starting…" : "Start test run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
