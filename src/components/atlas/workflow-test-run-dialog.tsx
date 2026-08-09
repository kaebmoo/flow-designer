/**
 * The Test Run dialog: enter run input, read the contract, start one real Atlas run.
 *
 * Two modes, chosen by whether the workflow has a stored `interface`:
 *
 *  - **Declared · enforced by Atlas** — the workflow has a `schema_version: 1` interface. Input
 *    is prefilled from `sample_input`, validated locally against `input_schema` for fast
 *    feedback, and submitted with `expected_workflow_version` so Atlas rejects a stale start
 *    (409) before it rejects bad business input (400) — see `atlas/workflows.py`'s ordering.
 *    Atlas's response is final; local validation exists to avoid an obviously doomed round trip,
 *    never to override what Atlas actually says.
 *  - **Observed · not enforced by Atlas** — Milestone A's legacy fallback, unchanged in
 *    substance, for a workflow whose `interface` is absent (or in a schema_version this client
 *    does not understand, which is treated the same way: nothing to declare from).
 *
 * Rules that hold in both modes:
 *
 *  1. **Opening it has no side effect.** Only the explicit `Start test run` click mutates
 *     anything.
 *  2. **Nothing generated here contains anything real.** Snippets and downloads come from the
 *     contract (declared or observed), never from the textarea, the deployment's Atlas origin,
 *     or a bearer.
 *  3. **The entered input is never persisted.** No localStorage, no sessionStorage, no search
 *     param, no log — cleared on every open and every close.
 *  4. A **409** (stale `expected_workflow_version`) and a **400** (Atlas's own validation) are
 *     both shown as Atlas wrote them, with no automatic retry. The operator resubmits
 *     deliberately, after reloading if the version moved.
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
import type { AtlasWorkflowInterface } from "@/lib/atlas-types";
import type { JsonObject } from "@/lib/workflow-graph";
import {
  authoritativeContractJson,
  authoritativeContractMarkdown,
  authoritativeSnippets,
  businessProjection,
  detectInterfaceGraphDrift,
  EFFECTIVE_INPUT_MAX_BYTES,
  estimateEffectiveInputBytes,
  MIN_COMPATIBLE_ATLAS_COMMIT,
  validateInstanceAgainstSchema,
  type DriftFinding,
  type InterfaceDiagnostic,
} from "@/lib/workflow-interface-contract";
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

/** Labels asserted verbatim by the browser tests. */
export const OBSERVED_BADGE = "Observed · not enforced by Atlas";
export const DECLARED_BADGE = "Declared · enforced by Atlas";

export interface WorkflowTestRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Always the current graph's observed contract — the legacy source, and the drift target. */
  contract: ObservedContract;
  /** The workflow's `schema_version: 1` interface, or `null` for legacy/unsupported-version. */
  declaredInterface: AtlasWorkflowInterface | null;
  /** The workflow's current version — sent as `expected_workflow_version` in declared mode. */
  workflowVersion: number;
  workflowName: string;
  /** True while the route's start mutation is in flight. Blocks a second submit. */
  pending: boolean;
  /** Atlas's own refusal, shown verbatim. Null when the last attempt did not fail. */
  error: { kind: string; message: string } | null;
  /** `hold: true` asks for a born-paused run — attach files on the run page, then Resume. */
  onStart: (input: JsonObject, options: { hold: boolean }) => void;
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

function DriftNote({ drift }: { drift: DriftFinding[] }) {
  if (drift.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="test-run-drift"
      className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
    >
      <p className="mb-1 font-semibold">Declared interface and observed prompt usage disagree:</p>
      <ul className="space-y-1">
        {drift.map((finding, index) => (
          <li key={`${finding.kind}:${index}`} className="text-muted-foreground">
            {finding.message}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-muted-foreground">
        Neither source changes automatically. Atlas's declared validation remains the boundary.
      </p>
    </div>
  );
}

function DeclaredIntegrationTab({
  contract,
  declaredInterface,
  workflowVersion,
}: {
  contract: ObservedContract;
  declaredInterface: AtlasWorkflowInterface;
  workflowVersion: number;
}) {
  const ctx = useMemo(
    () => ({ workflowId: contract.workflowId, workflowVersion, interfaceValue: declaredInterface }),
    [contract.workflowId, workflowVersion, declaredInterface],
  );
  const snippets = useMemo(() => authoritativeSnippets(ctx), [ctx]);
  const json = useMemo(() => authoritativeContractJson(ctx), [ctx]);
  const markdown = useMemo(() => authoritativeContractMarkdown(ctx), [ctx]);
  const drift = useMemo(
    () =>
      detectInterfaceGraphDrift(
        { input_schema: declaredInterface.input_schema, outputs: declaredInterface.outputs ?? [] },
        contract,
      ),
    [declaredInterface, contract],
  );
  const outputs = declaredInterface.outputs ?? [];

  return (
    <div className="space-y-6">
      <p
        data-testid="declared-badge"
        role="note"
        className="rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-xs leading-relaxed text-foreground"
      >
        <span className="font-bold uppercase tracking-wider">{DECLARED_BADGE}</span> — the
        input_schema, sample, and outputs below are stored on this workflow definition and validated
        by Atlas on every direct start. Minimum compatible Atlas commit:{" "}
        <span className="font-mono text-[11px]">{MIN_COMPATIBLE_ATLAS_COMMIT}</span>.
      </p>

      <DriftNote drift={drift} />

      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-primary">
          Atlas API facts
        </h3>
        <dl className="grid gap-2 rounded-lg border border-border bg-card px-3 py-3 text-xs sm:grid-cols-[13rem_1fr]">
          <dt className="text-muted-foreground">Start a run</dt>
          <dd className="font-mono text-[11px]">
            POST /api/workflow-runs —{" "}
            {`{ workflow_definition_id, input, expected_workflow_version }`}
          </dd>

          <dt className="text-muted-foreground">Version pin</dt>
          <dd className="font-mono text-[11px]">expected_workflow_version: {workflowVersion}</dd>

          <dt className="text-muted-foreground">Invalid business input</dt>
          <dd>400, field/path named in the error, no run created.</dd>

          <dt className="text-muted-foreground">Stale version</dt>
          <dd>409, no run created, no automatic retry — reload and resubmit deliberately.</dd>

          <dt className="text-muted-foreground">Response</dt>
          <dd>
            <span className="font-mono text-[11px]">202</span> with the real run row.
          </dd>

          <dt className="text-muted-foreground">Progress</dt>
          <dd>
            Poll <span className="font-mono text-[11px]">GET /api/workflow-runs/{`{id}`}</span>.
          </dd>

          <dt className="text-muted-foreground">Outputs</dt>
          <dd className="font-mono text-[11px]">GET /api/workflow-runs/{`{id}`}/artifacts</dd>

          <dt className="text-muted-foreground">Approvals</dt>
          <dd className="font-mono text-[11px]">
            POST /api/approvals/{`{id}`}/approve | /reject | /choose
          </dd>

          <dt className="text-muted-foreground">Reply webhook</dt>
          <dd>
            Optional, through <span className="font-mono text-[11px]">input._meta.reply</span>.
          </dd>

          <dt className="text-muted-foreground">Trigger limitation</dt>
          <dd>
            <span className="font-mono text-[11px]">POST …/fire</span> does not accept a version pin
            in this Atlas version — a fixed-payload trigger that cannot satisfy this interface
            records a failed event and starts no run.
          </dd>
        </dl>
      </section>

      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-success">
          Declared contract
        </h3>
        <div className="space-y-3 rounded-lg border border-success/40 bg-card px-3 py-3">
          <div>
            <h4 className="mb-1 text-xs font-semibold">input_schema</h4>
            <pre className="max-h-48 overflow-auto rounded-md border border-border bg-secondary/20 px-2 py-1.5 text-[11px]">
              {JSON.stringify(declaredInterface.input_schema, null, 2)}
            </pre>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold">Public outputs</h4>
            {outputs.length === 0 ? (
              <p className="text-xs text-muted-foreground">No public output is declared.</p>
            ) : (
              <ul className="space-y-1" data-testid="declared-outputs">
                {outputs.map((output) => (
                  <li key={output.key} className="text-xs">
                    <span className="font-mono text-[11px] text-primary">{output.key}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      — kind {output.kind}
                      {output.key === declaredInterface.primary_output ? " · primary" : ""}
                      {output.title ? ` · ${output.title}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Every output is possible, never guaranteed: a graph can branch, so an omitted output
              does not fail an otherwise successful run.
            </p>
          </div>
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
                  `${contract.workflowId}-declared-contract.json`,
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
                  `${contract.workflowId}-declared-contract.md`,
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
          <span className="font-mono">$ATLAS_TOKEN</span> placeholders and the stored
          <span className="font-mono"> sample_input</span> — never this deployment's Atlas origin, a
          bearer, or anything typed on the Input JSON tab. Call Atlas from your application's
          backend: a bearer in browser JavaScript is readable by anything running on the page.
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

function ObservedIntegrationTab({ contract }: { contract: ObservedContract }) {
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
        under “Observed workflow facts” was read out of this graph&apos;s prompt text. This workflow
        has no authoritative interface (or one this build does not understand), so Atlas cannot
        reject bad business input before creating a run. Nothing below promises a type, a default,
        which fields matter on which branch, or that an artifact will exist.
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
                      {path.referencedByStartNode
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
  declaredInterface,
  workflowVersion,
  workflowName,
  pending,
  error,
  onStart,
}: WorkflowTestRunDialogProps) {
  const authoritative = declaredInterface !== null;

  const initial = useMemo(() => {
    if (declaredInterface)
      return `${JSON.stringify(declaredInterface.sample_input ?? {}, null, 2)}\n`;
    return `${JSON.stringify(contract.skeleton ?? {}, null, 2)}\n`;
  }, [declaredInterface, contract.skeleton]);
  const [text, setText] = useState(initial);
  // Held start is per-attempt intent, not a sticky preference: it re-arms as unchecked on
  // every open so a held run is always an explicit choice for THIS attempt.
  const [hold, setHold] = useState(false);

  // Reset on every open rather than on mount. The dialog stays mounted between openings, and
  // carrying the previous attempt's payload forward would be exactly the quiet persistence this
  // component exists to avoid.
  useEffect(() => {
    // Cleared on close as well as re-seeded on open: the payload is business data, and leaving
    // it in component state while the dialog is shut means a stray render, a React DevTools
    // inspection, or a later reopen can still surface it.
    setText(open ? initial : "");
    setHold(false);
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

  const legacyPreflight = useMemo(
    () => (!authoritative && parsed.ok ? preflightRunInput(contract, parsed.value) : null),
    [authoritative, parsed, contract],
  );

  const declaredDiagnostics: InterfaceDiagnostic[] = useMemo(() => {
    if (!authoritative || !declaredInterface || !parsed.ok) return [];
    return validateInstanceAgainstSchema(
      declaredInterface.input_schema,
      businessProjection(parsed.value),
    );
  }, [authoritative, declaredInterface, parsed]);

  const effectiveBytes = useMemo(
    () => (authoritative && parsed.ok ? estimateEffectiveInputBytes(parsed.value) : 0),
    [authoritative, parsed],
  );
  const nearSizeLimit = authoritative && effectiveBytes > EFFECTIVE_INPUT_MAX_BYTES * 0.9;
  const overSizeLimit = authoritative && effectiveBytes > EFFECTIVE_INPUT_MAX_BYTES;

  const legacyBlocking = legacyPreflight?.blocking ?? [];
  const legacyWarnings = legacyPreflight?.warnings ?? [];
  const blockingErrors = authoritative
    ? declaredDiagnostics.filter((d) => d.severity === "error")
    : [];

  const problem = !parsed.ok ? parsed.message : null;
  const canStart =
    parsed.ok &&
    !pending &&
    (authoritative ? blockingErrors.length === 0 : legacyBlocking.length === 0);

  const describedBy =
    [
      problem || legacyBlocking.length > 0 || blockingErrors.length > 0 ? "test-run-problem" : null,
      "test-run-cost",
    ]
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
                aria-invalid={
                  problem !== null || legacyBlocking.length > 0 || blockingErrors.length > 0
                }
                aria-describedby={describedBy}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {authoritative
                  ? "Prefilled from this workflow's declared sample_input. Edit freely — Atlas's stored input_schema is the authority, not this example."
                  : contract.skeleton === null
                    ? "The example is empty because two observed paths overlap — see the Integration tab. Edit this freely."
                    : contract.inputPaths.length === 0
                      ? "This graph references no run input, so the example is an empty object. Edit it freely; Atlas accepts any JSON object."
                      : "The example is generated from the paths this graph references. Its values are placeholders showing shape, not defaults or types — replace them."}{" "}
                Nothing typed here is saved, and it never appears in a generated example or
                download.
              </p>
            </div>

            {problem !== null || legacyBlocking.length > 0 || blockingErrors.length > 0 ? (
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
                    {authoritative
                      ? blockingErrors.map((diagnostic, index) => (
                          <li key={`${diagnostic.path}:${index}`}>
                            <span className="font-mono">{diagnostic.path}</span>:{" "}
                            {diagnostic.message}
                          </li>
                        ))
                      : legacyBlocking.map((finding) => (
                          <li key={finding.path}>{finding.message}</li>
                        ))}
                  </ul>
                )}
              </div>
            ) : null}

            {!authoritative && legacyWarnings.length > 0 ? (
              <div
                role="status"
                data-testid="test-run-warnings"
                className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
              >
                <p className="mb-1 font-semibold">
                  Observed, not enforced — these may not apply to the branch this run takes:
                </p>
                <ul className="space-y-1">
                  {legacyWarnings.map((finding) => (
                    <li key={finding.path} className="text-muted-foreground">
                      {finding.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {authoritative && nearSizeLimit ? (
              <p
                role="status"
                data-testid="test-run-size-warning"
                className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
              >
                Advisory: this input is an estimated {effectiveBytes.toLocaleString()} bytes,{" "}
                {overSizeLimit ? "over" : "near"} Atlas's{" "}
                {EFFECTIVE_INPUT_MAX_BYTES.toLocaleString()}
                -byte effective-input limit. This estimate is not byte-identical to Atlas's own
                measurement (which also includes any{" "}
                <span className="font-mono">default_reply</span> merge) and does not block starting
                — Atlas's response is final.
              </p>
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
                {error.message}
                {error.kind === "conflict"
                  ? " Reload the workflow to see the version Atlas now has, then decide whether to resubmit — this is not retried automatically."
                  : null}
              </p>
            ) : null}
          </TabsContent>

          <TabsContent value="integration">
            {authoritative && declaredInterface ? (
              <DeclaredIntegrationTab
                contract={contract}
                declaredInterface={declaredInterface}
                workflowVersion={workflowVersion}
              />
            ) : (
              <ObservedIntegrationTab contract={contract} />
            )}
          </TabsContent>
        </Tabs>

        <div className="mt-2 flex items-start gap-2">
          <input
            id="test-run-hold"
            type="checkbox"
            className="mt-0.5"
            checked={hold}
            disabled={pending}
            onChange={(event) => setHold(event.target.checked)}
          />
          <Label htmlFor="test-run-hold" className="text-xs font-normal leading-relaxed">
            Start held (paused) — attach input files on the run page first, then press Resume there.
            Uploads can never race the first node this way. Files land as{" "}
            <span className="font-mono">upload_*</span> artifacts an edge can hand to a worker with{" "}
            <span className="font-mono">push_files: [&quot;upload_*&quot;]</span>.
          </Label>
        </div>

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
              onStart(result.value, { hold });
            }}
          >
            {pending ? "Starting…" : hold ? "Create held run" : "Start test run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
