/**
 * The workflow-level "Application interface" inspector.
 *
 * Authors Atlas's authoritative `interface` (`input_schema`, `sample_input`, `outputs`,
 * `primary_output`) alongside the graph. Raw JSON stays the only way to edit `input_schema` and
 * `sample_input` — nested objects and arrays are exactly the canonical Permit Application fixture
 * this panel is built against, and a lossy generated form would make them untestable. Outputs are
 * a table instead, because Atlas requires each declared key to be produced by exactly one worker
 * node in the graph — that is graph-derived data, not free text.
 *
 * Everything shown here is **advisory**. Atlas's own `PUT`/`POST /api/workflows` response remains
 * the authority; this panel's diagnostics exist so a mistake is visible before that round trip,
 * not instead of it.
 */

import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { WorkflowEditableInterface } from "@/lib/atlas-mappers";
import type { AtlasWorkflowInterface, AtlasWorkflowInterfaceOutput } from "@/lib/atlas-types";
import type { JsonObject } from "@/lib/workflow-graph";
import type { ObservedContract } from "@/lib/workflow-run-contract";
import {
  deriveInterfaceOutputCandidates,
  detectInterfaceGraphDrift,
  estimateCanonicalBytes,
  INPUT_SCHEMA_URI,
  INTERFACE_MAX_BYTES,
  INTERFACE_SCHEMA_VERSION,
  SAMPLE_MAX_BYTES,
  validateInputSchemaStructure,
  validateInstanceAgainstSchema,
  validateOutputs,
  type DriftFinding,
  type InterfaceDiagnostic,
} from "@/lib/workflow-interface-contract";

// ---------------------------------------------------------------------------
// Draft state — held by the editor, exactly like `policy` and `defaultReply` are.
// ---------------------------------------------------------------------------

export interface InterfaceOutputDraft {
  enabled: boolean;
  /**
   * `"text" | "json"` today, but typed open like {@link AtlasWorkflowInterfaceOutput.kind}: a
   * stored kind this build does not recognise round-trips instead of being coerced to `"text"`.
   */
  kind: string;
  title: string;
  description: string;
}

export interface InterfaceDraftState {
  /**
   * `"none"` — no interface is authored (covers both "never had one" and "explicitly cleared").
   * `"editing"` — a v1 interface is being authored from the two text areas and the output table.
   * `"unsupported"` — a future `schema_version` this client cannot parse; read-only, untouched.
   */
  mode: "none" | "editing" | "unsupported";
  unsupportedVersion?: number;
  inputSchemaText: string;
  sampleInputText: string;
  /** Keyed by output key, independent of whether that key currently exists in the graph. */
  outputs: Record<string, InterfaceOutputDraft>;
  primaryOutput: string;
}

const EMPTY_SCHEMA_TEXT = `${JSON.stringify(
  { type: "object", additionalProperties: false, properties: {}, required: [] },
  null,
  2,
)}\n`;
const EMPTY_SAMPLE_TEXT = `${JSON.stringify({}, null, 2)}\n`;

function outputsToDraft(
  outputs: AtlasWorkflowInterfaceOutput[] | undefined,
): Record<string, InterfaceOutputDraft> {
  const draft: Record<string, InterfaceOutputDraft> = {};
  for (const output of outputs ?? []) {
    draft[output.key] = {
      enabled: true,
      kind: output.kind,
      title: output.title ?? "",
      description: output.description ?? "",
    };
  }
  return draft;
}

/** The draft an editor session starts from, derived from what Atlas actually returned. */
export function initialInterfaceDraftState(
  editable: WorkflowEditableInterface,
): InterfaceDraftState {
  if (editable.kind === "unsupported") {
    return {
      mode: "unsupported",
      unsupportedVersion: editable.schemaVersion,
      inputSchemaText: `${JSON.stringify(editable.raw.input_schema, null, 2)}\n`,
      sampleInputText: `${JSON.stringify(editable.raw.sample_input ?? {}, null, 2)}\n`,
      outputs: outputsToDraft(editable.raw.outputs),
      primaryOutput: editable.raw.primary_output ?? "",
    };
  }
  if (editable.kind === "absent") {
    return {
      mode: "none",
      inputSchemaText: EMPTY_SCHEMA_TEXT,
      sampleInputText: EMPTY_SAMPLE_TEXT,
      outputs: {},
      primaryOutput: "",
    };
  }
  return {
    mode: "editing",
    inputSchemaText: `${JSON.stringify(editable.value.input_schema, null, 2)}\n`,
    sampleInputText: `${JSON.stringify(editable.value.sample_input ?? {}, null, 2)}\n`,
    outputs: outputsToDraft(editable.value.outputs),
    primaryOutput: editable.value.primary_output ?? "",
  };
}

export type InterfaceBuildResult =
  | { ok: true; interface: AtlasWorkflowInterface | null | undefined }
  | { ok: false; message: string };

/**
 * Converts the draft to the wire shape `useSaveWorkflow`/`useCreateWorkflow` sends.
 *
 * `undefined` means "omit the `interface` key" — Atlas's three-state `PUT` preserves whatever is
 * already stored. It is sent whenever the draft is `interfaceUnchanged` from what was loaded
 * (so a graph-only save never re-encodes a stored interface, and any additive field a future
 * Atlas ships inside v1 survives untouched), and always for `"unsupported"` (never re-encode a
 * version this client cannot parse). A *changed* draft in `"none"` mode sends an explicit `null`
 * clear — the caller's baseline comparison, not a mount-time flag, is what distinguishes "the
 * user cleared it this session" from "there was never anything to clear", so a clear issued
 * after an add-and-save in the same session still reaches Atlas.
 */
export function buildInterfacePayload(
  draft: InterfaceDraftState,
  interfaceUnchanged: boolean,
): InterfaceBuildResult {
  if (interfaceUnchanged || draft.mode === "unsupported") return { ok: true, interface: undefined };
  if (draft.mode === "none") return { ok: true, interface: null };

  let inputSchema: unknown;
  try {
    inputSchema = JSON.parse(draft.inputSchemaText);
  } catch (error) {
    return {
      ok: false,
      message: `input_schema is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (inputSchema === null || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return { ok: false, message: "input_schema must be a JSON object." };
  }

  let sampleInput: unknown;
  try {
    sampleInput = JSON.parse(draft.sampleInputText);
  } catch (error) {
    return {
      ok: false,
      message: `sample_input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (sampleInput === null || typeof sampleInput !== "object" || Array.isArray(sampleInput)) {
    return { ok: false, message: "sample_input must be a JSON object." };
  }

  const outputs: AtlasWorkflowInterfaceOutput[] = Object.entries(draft.outputs)
    .filter(([, entry]) => entry.enabled)
    .map(([key, entry]) => ({
      key,
      kind: entry.kind,
      ...(entry.title.trim() ? { title: entry.title.trim() } : {}),
      ...(entry.description.trim() ? { description: entry.description.trim() } : {}),
    }));
  const primaryOutput =
    draft.primaryOutput && outputs.some((entry) => entry.key === draft.primaryOutput)
      ? draft.primaryOutput
      : undefined;
  const sampleIsEmpty = Object.keys(sampleInput as Record<string, unknown>).length === 0;

  return {
    ok: true,
    interface: {
      schema_version: INTERFACE_SCHEMA_VERSION,
      input_schema: inputSchema as JsonObject,
      ...(sampleIsEmpty ? {} : { sample_input: sampleInput as JsonObject }),
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(primaryOutput ? { primary_output: primaryOutput } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface WorkflowInterfacePanelProps {
  draft: InterfaceDraftState;
  onChange: (next: InterfaceDraftState) => void;
  /** The observed contract of the graph as currently drawn — for the output table and drift. */
  contract: ObservedContract;
}

/**
 * `aria-live` because these appear *while typing*, not on submit.
 *
 * A JSON error here blocks Save, and it was previously rendered into a plain list with nothing
 * announcing it — a screen-reader user learned the interface was invalid only by tabbing to a
 * Save button that had gone quiet. `polite` rather than `assertive`: the operator is mid-keystroke
 * and should not be interrupted, only told.
 */
function DiagnosticList({ diagnostics }: { diagnostics: InterfaceDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <ul
      className="mt-1.5 space-y-1"
      data-testid="interface-diagnostics"
      aria-live="polite"
      aria-atomic="true"
    >
      {diagnostics.map((diagnostic, index) => (
        <li
          key={`${diagnostic.path}:${index}`}
          className={`text-[11px] leading-snug ${
            diagnostic.severity === "error" ? "text-destructive" : "text-warning"
          }`}
        >
          <span className="font-mono">{diagnostic.path}</span>: {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}

function bytesLabel(bytes: number, max: number): string {
  return `${bytes.toLocaleString()} / ${max.toLocaleString()} bytes (advisory estimate)`;
}

export function WorkflowInterfacePanel({ draft, onChange, contract }: WorkflowInterfacePanelProps) {
  const parsedSchema = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(draft.inputSchemaText) };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }, [draft.inputSchemaText]);

  const parsedSample = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(draft.sampleInputText) };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }, [draft.sampleInputText]);

  const schemaDiagnostics: InterfaceDiagnostic[] = useMemo(() => {
    if (!parsedSchema.ok) {
      return [{ path: "$", severity: "error", message: `Not valid JSON: ${parsedSchema.message}` }];
    }
    return validateInputSchemaStructure(parsedSchema.value, { isRoot: true });
  }, [parsedSchema]);

  const sampleDiagnostics: InterfaceDiagnostic[] = useMemo(() => {
    if (!parsedSample.ok) {
      return [{ path: "$", severity: "error", message: `Not valid JSON: ${parsedSample.message}` }];
    }
    if (
      parsedSample.value === null ||
      typeof parsedSample.value !== "object" ||
      Array.isArray(parsedSample.value)
    ) {
      return [{ path: "$", severity: "error", message: "sample_input must be a JSON object." }];
    }
    if (!parsedSchema.ok) return [];
    return validateInstanceAgainstSchema(parsedSchema.value, parsedSample.value);
  }, [parsedSample, parsedSchema]);

  const candidates = useMemo(() => deriveInterfaceOutputCandidates(contract), [contract]);
  const declaredOutputEntries = Object.entries(draft.outputs);
  const orphanedDeclared = declaredOutputEntries.filter(
    ([key]) => !candidates.some((candidate) => candidate.key === key),
  );

  const outputDiagnostics = useMemo(() => {
    const diagnostics = validateOutputs(
      declaredOutputEntries
        .filter(([, entry]) => entry.enabled)
        .map(([key, entry]) => ({
          key,
          kind: entry.kind,
          ...(entry.title.trim() ? { title: entry.title.trim() } : {}),
          ...(entry.description.trim() ? { description: entry.description.trim() } : {}),
        })),
      draft.primaryOutput || undefined,
    );
    // Atlas hard-rejects a declared key produced by more than one worker node; surface that here
    // so Save is not a guaranteed 400 discovered only after the round trip.
    for (const candidate of candidates) {
      if (!candidate.unique && draft.outputs[candidate.key]?.enabled) {
        diagnostics.push({
          path: `$.outputs.${candidate.key}`,
          severity: "error",
          message: `"${candidate.key}" is produced by more than one node (${candidate.nodeIds.join(", ")}); Atlas rejects a declared key without exactly one producer. Un-declare it or change the graph.`,
        });
      }
    }
    return diagnostics;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.outputs, draft.primaryOutput, candidates]);

  const drift: DriftFinding[] = useMemo(() => {
    if (draft.mode !== "editing" || !parsedSchema.ok) return [];
    // While the text parses to a non-object (mid-edit), the root-type error already says
    // everything; running the path checks against it would list every prompt path as
    // unrepresentable on top of it.
    if (
      parsedSchema.value === null ||
      typeof parsedSchema.value !== "object" ||
      Array.isArray(parsedSchema.value)
    ) {
      return [];
    }
    return detectInterfaceGraphDrift(
      {
        input_schema: parsedSchema.value,
        outputs: declaredOutputEntries
          .filter(([, entry]) => entry.enabled)
          .map(([key]) => ({ key })),
      },
      contract,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.mode, parsedSchema, draft.outputs, contract]);

  // Atlas measures the byte cap on the *whole* canonical interface document, not input_schema
  // alone — build the same document the save would send and measure that.
  const interfaceBytes = useMemo(() => {
    const built = buildInterfacePayload(draft, false);
    return built.ok && built.interface ? estimateCanonicalBytes(built.interface) : 0;
  }, [draft]);
  const sampleBytes = useMemo(
    () => (parsedSample.ok ? estimateCanonicalBytes(parsedSample.value) : 0),
    [parsedSample],
  );

  if (draft.mode === "unsupported") {
    return (
      <div className="space-y-4 px-4 py-6" data-testid="interface-panel-unsupported">
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
          <p className="text-xs font-semibold text-foreground">
            Application interface — unsupported schema_version {draft.unsupportedVersion}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            This workflow declares an interface in a format newer than this build of Flow Designer
            understands (only{" "}
            <span className="font-mono">schema_version {INTERFACE_SCHEMA_VERSION}</span> is editable
            here). It is shown read-only and is never re-sent by a save from this editor, so it
            cannot be silently dropped or reinterpreted.
          </p>
        </div>
        <div>
          <Label>input_schema (read-only)</Label>
          <Textarea
            readOnly
            value={draft.inputSchemaText}
            className="mt-1 min-h-40 font-mono text-xs"
          />
        </div>
        <div>
          <Label>sample_input (read-only)</Label>
          <Textarea
            readOnly
            value={draft.sampleInputText}
            className="mt-1 min-h-24 font-mono text-xs"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 px-4 py-6" data-testid="interface-panel">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-[10px] uppercase tracking-widest text-primary">
          Application interface
        </h3>
        {draft.mode === "editing" ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="interface-clear"
            onClick={() =>
              onChange({
                mode: "none",
                inputSchemaText: EMPTY_SCHEMA_TEXT,
                sampleInputText: EMPTY_SAMPLE_TEXT,
                outputs: {},
                primaryOutput: "",
              })
            }
          >
            Clear
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="interface-add"
            onClick={() =>
              onChange({
                mode: "editing",
                inputSchemaText: EMPTY_SCHEMA_TEXT,
                sampleInputText: EMPTY_SAMPLE_TEXT,
                outputs: {},
                primaryOutput: "",
              })
            }
          >
            Add interface
          </Button>
        )}
      </div>

      {draft.mode === "none" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          No authoritative interface is declared. Test Run and any integration guide fall back to
          the observed contract (inferred from prompt text), labelled{" "}
          <span className="font-mono">Observed · not enforced by Atlas</span>.
        </p>
      ) : (
        <>
          <div>
            <Label htmlFor="interface-input-schema">input_schema</Label>
            <Textarea
              id="interface-input-schema"
              data-testid="interface-input-schema"
              spellCheck={false}
              className="mt-1 min-h-48 font-mono text-xs"
              value={draft.inputSchemaText}
              onChange={(event) => onChange({ ...draft, inputSchemaText: event.target.value })}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Bounded profile: types object/array/string/number/integer/boolean/null,
              properties/required/additionalProperties/items/enum/const, min/max keywords,
              title/description/default/examples. Optional{" "}
              <span className="font-mono">$schema</span> must equal{" "}
              <span className="font-mono">{INPUT_SCHEMA_URI}</span> exactly. Root must be exactly{" "}
              <span className="font-mono">{`type: "object"`}</span> (or{" "}
              <span className="font-mono">{`["object"]`}</span>) — a nullable or mixed union such as{" "}
              <span className="font-mono">{`["object","null"]`}</span> is rejected.{" "}
              {bytesLabel(interfaceBytes, INTERFACE_MAX_BYTES)}.
            </p>
            <DiagnosticList diagnostics={schemaDiagnostics} />
          </div>

          <div>
            <Label htmlFor="interface-sample-input">sample_input</Label>
            <Textarea
              id="interface-sample-input"
              data-testid="interface-sample-input"
              spellCheck={false}
              className="mt-1 min-h-32 font-mono text-xs"
              value={draft.sampleInputText}
              onChange={(event) => onChange({ ...draft, sampleInputText: event.target.value })}
            />
            <p
              role="note"
              className="mt-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-foreground"
            >
              <strong>Synthetic data only.</strong> This value is persisted on the workflow and can
              be exported in a pack. Never enter a real name, national ID, contact detail,
              credential, API key, or other secret. {bytesLabel(sampleBytes, SAMPLE_MAX_BYTES)}.
            </p>
            <DiagnosticList diagnostics={sampleDiagnostics} />
          </div>

          <div>
            <h4 className="mb-1 text-xs font-semibold">Public outputs</h4>
            <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
              Only worker output keys produced by exactly one node in this graph can be declared —
              Atlas requires that uniqueness. A key produced by more than one node cannot be newly
              declared until the graph makes it unique, but an already-declared one can still be
              un-declared here.
            </p>
            {candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No worker node declares an output key.
              </p>
            ) : (
              <div className="space-y-2" data-testid="interface-output-table">
                {candidates.map((candidate) => {
                  const entry = draft.outputs[candidate.key];
                  const enabled = entry?.enabled ?? false;
                  return (
                    <div
                      key={candidate.key}
                      className="rounded-md border border-border px-2.5 py-2"
                      data-testid={`interface-output-${candidate.key}`}
                    >
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={enabled}
                          // An ambiguous key cannot be newly declared, but one that is already
                          // enabled must stay uncheckable — otherwise the only way out of the
                          // guaranteed Atlas 400 is editing the graph or clearing everything.
                          disabled={!candidate.unique && !enabled}
                          onChange={(event) =>
                            onChange({
                              ...draft,
                              outputs: {
                                ...draft.outputs,
                                // Key order matches `outputsToDraft` exactly — the editor's
                                // dirty/unchanged checks compare serialized drafts, so a
                                // toggle-off-and-on must round-trip to identical bytes.
                                [candidate.key]: {
                                  enabled: event.target.checked,
                                  // `kind` always tracks the graph, never a stale saved value.
                                  kind: candidate.kind,
                                  title: entry?.title ?? "",
                                  description: entry?.description ?? "",
                                },
                              },
                              ...(event.target.checked || draft.primaryOutput !== candidate.key
                                ? {}
                                : { primaryOutput: "" }),
                            })
                          }
                        />
                        <span className="font-mono text-[11px] text-primary">{candidate.key}</span>
                        <span className="text-muted-foreground">
                          — produced by {candidate.nodeIds.join(", ")}, kind {candidate.kind}
                          {!candidate.unique
                            ? " — ambiguous (more than one node produces this key); Atlas rejects it while declared"
                            : ""}
                        </span>
                      </label>
                      {enabled ? (
                        <div className="mt-2 grid gap-2 pl-6 sm:grid-cols-2">
                          <Input
                            aria-label={`${candidate.key} title`}
                            placeholder="Title (optional)"
                            value={entry?.title ?? ""}
                            onChange={(event) =>
                              onChange({
                                ...draft,
                                outputs: {
                                  ...draft.outputs,
                                  [candidate.key]: {
                                    enabled: true,
                                    kind: candidate.kind,
                                    title: event.target.value,
                                    description: entry?.description ?? "",
                                  },
                                },
                              })
                            }
                          />
                          <Input
                            aria-label={`${candidate.key} description`}
                            placeholder="Description (optional)"
                            value={entry?.description ?? ""}
                            onChange={(event) =>
                              onChange({
                                ...draft,
                                outputs: {
                                  ...draft.outputs,
                                  [candidate.key]: {
                                    enabled: true,
                                    kind: candidate.kind,
                                    title: entry?.title ?? "",
                                    description: event.target.value,
                                  },
                                },
                              })
                            }
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            {orphanedDeclared.filter(([, entry]) => entry.enabled).length > 0 ? (
              <div className="mt-2 space-y-1" data-testid="interface-orphaned-outputs">
                {orphanedDeclared
                  .filter(([, entry]) => entry.enabled)
                  .map(([key]) => (
                    <p
                      key={key}
                      className="flex items-center gap-2 text-[11px] leading-snug text-warning"
                    >
                      <span>
                        <span className="font-mono">{key}</span> is declared but no longer produced
                        by any worker in this graph; Atlas will reject a save with it still
                        declared.
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`interface-remove-orphan-${key}`}
                        onClick={() => {
                          const { [key]: _removed, ...rest } = draft.outputs;
                          onChange({
                            ...draft,
                            outputs: rest,
                            primaryOutput: draft.primaryOutput === key ? "" : draft.primaryOutput,
                          });
                        }}
                      >
                        Remove
                      </Button>
                    </p>
                  ))}
              </div>
            ) : null}
            <DiagnosticList diagnostics={outputDiagnostics} />
          </div>

          <div>
            <Label htmlFor="interface-primary-output">primary_output</Label>
            <select
              id="interface-primary-output"
              data-testid="interface-primary-output"
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
              value={draft.primaryOutput}
              onChange={(event) => onChange({ ...draft, primaryOutput: event.target.value })}
            >
              <option value="">None</option>
              {declaredOutputEntries
                .filter(([, entry]) => entry.enabled)
                .map(([key]) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              A client hint only — Atlas does not require this output to exist on every run.
            </p>
          </div>

          {drift.length > 0 ? (
            <div
              role="status"
              data-testid="interface-drift"
              className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
            >
              <p className="mb-1 font-semibold">
                Declared interface and observed prompt usage disagree:
              </p>
              <ul className="space-y-1">
                {drift.map((finding, index) => (
                  <li key={`${finding.kind}:${index}`} className="text-muted-foreground">
                    {finding.message}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-muted-foreground">
                Neither source is changed automatically. Atlas's own save-time check is the boundary
                that actually enforces this.
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
