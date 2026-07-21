/**
 * The inspectors: one for a node, one for an edge, one for the workflow policy.
 *
 * Every field here maps to a field Atlas's schema declares. That is the whole design rule —
 * the scaffold this replaces had inputs for an expression evaluator, per-gate approvers, a
 * gate timeout, a loop collection, and a fan-out branch count, none of which exist anywhere in
 * Atlas. A field with no Atlas counterpart is worse than a missing feature: an operator fills
 * it in, saves successfully, and believes something is configured.
 *
 * Conditions live in the *edge* inspector because that is where Atlas keeps them. There is no
 * true/false port pair to look for: a two-way branch is two edges with two conditions, and if
 * no outgoing condition matches, Atlas schedules nothing.
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  CONDITION_TYPES,
  EXECUTION_MODES,
  IDENTIFIER_PATTERN,
  JOIN_MODES,
  POLICY_LIMITS,
  describeCondition,
  edgeIsInCycle,
  hasLoopGuard,
  isIdentifier,
  type ConditionType,
  type GraphCondition,
  type GraphEdge,
  type GraphNode,
  type HumanGateNode,
  type JsonValue,
  type WorkflowGraph,
  type WorkflowPolicy,
} from "@/lib/workflow-graph";
import { NODE_PRESENTATION } from "./workflow-node-presentation";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <h3 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/**
 * A labelled control.
 *
 * The label *wraps* its control rather than sitting beside it. A `<label>` with neither `for`
 * nor a nested control is not associated with anything: a screen reader announces an unlabelled
 * text box, and clicking the caption does not focus the field. Wrapping is the version that
 * needs no generated id to keep in sync.
 */
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="block space-y-1.5 text-xs font-medium text-foreground">
        <span className="block">{label}</span>
        {children}
      </Label>
      {/* role="alert" announces the refusal when it appears; the field itself already flags
          aria-invalid. */}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {!error && hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** A plain select styled like the rest of the inspector, without a portal to fight the canvas. */
function Choose<T extends string>({
  value,
  options,
  onChange,
  id,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Comma-separated text ↔ string array, for the two Atlas fields that are lists of short ids. */
function listToText(value: string[] | undefined): string {
  return (value ?? []).join(", ");
}

function textToList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export interface NodeInspectorProps {
  node: GraphNode;
  graph: WorkflowGraph;
  issues: string[];
  onChange: (next: GraphNode) => void;
  onRename: (nextId: string) => { ok: boolean; reason?: string };
  onSetStart: () => void;
  onDelete: () => void;
  deleteDisabled?: boolean;
}

export function NodeInspector({
  node,
  graph,
  issues,
  onChange,
  onRename,
  onSetStart,
  onDelete,
  deleteDisabled = false,
}: NodeInspectorProps) {
  const presentation = NODE_PRESENTATION[node.type];
  const [draftId, setDraftId] = useState(node.id);
  const [renameError, setRenameError] = useState<string | undefined>(undefined);

  // The draft follows the selection: selecting a different node must not leave the previous
  // node's id sitting in the field, where the next blur would try to apply it.
  const [lastNodeId, setLastNodeId] = useState(node.id);
  if (lastNodeId !== node.id) {
    setLastNodeId(node.id);
    setDraftId(node.id);
    setRenameError(undefined);
  }

  const commitRename = () => {
    if (draftId === node.id) {
      setRenameError(undefined);
      return;
    }
    const result = onRename(draftId);
    if (result.ok) {
      setRenameError(undefined);
    } else {
      setRenameError(result.reason);
      setDraftId(node.id);
    }
  };

  const isAgent = node.type === "worker" || node.type === "manager";

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Section title={`${presentation.label} node`}>
        <Field
          label="Node id"
          hint="Referenced by edges, by the start field, and by loop guards. Renaming updates all of them at once."
          error={renameError}
        >
          <Input
            value={draftId}
            spellCheck={false}
            aria-invalid={renameError !== undefined || !isIdentifier(draftId)}
            onChange={(event) => setDraftId(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraftId(node.id);
                setRenameError(undefined);
              }
            }}
            className="font-mono text-xs"
          />
          {!isIdentifier(draftId) ? (
            <p className="text-[11px] text-muted-foreground">
              Must match <code className="font-mono">{IDENTIFIER_PATTERN.source}</code>
            </p>
          ) : null}
        </Field>

        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
          <div>
            <p className="text-xs font-medium text-foreground">Start node</p>
            <p className="text-[11px] text-muted-foreground">
              {graph.start === node.id
                ? "Runs begin here."
                : "Atlas begins every run at graph.start."}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant={graph.start === node.id ? "secondary" : "outline"}
            disabled={graph.start === node.id}
            onClick={onSetStart}
          >
            {graph.start === node.id ? "Current" : "Make start"}
          </Button>
        </div>
      </Section>

      {issues.length > 0 ? (
        <Section title="Problems">
          <ul className="space-y-1.5">
            {issues.map((issue, index) => (
              <li key={`${index}:${issue}`} className="text-xs text-destructive">
                {issue}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {isAgent ? (
        <Section title="Prompt and routing">
          <Field
            label="Prompt"
            hint="Atlas substitutes {input.x}, {artifact.key}, {run.x}, {node.x}, and {job.x}."
          >
            <Textarea
              value={node.prompt ?? ""}
              rows={5}
              onChange={(event) => onChange({ ...node, prompt: event.target.value })}
              className="font-mono text-xs"
            />
          </Field>

          {node.type === "manager" ? (
            <p className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
              A manager always declares{" "}
              <code className="font-mono">schema: manager_decision_v1</code> — Atlas requires it,
              and every edge leaving this node must use the <code>manager_selected</code> condition
              naming that edge&apos;s own target.
            </p>
          ) : null}

          <Field
            label="Worker id"
            hint="Optional. Atlas checks this against its own worker table when you validate."
          >
            <Input
              value={node.worker_id ?? ""}
              spellCheck={false}
              onChange={(event) =>
                onChange({ ...node, worker_id: event.target.value || undefined })
              }
              className="font-mono text-xs"
            />
          </Field>

          <Field label="Workspace id" hint="Optional. Must belong to the worker above.">
            <Input
              value={node.workspace_id ?? ""}
              spellCheck={false}
              onChange={(event) =>
                onChange({ ...node, workspace_id: event.target.value || undefined })
              }
              className="font-mono text-xs"
            />
          </Field>

          <Field label="Role" hint="Routes to any worker with this role or tag when no id is set.">
            <Input
              value={node.role ?? ""}
              onChange={(event) => onChange({ ...node, role: event.target.value || undefined })}
              className="text-xs"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Model">
              <Input
                value={node.model ?? ""}
                onChange={(event) => onChange({ ...node, model: event.target.value || undefined })}
                className="text-xs"
              />
            </Field>
            <Field label="Company">
              <Input
                value={node.company ?? ""}
                onChange={(event) =>
                  onChange({ ...node, company: event.target.value || undefined })
                }
                className="text-xs"
              />
            </Field>
          </div>

          <Field label="Tags" hint="Comma separated.">
            <Input
              value={listToText(node.tags)}
              onChange={(event) => {
                const tags = textToList(event.target.value);
                onChange({ ...node, tags: tags.length > 0 ? tags : undefined });
              }}
              className="text-xs"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Execution">
              <Choose
                value={node.execution ?? "stream"}
                options={EXECUTION_MODES.map((mode) => ({ value: mode, label: mode }))}
                onChange={(execution) => onChange({ ...node, execution })}
              />
            </Field>
            <Field label="Budget units" hint="Whole number, 1 or more.">
              <Input
                inputMode="numeric"
                value={node.budget_units === undefined ? "" : String(node.budget_units)}
                onChange={(event) =>
                  onChange({ ...node, budget_units: optionalNumber(event.target.value) })
                }
                className="text-xs"
              />
            </Field>
          </div>

          {node.type === "worker" ? (
            <>
              <Field
                label="Output artifact key"
                hint="A worker produces exactly one artifact. Other nodes reference it by this key."
              >
                <Input
                  value={node.outputs?.[0] ?? ""}
                  spellCheck={false}
                  onChange={(event) => {
                    const key = event.target.value.trim();
                    onChange({ ...node, outputs: key === "" ? undefined : [key] });
                  }}
                  className="font-mono text-xs"
                />
              </Field>
              {/*
                A separate control, never a side effect of setting the key. Atlas acts on this
                flag: `atlas/workflows.py:1669` does an unguarded `json.loads` of the worker's
                reply when it is `json`, so flipping it on behind the user's back turns a worker
                that answers in prose into a run-time failure they were never warned about.
              */}
              <Field
                label="Output format"
                hint="Atlas parses the worker's reply as JSON when this is json, and stores it as text otherwise."
              >
                <Choose
                  value={node.output_format ?? "text"}
                  options={[
                    { value: "text" as const, label: "text" },
                    { value: "json" as const, label: "json" },
                  ]}
                  onChange={(format) =>
                    onChange({ ...node, output_format: format === "json" ? "json" : undefined })
                  }
                />
              </Field>
            </>
          ) : null}

          <Field
            label="Collect files"
            hint="Comma-separated relative glob patterns collected after the job. No absolute paths, no '..'."
          >
            <Input
              value={listToText(node.collect_files)}
              spellCheck={false}
              onChange={(event) => {
                const files = textToList(event.target.value);
                onChange({ ...node, collect_files: files.length > 0 ? files : undefined });
              }}
              className="font-mono text-xs"
            />
          </Field>
        </Section>
      ) : null}

      {node.type === "join" ? (
        <Section title="Wait for branches">
          <Field
            label="Mode"
            hint="all waits for every upstream branch; any continues on the first; quorum waits for a count."
          >
            <Choose
              value={node.mode}
              options={JOIN_MODES.map((mode) => ({
                value: mode,
                label:
                  mode === "all"
                    ? "All branches"
                    : mode === "any"
                      ? "Any branch"
                      : "A set number of branches",
              }))}
              onChange={(mode) =>
                onChange(
                  mode === "quorum"
                    ? { ...node, mode, quorum: node.quorum ?? 1 }
                    : { id: node.id, type: "join", mode },
                )
              }
            />
          </Field>
          {node.mode === "quorum" ? (
            <Field
              label="Quorum"
              hint={`Whole number, at least 1, at most the ${
                new Set(graph.edges.filter((e) => e.to === node.id).map((e) => e.from)).size
              } distinct upstream node(s) feeding this join.`}
            >
              <Input
                inputMode="numeric"
                value={node.quorum === undefined ? "" : String(node.quorum)}
                onChange={(event) =>
                  onChange({ ...node, quorum: optionalNumber(event.target.value) ?? 1 })
                }
                className="text-xs"
              />
            </Field>
          ) : null}
        </Section>
      ) : null}

      {node.type === "human_gate" ? <HumanGateFields node={node} onChange={onChange} /> : null}

      <Section title="Danger">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="w-full"
          disabled={deleteDisabled}
          title={
            deleteDisabled
              ? "Choose a different start node before deleting this one."
              : "Delete this node and its related edges."
          }
          onClick={onDelete}
        >
          Delete node
        </Button>
        <p className="text-[11px] text-muted-foreground">
          {deleteDisabled
            ? "This is the start node. Make another node the start before deleting it."
            : "Every touching edge, and any loop guard that counts this node, is removed with it."}
        </p>
      </Section>
    </div>
  );
}

function HumanGateFields({
  node,
  onChange,
}: {
  node: HumanGateNode;
  onChange: (next: GraphNode) => void;
}) {
  const choices = node.choices ?? [];
  const sectionTitle = choices.length > 0 ? "Ask for a choice" : "Request approval";

  return (
    <Section title={sectionTitle}>
      <Field label="Label" hint="What the person deciding sees.">
        <Input
          value={node.label ?? ""}
          onChange={(event) => onChange({ ...node, label: event.target.value || undefined })}
          className="text-xs"
        />
      </Field>
      <Field label="Reason" hint="Why the run is pausing here.">
        <Textarea
          value={node.reason ?? ""}
          rows={3}
          onChange={(event) => onChange({ ...node, reason: event.target.value || undefined })}
          className="text-xs"
        />
      </Field>

      {/*
        Atlas has no per-gate approver and no gate timeout. Anyone holding `approvals.decide`
        can decide any pending approval, and a gate waits indefinitely. The scaffold offered
        fields for both; saying so plainly is better than a field that quietly does nothing.
      */}
      <p className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
        Atlas has no per-gate approver list and no gate timeout. Anyone with the
        <code className="mx-1 font-mono">approvals.decide</code> permission can decide this, and the
        run waits until someone does. The only time bound is the policy&apos;s{" "}
        <code className="font-mono">max_minutes</code>.
      </p>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium text-foreground">Choices</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              onChange({
                ...node,
                choices: [...choices, { id: `choice_${choices.length + 1}`, label: "New choice" }],
              })
            }
          >
            Add choice
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          With choices, every outgoing edge must carry a <code>human_selected</code> condition
          naming one of them. With none, the gate is a plain approve or reject.
        </p>
        {choices.map((choice, index) => (
          <div key={index} className="flex gap-2">
            <Input
              value={choice.id}
              spellCheck={false}
              aria-label={`Choice ${index + 1} id`}
              onChange={(event) => {
                const next = [...choices];
                next[index] = { ...choice, id: event.target.value };
                onChange({ ...node, choices: next });
              }}
              className="font-mono text-xs"
            />
            <Input
              value={choice.label}
              aria-label={`Choice ${index + 1} label`}
              onChange={(event) => {
                const next = [...choices];
                next[index] = { ...choice, label: event.target.value };
                onChange({ ...node, choices: next });
              }}
              className="text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Remove choice ${index + 1}`}
              onClick={() => {
                const next = choices.filter((_, i) => i !== index);
                onChange({ ...node, choices: next.length > 0 ? next : undefined });
              }}
            >
              ×
            </Button>
          </div>
        ))}
      </div>
    </Section>
  );
}

const CONDITION_LABELS: Record<ConditionType, string> = {
  always: "Always",
  artifact_equals: "Artifact equals a value",
  artifact_in: "Artifact is one of",
  manager_selected: "Manager selected this path",
  human_selected: "Person chose this option",
  max_iterations_below: "Node has run fewer than N times",
};

/**
 * The condition types this edge may legally use, given what its source node is.
 *
 * Atlas enforces the constraint in both directions: an edge leaving a manager *must* be
 * `manager_selected` and nothing else may be, and a gate that declares choices routes only by
 * `human_selected`. Offering the illegal options and rejecting them afterwards would be a worse
 * version of the same rule.
 */
function allowedConditions(
  source: GraphNode | undefined,
  sourceHasChoices: boolean,
): ConditionType[] {
  if (source?.type === "manager") return ["manager_selected"];
  if (source?.type === "human_gate" && sourceHasChoices) return ["human_selected"];
  return CONDITION_TYPES.filter((type) => type !== "manager_selected" && type !== "human_selected");
}

/** A fresh condition of the requested type, seeded so it is valid the moment it is chosen. */
function defaultCondition(
  type: ConditionType,
  edge: GraphEdge,
  source: GraphNode | undefined,
): GraphCondition {
  switch (type) {
    case "always":
      return { type: "always" };
    case "artifact_equals":
      return { type: "artifact_equals", artifact: "", value: "" };
    case "artifact_in":
      return { type: "artifact_in", artifact: "", values: [""] };
    case "manager_selected":
      // Atlas requires the target to be the edge's own target, so there is nothing to choose.
      return { type: "manager_selected", target: edge.to };
    case "human_selected":
      return {
        type: "human_selected",
        choice: source?.type === "human_gate" ? (source.choices?.[0]?.id ?? "") : "",
      };
    case "max_iterations_below":
      return { type: "max_iterations_below", node: edge.from, max: 3 };
  }
}

function parseJsonish(raw: string): JsonValue {
  // Atlas compares an artifact value structurally, so `true`, `3`, and `"ready"` are different
  // comparisons. Accepting JSON when it parses and a plain string otherwise lets an operator
  // write the common case without quotes and the exact case with them.
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

export interface EdgeInspectorProps {
  edge: GraphEdge;
  edgeIndex: number;
  graph: WorkflowGraph;
  policy: WorkflowPolicy;
  issues: string[];
  onChange: (next: GraphEdge) => void;
  onDelete: () => void;
}

export function EdgeInspector({
  edge,
  edgeIndex,
  graph,
  policy,
  issues,
  onChange,
  onDelete,
}: EdgeInspectorProps) {
  const source = graph.nodes.find((node) => node.id === edge.from);
  const sourceChoices = source?.type === "human_gate" ? (source.choices ?? []) : [];
  const allowed = allowedConditions(source, sourceChoices.length > 0);
  const condition = edge.condition;
  const needsLoopGuard = edgeIsInCycle(graph, edgeIndex) && !hasLoopGuard(graph, policy);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Section title="Edge">
        <p className="font-mono text-xs text-foreground">
          {edge.from} <span className="text-muted-foreground">→</span> {edge.to}
        </p>
        <p className="text-[11px] text-muted-foreground">
          Shown on the canvas as{" "}
          <span className="font-mono text-foreground">{describeCondition(condition)}</span>. That
          caption is derived from the condition and stored nowhere — Atlas edges have no label.
        </p>
      </Section>

      {issues.length > 0 ? (
        <Section title="Problems">
          <ul className="space-y-1.5">
            {issues.map((issue, index) => (
              <li key={`${index}:${issue}`} className="text-xs text-destructive">
                {issue}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {needsLoopGuard ? (
        <Section title="Loop guard required">
          <p role="alert" className="text-xs leading-relaxed text-warning">
            This connection closes a cycle. Atlas will reject it until you either set{" "}
            <code className="font-mono">policy.max_iterations</code> or change this edge&apos;s
            condition to <code className="font-mono">max_iterations_below</code>.
          </p>
        </Section>
      ) : null}

      <Section title="Condition">
        <Field
          label="Type"
          hint={
            source?.type === "manager"
              ? "An edge from a manager can only be manager_selected."
              : sourceChoices.length > 0
                ? "An edge from a gate with choices can only be human_selected."
                : "Atlas schedules every outgoing edge whose condition matches. If none matches, nothing runs."
          }
        >
          <Choose
            value={condition.type}
            options={allowed.map((type) => ({ value: type, label: CONDITION_LABELS[type] }))}
            onChange={(type) =>
              onChange({ ...edge, condition: defaultCondition(type, edge, source) })
            }
          />
        </Field>

        {condition.type === "artifact_equals" || condition.type === "artifact_in" ? (
          <>
            <Field label="Artifact key" hint="The output key of an upstream worker node.">
              <Input
                value={condition.artifact}
                spellCheck={false}
                onChange={(event) =>
                  onChange({ ...edge, condition: { ...condition, artifact: event.target.value } })
                }
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Path" hint="Optional. A dotted path inside the artifact's JSON.">
              <Input
                value={condition.path ?? ""}
                spellCheck={false}
                onChange={(event) =>
                  onChange({
                    ...edge,
                    condition: { ...condition, path: event.target.value || undefined },
                  })
                }
                className="font-mono text-xs"
              />
            </Field>
          </>
        ) : null}

        {condition.type === "artifact_equals" ? (
          <Field label="Equals" hint="Written as JSON when it parses, otherwise as plain text.">
            <Input
              value={
                typeof condition.value === "string"
                  ? condition.value
                  : JSON.stringify(condition.value)
              }
              onChange={(event) =>
                onChange({
                  ...edge,
                  condition: { ...condition, value: parseJsonish(event.target.value) },
                })
              }
              className="font-mono text-xs"
            />
          </Field>
        ) : null}

        {condition.type === "artifact_in" ? (
          <Field
            label="One of"
            hint="One value per line, each read as JSON when it parses. Lines rather than commas, so a value containing a comma survives a round trip."
          >
            <Textarea
              rows={4}
              value={condition.values
                .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
                .join("\n")}
              onChange={(event) =>
                onChange({
                  ...edge,
                  condition: {
                    ...condition,
                    values: event.target.value
                      .split("\n")
                      .map((line) => line.trim())
                      .filter((line) => line.length > 0)
                      .map(parseJsonish),
                  },
                })
              }
              className="font-mono text-xs"
            />
          </Field>
        ) : null}

        {condition.type === "manager_selected" ? (
          <p className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
            The target is always this edge&apos;s own target,{" "}
            <span className="font-mono text-foreground">{edge.to}</span>. Atlas rejects any other
            value, so it follows the edge automatically.
          </p>
        ) : null}

        {condition.type === "human_selected" ? (
          <Field label="Choice" hint="Must be one the source gate declares.">
            {sourceChoices.length > 0 ? (
              <Choose
                value={condition.choice}
                options={sourceChoices.map((choice) => ({
                  value: choice.id,
                  label: `${choice.label} (${choice.id})`,
                }))}
                onChange={(choice) => onChange({ ...edge, condition: { ...condition, choice } })}
              />
            ) : (
              <p className="text-xs text-destructive">
                The source gate declares no choices. Add one there first.
              </p>
            )}
          </Field>
        ) : null}

        {condition.type === "max_iterations_below" ? (
          <>
            <Field
              label="Counted node"
              hint="The edge is taken only while this node has run fewer than the limit."
            >
              <Choose
                value={condition.node}
                options={graph.nodes.map((node) => ({ value: node.id, label: node.id }))}
                onChange={(node) => onChange({ ...edge, condition: { ...condition, node } })}
              />
            </Field>
            <Field label="Maximum runs" hint="Whole number, at least 1.">
              <Input
                inputMode="numeric"
                value={String(condition.max)}
                onChange={(event) =>
                  onChange({
                    ...edge,
                    condition: { ...condition, max: optionalNumber(event.target.value) ?? 1 },
                  })
                }
                className="text-xs"
              />
            </Field>
          </>
        ) : null}
      </Section>

      <Section title="File handoff">
        <Field
          label="Push files"
          hint={
            policy.file_handoff === true
              ? "Comma-separated artifact-key globs copied into the target worker before its job."
              : "Enable file_handoff in workflow settings before configuring files for this edge."
          }
        >
          <Input
            value={listToText(edge.push_files)}
            spellCheck={false}
            disabled={policy.file_handoff !== true}
            onChange={(event) => {
              const files = textToList(event.target.value);
              onChange({ ...edge, push_files: files.length > 0 ? files : undefined });
            }}
            className="font-mono text-xs"
          />
        </Field>
        {(edge.push_files?.length ?? 0) > 0 && policy.file_handoff !== true ? (
          <p className="text-xs text-destructive">
            Atlas rejects this unless <code className="font-mono">file_handoff</code> is on in the
            policy.
          </p>
        ) : null}
      </Section>

      <Section title="Danger">
        <Button type="button" variant="destructive" size="sm" className="w-full" onClick={onDelete}>
          Delete edge
        </Button>
      </Section>
    </div>
  );
}

export interface PolicyPanelProps {
  policy: WorkflowPolicy;
  issues: string[];
  onChange: (next: WorkflowPolicy) => void;
}

const POLICY_HINTS: Record<string, string> = {
  max_jobs: "Total jobs a single run may create.",
  max_iterations: "Guards a graph cycle. Setting this is one of the two ways to allow a loop.",
  max_attempts_per_node: "Retries Atlas makes for one node before failing it.",
  max_minutes: "Wall-clock budget for the whole run.",
  requires_human_after_iterations: "Pauses for a human once a run has iterated this many times.",
  max_budget_units: "Total budget units the run may consume.",
};

export function PolicyPanel({ policy, issues, onChange }: PolicyPanelProps) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {issues.length > 0 ? (
        <Section title="Problems">
          <ul className="space-y-1.5">
            {issues.map((issue, index) => (
              <li key={`${index}:${issue}`} className="text-xs text-destructive">
                {issue}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Limits">
        <p className="text-[11px] text-muted-foreground">
          Every limit is optional; leaving one blank means Atlas applies its own default. Each is a
          whole number within the range Atlas enforces.
        </p>
        {Object.entries(POLICY_LIMITS).map(([key, maximum]) => (
          <Field key={key} label={key} hint={`${POLICY_HINTS[key] ?? ""} 1 to ${maximum}.`}>
            <Input
              inputMode="numeric"
              value={
                (policy as Record<string, unknown>)[key] === undefined
                  ? ""
                  : String((policy as Record<string, unknown>)[key])
              }
              onChange={(event) =>
                onChange({ ...policy, [key]: optionalNumber(event.target.value) })
              }
              className="text-xs"
            />
          </Field>
        ))}
      </Section>

      <Section title="Switches">
        <div className="flex items-center justify-between">
          <div className="pr-3">
            <p className="text-xs font-medium text-foreground">stop_on_first_failure</p>
            <p className="text-[11px] text-muted-foreground">
              Ends the whole run as soon as any node fails.
            </p>
          </div>
          {/*
            `checked` is stored as-is rather than collapsed to undefined when false: Atlas
            persists an explicit `false`, so dropping the key would rewrite a stored policy on a
            toggle round trip and show the workflow as dirty for no visible reason.
          */}
          <Switch
            checked={policy.stop_on_first_failure === true}
            onCheckedChange={(checked) => onChange({ ...policy, stop_on_first_failure: checked })}
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="pr-3">
            <p className="text-xs font-medium text-foreground">file_handoff</p>
            <p className="text-[11px] text-muted-foreground">
              Required before any edge may push files to the next worker.
            </p>
          </div>
          <Switch
            checked={policy.file_handoff === true}
            onCheckedChange={(checked) =>
              onChange({ ...policy, file_handoff: checked || undefined })
            }
          />
        </div>
      </Section>

      <Section title="Allow lists">
        <p className="text-[11px] text-muted-foreground">
          Comma-separated Atlas ids. When set, every node must resolve inside them — Atlas checks
          that when you validate against the server.
        </p>
        <Field label="allowed_worker_ids">
          <Input
            value={listToText(policy.allowed_worker_ids)}
            spellCheck={false}
            onChange={(event) => {
              const ids = textToList(event.target.value);
              onChange({ ...policy, allowed_worker_ids: ids.length > 0 ? ids : undefined });
            }}
            className="font-mono text-xs"
          />
        </Field>
        <Field label="allowed_workspace_ids">
          <Input
            value={listToText(policy.allowed_workspace_ids)}
            spellCheck={false}
            onChange={(event) => {
              const ids = textToList(event.target.value);
              onChange({ ...policy, allowed_workspace_ids: ids.length > 0 ? ids : undefined });
            }}
            className="font-mono text-xs"
          />
        </Field>
      </Section>
    </div>
  );
}
