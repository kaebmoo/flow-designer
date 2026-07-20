/**
 * The Atlas semantic workflow graph: types, parser, serializer, validator, and rename.
 *
 * Pure and client-safe — no `*.server.ts` import, no React, no network. The editor, the
 * server-side mappers, and the tests all speak this one model, so there is exactly one place
 * that decides what Atlas will accept.
 *
 * Ground truth, read at Atlas `595ef62`:
 *  - `atlas/workflows.py` `validate_workflow_graph` (line 149) — what the server enforces
 *  - `atlas/workflows.py` `_validate_edge` / `_validate_condition` (line 1899)
 *  - `atlas/workflows.py` `validate_workflow_policy` (line 273) + `WORKFLOW_POLICY_LIMITS`
 *  - `docs/specs/workflow-definition.schema.json` — the stricter published schema
 *
 * Where the two disagree the schema is stricter, and this module follows the schema: Atlas's
 * runtime validator would accept a payload the published contract rejects, and writing one is
 * how a client ends up depending on an accident.
 *
 * Two rules are absolute:
 *
 *  1. **Fail closed.** An unknown node type, an unknown condition type, or an unknown field
 *     makes `parseWorkflowGraph` return a failure. The UI must refuse to edit such a graph
 *     rather than silently drop what it did not understand and PUT the remainder back.
 *  2. **No UI state crosses this boundary.** React Flow positions, viewport, selection, and
 *     colours are not in these types at all, so there is no way to leak one into a payload.
 */

/**
 * Anything that survives `JSON.parse(JSON.stringify(x))`.
 *
 * Used instead of `unknown` for the values Atlas stores opaquely — an `artifact_equals`
 * comparison value, an `artifact_in` list, a trigger config. `unknown` is honest about what we
 * know but wrong about what can travel: TanStack Start type-checks server-function results for
 * serialisability and rejects `unknown`, and rightly so — a `Date` or a `Map` in one of these
 * fields would arrive in the browser as something else entirely.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object, for the places Atlas accepts an open map. */
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The only four node types Atlas's executor accepts (`atlas/workflows.py:173`). */
export const NODE_KINDS = ["worker", "manager", "join", "human_gate"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** The closed condition set (`atlas/workflows.py:1920-1952`). */
export const CONDITION_TYPES = [
  "always",
  "artifact_equals",
  "artifact_in",
  "manager_selected",
  "human_selected",
  "max_iterations_below",
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

/** `atlas/workflows.py:179`. */
export const JOIN_MODES = ["all", "any", "quorum"] as const;
export type JoinMode = (typeof JOIN_MODES)[number];

/** `atlas/jobs.py:35`. */
export const EXECUTION_MODES = ["stream", "callback"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** Required const on every manager node (`atlas/workflows.py:58,175`). */
export const MANAGER_SCHEMA = "manager_decision_v1";

/**
 * Node ids and artifact keys share one shape.
 *
 * The schema pins artifact keys to this pattern (`$defs/artifactKey`) and Atlas's runtime
 * validator only requires a non-empty node id. The editor applies the stricter pattern to both:
 * a node id containing a `.` or a space is legal in Atlas today but is referenced by name from
 * `manager_selected.target` and `max_iterations_below.node`, and prompt templates address
 * artifacts as `{artifact.key}` — an identifier is the only shape that survives all of them.
 */
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Semantic model
// ---------------------------------------------------------------------------

/** Fields shared by `worker` and `manager` (`workflow-definition.schema.json` `$defs`). */
export interface AgentNodeFields {
  prompt?: string;
  worker_id?: string;
  workspace_id?: string;
  workspace_key?: string;
  company?: string;
  model?: string;
  role?: string;
  tags?: string[];
  budget_units?: number;
  execution?: ExecutionMode;
  collect_files?: string[];
}

export interface WorkerNode extends AgentNodeFields {
  id: string;
  type: "worker";
  /** Exactly one artifact key when present (schema `minItems`/`maxItems` both 1). */
  outputs?: string[];
  output_format?: "json";
}

export interface ManagerNode extends AgentNodeFields {
  id: string;
  type: "manager";
  /** Always `manager_decision_v1`; the serializer emits it unconditionally. */
  schema: typeof MANAGER_SCHEMA;
}

export interface JoinNode {
  id: string;
  type: "join";
  /** Always emitted, even though Atlas's executor would default it to `all`. */
  mode: JoinMode;
  /** Present if and only if `mode === "quorum"`. */
  quorum?: number;
}

export interface HumanGateChoice {
  id: string;
  label: string;
}

export interface HumanGateNode {
  id: string;
  type: "human_gate";
  label?: string;
  reason?: string;
  /** Absent or non-empty; an empty array is rejected by Atlas (`workflows.py:186`). */
  choices?: HumanGateChoice[];
}

export type GraphNode = WorkerNode | ManagerNode | JoinNode | HumanGateNode;

export type GraphCondition =
  | { type: "always" }
  | { type: "artifact_equals"; artifact: string; path?: string; value: JsonValue }
  | { type: "artifact_in"; artifact: string; path?: string; values: JsonValue[] }
  | { type: "manager_selected"; target: string }
  | { type: "human_selected"; choice: string }
  | { type: "max_iterations_below"; node: string; max: number };

export interface GraphEdge {
  from: string;
  to: string;
  /** Never optional in this model: the schema requires it, so the UI always carries one. */
  condition: GraphCondition;
  push_files?: string[];
}

export interface WorkflowGraph {
  start: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** `workflow-definition.schema.json` `$defs/policy`; limits from `WORKFLOW_POLICY_LIMITS`. */
export interface WorkflowPolicy {
  max_jobs?: number;
  max_iterations?: number;
  max_attempts_per_node?: number;
  max_minutes?: number;
  requires_human_after_iterations?: number;
  max_budget_units?: number;
  allowed_worker_ids?: string[];
  allowed_workspace_ids?: string[];
  stop_on_first_failure?: boolean;
  file_handoff?: boolean;
}

/** The integer policy keys and their inclusive maxima (`atlas/workflows.py:263-270`). */
export const POLICY_LIMITS: Record<string, number> = {
  max_jobs: 100,
  max_iterations: 100,
  max_attempts_per_node: 25,
  max_minutes: 1440,
  requires_human_after_iterations: 100,
  max_budget_units: 1_000_000,
};

/**
 * Atlas's own bounds on a node's `collect_files` list.
 *
 * `_validate_collect_files` (`atlas/jobs.py:127-151`) is called at *save* time from
 * `validate_workflow_graph` (`atlas/workflows.py:203-210`), so these are save-blocking rules,
 * not run-time ones. The cap is `artifact_max_files_cap()` (`atlas/jobs.py:54`), which is
 * `ATLAS_ARTIFACT_MAX_FILES` clamped to the upstream maximum — this client cannot read that
 * environment variable, so it checks against the upstream ceiling and lets Atlas apply a
 * stricter local one.
 */
export const COLLECT_FILES_MAX_PATHS = 256;
export const COLLECT_FILES_MAX_PATTERN_LENGTH = 4096;

/** Mirrors `_reject_unsafe_path`: relative, no `..` segment, no control characters. */
export function collectFilesProblem(pattern: string): string | null {
  if (pattern.trim().length === 0) return "Every pattern must be a non-empty string.";
  if (pattern.length > COLLECT_FILES_MAX_PATTERN_LENGTH) {
    return `A pattern may be at most ${COLLECT_FILES_MAX_PATTERN_LENGTH} characters.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pattern)) {
    return "A pattern must not contain control characters.";
  }
  if (pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern)) {
    return "A pattern must be relative to the workspace, not absolute.";
  }
  if (pattern.split(/[\\/]/).includes("..")) {
    return "A pattern must not contain '..'.";
  }
  return null;
}

export const POLICY_BOOLEANS = ["stop_on_first_failure", "file_handoff"] as const;
export const POLICY_ID_LISTS = ["allowed_worker_ids", "allowed_workspace_ids"] as const;

// ---------------------------------------------------------------------------
// Parsing — Atlas JSON to the semantic model, failing closed
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function fail<T>(reason: string): ParseResult<T> {
  return { ok: false, reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Rejects any key Atlas's schema does not declare, which is how unknown fields fail closed. */
function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  where: string,
): ParseResult<string | undefined> {
  const value = raw[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.length === 0) {
    return fail(`${where} ${key} must be a non-empty string`);
  }
  return { ok: true, value };
}

function optionalStringArray(
  raw: Record<string, unknown>,
  key: string,
  where: string,
): ParseResult<string[] | undefined> {
  const value = raw[key];
  if (value === undefined) return { ok: true, value: undefined };
  // Empty entries are rejected rather than carried: Atlas refuses them for `push_files`
  // (`atlas/workflows.py:1908-1913`) and `collect_files` (`atlas/jobs.py:139-140`), and the
  // schema's `nonEmptyString` covers `tags` too. Accepting one here would mean a graph that
  // opens, edits, and then fails on save for a value the editor never showed.
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    return fail(`${where} ${key} must be an array of non-empty strings`);
  }
  return { ok: true, value: value as string[] };
}

function optionalPositiveInteger(
  raw: Record<string, unknown>,
  key: string,
  where: string,
): ParseResult<number | undefined> {
  const value = raw[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fail(`${where} ${key} must be a positive integer`);
  }
  return { ok: true, value };
}

const AGENT_KEYS = [
  "prompt",
  "worker_id",
  "workspace_id",
  "workspace_key",
  "company",
  "model",
  "role",
  "tags",
  "budget_units",
  "execution",
  "collect_files",
] as const;

const WORKER_KEYS = ["id", "type", ...AGENT_KEYS, "outputs", "output_format"] as const;
const MANAGER_KEYS = ["id", "type", "schema", ...AGENT_KEYS] as const;
const JOIN_KEYS = ["id", "type", "mode", "quorum"] as const;
const HUMAN_GATE_KEYS = ["id", "type", "label", "reason", "choices"] as const;

function parseAgentFields(
  raw: Record<string, unknown>,
  where: string,
): ParseResult<AgentNodeFields> {
  const fields: AgentNodeFields = {};

  if (raw.prompt !== undefined) {
    if (typeof raw.prompt !== "string") return fail(`${where} prompt must be a string`);
    fields.prompt = raw.prompt;
  }

  for (const key of [
    "worker_id",
    "workspace_id",
    "workspace_key",
    "company",
    "model",
    "role",
  ] as const) {
    const parsed = optionalString(raw, key, where);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) fields[key] = parsed.value;
  }

  const tags = optionalStringArray(raw, "tags", where);
  if (!tags.ok) return tags;
  if (tags.value !== undefined) fields.tags = tags.value;

  const collectFiles = optionalStringArray(raw, "collect_files", where);
  if (!collectFiles.ok) return collectFiles;
  if (collectFiles.value !== undefined) fields.collect_files = collectFiles.value;

  const budget = optionalPositiveInteger(raw, "budget_units", where);
  if (!budget.ok) return budget;
  if (budget.value !== undefined) fields.budget_units = budget.value;

  if (raw.execution !== undefined) {
    if (!EXECUTION_MODES.includes(raw.execution as ExecutionMode)) {
      return fail(`${where} execution must be one of ${EXECUTION_MODES.join(", ")}`);
    }
    fields.execution = raw.execution as ExecutionMode;
  }

  return { ok: true, value: fields };
}

export function parseNode(raw: unknown, index: number): ParseResult<GraphNode> {
  if (!isObject(raw)) return fail(`node at index ${index} must be an object`);

  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    return fail(`node at index ${index} requires a non-empty id`);
  }
  const where = `node ${id}`;

  const type = raw.type;
  if (typeof type !== "string") return fail(`${where} requires a type`);
  if (!(NODE_KINDS as readonly string[]).includes(type)) {
    // Fail closed: an unrecognised type must never be edited and re-sent.
    return fail(`${where} uses unsupported type: ${type}`);
  }

  const allowed =
    type === "worker"
      ? WORKER_KEYS
      : type === "manager"
        ? MANAGER_KEYS
        : type === "join"
          ? JOIN_KEYS
          : HUMAN_GATE_KEYS;
  const extra = unknownKeys(raw, allowed);
  if (extra.length > 0) {
    return fail(`${where} has unsupported field(s): ${extra.sort().join(", ")}`);
  }

  if (type === "worker" || type === "manager") {
    const agent = parseAgentFields(raw, where);
    if (!agent.ok) return agent;

    if (type === "manager") {
      // Atlas defaults a missing schema, but the published schema requires it; treat any other
      // value as unrecognised rather than overwriting it on save.
      if (raw.schema !== undefined && raw.schema !== MANAGER_SCHEMA) {
        return fail(`${where} schema must be ${MANAGER_SCHEMA}`);
      }
      return { ok: true, value: { id, type, schema: MANAGER_SCHEMA, ...agent.value } };
    }

    const node: WorkerNode = { id, type, ...agent.value };
    if (raw.outputs !== undefined) {
      const outputs = optionalStringArray(raw, "outputs", where);
      if (!outputs.ok) return outputs;
      const value = outputs.value!;
      if (value.length !== 1) return fail(`${where} outputs must hold exactly one artifact key`);
      // The identifier rule is checked by `validateWorkflow`, not here: Atlas never checks the
      // key at all, so refusing to open such a graph would leave it uneditable by the only tool
      // that can fix it.
      node.outputs = value;
    }
    if (raw.output_format !== undefined) {
      if (raw.output_format !== "json") return fail(`${where} output_format must be json`);
      node.output_format = "json";
    }
    return { ok: true, value: node };
  }

  if (type === "join") {
    // Atlas's executor defaults a missing mode to "all" (`workflows.py:178`); the schema
    // requires it. Reading a legacy row that omits it is normalised here, and the serializer
    // always writes it back, so the next save conforms.
    const mode = raw.mode === undefined ? "all" : raw.mode;
    if (!(JOIN_MODES as readonly string[]).includes(mode as string)) {
      return fail(`${where} mode must be one of ${JOIN_MODES.join(", ")}`);
    }
    if (mode === "quorum") {
      const quorum = raw.quorum;
      if (typeof quorum !== "number" || !Number.isInteger(quorum) || quorum < 1) {
        return fail(`${where} quorum must be a positive integer`);
      }
      return { ok: true, value: { id, type, mode: "quorum", quorum } };
    }
    if (raw.quorum !== undefined) {
      return fail(`${where} quorum is only valid when mode is quorum`);
    }
    return { ok: true, value: { id, type, mode: mode as "all" | "any" } };
  }

  const node: HumanGateNode = { id, type: "human_gate" };
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string") return fail(`${where} label must be a string`);
    node.label = raw.label;
  }
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== "string") return fail(`${where} reason must be a string`);
    node.reason = raw.reason;
  }
  if (raw.choices !== undefined) {
    if (!Array.isArray(raw.choices) || raw.choices.length === 0) {
      return fail(`${where} choices must be a non-empty list`);
    }
    const choices: HumanGateChoice[] = [];
    for (const candidate of raw.choices) {
      if (!isObject(candidate)) return fail(`${where} choice must be an object`);
      const extraChoice = unknownKeys(candidate, ["id", "label"]);
      if (extraChoice.length > 0) {
        return fail(`${where} choice has unsupported field(s): ${extraChoice.sort().join(", ")}`);
      }
      if (typeof candidate.id !== "string" || candidate.id.length === 0) {
        return fail(`${where} choice requires an id`);
      }
      if (typeof candidate.label !== "string" || candidate.label.length === 0) {
        return fail(`${where} choice ${candidate.id} requires a label`);
      }
      choices.push({ id: candidate.id, label: candidate.label });
    }
    node.choices = choices;
  }
  return { ok: true, value: node };
}

export function parseCondition(raw: unknown, where: string): ParseResult<GraphCondition> {
  if (!isObject(raw)) return fail(`${where} condition must be an object`);
  const type = raw.type;
  if (typeof type !== "string" || !(CONDITION_TYPES as readonly string[]).includes(type)) {
    // Fail closed: an unrecognised condition is never editable and never re-sent.
    return fail(`${where} uses unsupported condition: ${String(type)}`);
  }

  switch (type as ConditionType) {
    case "always": {
      const extra = unknownKeys(raw, ["type"]);
      if (extra.length > 0) return fail(`${where} always takes no other field`);
      return { ok: true, value: { type: "always" } };
    }
    case "artifact_equals": {
      const extra = unknownKeys(raw, ["type", "artifact", "path", "value"]);
      if (extra.length > 0) {
        return fail(
          `${where} artifact_equals has unsupported field(s): ${extra.sort().join(", ")}`,
        );
      }
      // Only the shape is enforced here. Atlas accepts any truthy artifact string
      // (`atlas/workflows.py:1927`), so a graph written by another client — a pack import with
      // `fast-result`, say — must still open. The stricter identifier rule is a validation
      // issue the editor can guide the user through, not a reason to refuse the whole workflow.
      if (typeof raw.artifact !== "string" || raw.artifact.length === 0) {
        return fail(`${where} artifact_equals requires an artifact key`);
      }
      if (!("value" in raw)) return fail(`${where} artifact_equals requires value`);
      const condition: GraphCondition = {
        type: "artifact_equals",
        artifact: raw.artifact,
        value: raw.value as JsonValue,
      };
      if (raw.path !== undefined) {
        if (typeof raw.path !== "string" || raw.path.length === 0) {
          return fail(`${where} artifact_equals path must be a non-empty string`);
        }
        condition.path = raw.path;
      }
      return { ok: true, value: condition };
    }
    case "artifact_in": {
      const extra = unknownKeys(raw, ["type", "artifact", "path", "values"]);
      if (extra.length > 0) {
        return fail(`${where} artifact_in has unsupported field(s): ${extra.sort().join(", ")}`);
      }
      if (typeof raw.artifact !== "string" || raw.artifact.length === 0) {
        return fail(`${where} artifact_in requires an artifact key`);
      }
      // Atlas requires only a list (`atlas/workflows.py:1935`); the published schema adds
      // `minItems: 1`. An empty list opens and is flagged, rather than locking the graph out.
      if (!Array.isArray(raw.values)) {
        return fail(`${where} artifact_in requires a values list`);
      }
      const condition: GraphCondition = {
        type: "artifact_in",
        artifact: raw.artifact,
        values: raw.values as JsonValue[],
      };
      if (raw.path !== undefined) {
        if (typeof raw.path !== "string" || raw.path.length === 0) {
          return fail(`${where} artifact_in path must be a non-empty string`);
        }
        condition.path = raw.path;
      }
      return { ok: true, value: condition };
    }
    case "manager_selected": {
      const extra = unknownKeys(raw, ["type", "target"]);
      if (extra.length > 0) {
        return fail(
          `${where} manager_selected has unsupported field(s): ${extra.sort().join(", ")}`,
        );
      }
      if (typeof raw.target !== "string" || raw.target.length === 0) {
        return fail(`${where} manager_selected requires a target`);
      }
      return { ok: true, value: { type: "manager_selected", target: raw.target } };
    }
    case "human_selected": {
      const extra = unknownKeys(raw, ["type", "choice"]);
      if (extra.length > 0) {
        return fail(`${where} human_selected has unsupported field(s): ${extra.sort().join(", ")}`);
      }
      if (typeof raw.choice !== "string" || raw.choice.length === 0) {
        return fail(`${where} human_selected requires a choice`);
      }
      return { ok: true, value: { type: "human_selected", choice: raw.choice } };
    }
    case "max_iterations_below": {
      const extra = unknownKeys(raw, ["type", "node", "max"]);
      if (extra.length > 0) {
        return fail(
          `${where} max_iterations_below has unsupported field(s): ${extra.sort().join(", ")}`,
        );
      }
      if (typeof raw.node !== "string" || raw.node.length === 0) {
        return fail(`${where} max_iterations_below requires a node`);
      }
      if (typeof raw.max !== "number" || !Number.isInteger(raw.max) || raw.max < 1) {
        return fail(`${where} max_iterations_below requires a positive integer max`);
      }
      return { ok: true, value: { type: "max_iterations_below", node: raw.node, max: raw.max } };
    }
  }
}

export function parseEdge(raw: unknown, index: number): ParseResult<GraphEdge> {
  if (!isObject(raw)) return fail(`edge at index ${index} must be an object`);
  const where = `edge at index ${index}`;

  const extra = unknownKeys(raw, ["from", "to", "condition", "push_files"]);
  if (extra.length > 0) {
    return fail(`${where} has unsupported field(s): ${extra.sort().join(", ")}`);
  }
  if (typeof raw.from !== "string" || raw.from.length === 0) {
    return fail(`${where} requires from`);
  }
  if (typeof raw.to !== "string" || raw.to.length === 0) {
    return fail(`${where} requires to`);
  }

  // Atlas's executor defaults a missing condition to `always` (`workflows.py:223`); the schema
  // requires one. Normalise on read so the model always has one and the writer always emits it.
  const condition = parseCondition(raw.condition ?? { type: "always" }, where);
  if (!condition.ok) return condition;

  const edge: GraphEdge = { from: raw.from, to: raw.to, condition: condition.value };
  if (raw.push_files !== undefined) {
    const files = optionalStringArray(raw, "push_files", where);
    if (!files.ok) return files;
    if (files.value!.length === 0) {
      return fail(`${where} push_files must be a non-empty list of strings`);
    }
    edge.push_files = files.value;
  }
  return { ok: true, value: edge };
}

/**
 * Parses Atlas's stored `graph` object.
 *
 * Returns a failure rather than a partial graph, because a partial graph is the dangerous
 * outcome: the user would edit what parsed and `PUT` it back, deleting what did not.
 */
export function parseWorkflowGraph(raw: unknown): ParseResult<WorkflowGraph> {
  if (!isObject(raw)) return fail("workflow graph must be an object");

  const extra = unknownKeys(raw, ["start", "nodes", "edges"]);
  if (extra.length > 0) {
    return fail(`workflow graph has unsupported field(s): ${extra.sort().join(", ")}`);
  }

  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    return fail("workflow graph nodes must be a non-empty list");
  }
  const nodes: GraphNode[] = [];
  const seenIds = new Set<string>();
  for (const [index, candidate] of raw.nodes.entries()) {
    const parsed = parseNode(candidate, index);
    if (!parsed.ok) return parsed;
    // Fails closed rather than being left to `validateWorkflow`: React Flow is keyed by node
    // id, so two nodes sharing one would render as a single node and the editor would silently
    // drop the other on save. Atlas rejects duplicates itself (`atlas/workflows.py:167`), so
    // this can only arrive from a hand-written row.
    if (seenIds.has(parsed.value.id)) return fail(`duplicate node id: ${parsed.value.id}`);
    seenIds.add(parsed.value.id);
    nodes.push(parsed.value);
  }

  if (typeof raw.start !== "string" || raw.start.length === 0) {
    return fail("workflow graph requires start");
  }

  const rawEdges = raw.edges ?? [];
  if (!Array.isArray(rawEdges)) return fail("workflow graph edges must be a list");
  const edges: GraphEdge[] = [];
  for (const [index, candidate] of rawEdges.entries()) {
    const parsed = parseEdge(candidate, index);
    if (!parsed.ok) return parsed;
    edges.push(parsed.value);
  }

  return { ok: true, value: { start: raw.start, nodes, edges } };
}

export function parseWorkflowPolicy(raw: unknown): ParseResult<WorkflowPolicy> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isObject(raw)) return fail("workflow policy must be an object");

  const allowed = [...Object.keys(POLICY_LIMITS), ...POLICY_BOOLEANS, ...POLICY_ID_LISTS];
  const extra = unknownKeys(raw, allowed);
  if (extra.length > 0) {
    return fail(`workflow policy has unsupported field(s): ${extra.sort().join(", ")}`);
  }

  const policy: WorkflowPolicy = {};
  for (const key of Object.keys(POLICY_LIMITS)) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return fail(`workflow policy ${key} must be an integer`);
    }
    (policy as Record<string, unknown>)[key] = value;
  }
  for (const key of POLICY_BOOLEANS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return fail(`workflow policy ${key} must be a boolean`);
    policy[key] = value;
  }
  for (const key of POLICY_ID_LISTS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
      return fail(`workflow policy ${key} must be a list of ids`);
    }
    policy[key] = value as string[];
  }
  return { ok: true, value: policy };
}

// ---------------------------------------------------------------------------
// Serialisation — the semantic model to the Atlas payload
// ---------------------------------------------------------------------------

/**
 * Produces the exact JSON Atlas stores.
 *
 * Keys whose value is `undefined` are omitted rather than sent as `null`, because the schema is
 * `additionalProperties: false` with no nullable types — `"model": null` is a rejection.
 * `join.mode` and `manager.schema` are always present even when they equal Atlas's default.
 */
export function serializeNode(node: GraphNode): Record<string, unknown> {
  const out: Record<string, unknown> = { id: node.id, type: node.type };

  if (node.type === "worker" || node.type === "manager") {
    if (node.type === "manager") out.schema = MANAGER_SCHEMA;
    for (const key of AGENT_KEYS) {
      const value = node[key];
      if (value === undefined) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      out[key] = value;
    }
    if (node.type === "worker") {
      if (node.outputs !== undefined && node.outputs.length > 0) out.outputs = node.outputs;
      if (node.output_format !== undefined) out.output_format = node.output_format;
    }
    return out;
  }

  if (node.type === "join") {
    out.mode = node.mode;
    if (node.mode === "quorum") out.quorum = node.quorum;
    return out;
  }

  if (node.label !== undefined && node.label !== "") out.label = node.label;
  if (node.reason !== undefined && node.reason !== "") out.reason = node.reason;
  if (node.choices !== undefined && node.choices.length > 0) {
    out.choices = node.choices.map((choice) => ({ id: choice.id, label: choice.label }));
  }
  return out;
}

export function serializeCondition(condition: GraphCondition): Record<string, unknown> {
  switch (condition.type) {
    case "always":
      return { type: "always" };
    case "artifact_equals":
      return {
        type: "artifact_equals",
        artifact: condition.artifact,
        ...(condition.path === undefined || condition.path === "" ? {} : { path: condition.path }),
        value: condition.value,
      };
    case "artifact_in":
      return {
        type: "artifact_in",
        artifact: condition.artifact,
        ...(condition.path === undefined || condition.path === "" ? {} : { path: condition.path }),
        values: condition.values,
      };
    case "manager_selected":
      return { type: "manager_selected", target: condition.target };
    case "human_selected":
      return { type: "human_selected", choice: condition.choice };
    case "max_iterations_below":
      return { type: "max_iterations_below", node: condition.node, max: condition.max };
  }
}

export function serializeEdge(edge: GraphEdge): Record<string, unknown> {
  const out: Record<string, unknown> = {
    from: edge.from,
    to: edge.to,
    condition: serializeCondition(edge.condition),
  };
  if (edge.push_files !== undefined && edge.push_files.length > 0) out.push_files = edge.push_files;
  return out;
}

export function serializeWorkflowGraph(graph: WorkflowGraph): Record<string, unknown> {
  return {
    start: graph.start,
    nodes: graph.nodes.map(serializeNode),
    edges: graph.edges.map(serializeEdge),
  };
}

export function serializeWorkflowPolicy(policy: WorkflowPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(policy)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation — every rule Atlas enforces, checked locally first
// ---------------------------------------------------------------------------

/**
 * Where a problem belongs on screen.
 *
 * Atlas raises one `ValueError` at a time and returns it as a single `{"error": "..."}` string,
 * so a save that reaches Atlas reports one problem per round trip. Validating locally first
 * means the user sees every problem at once, each anchored to the thing that is wrong.
 */
export type IssueTarget =
  | { kind: "graph"; field?: string }
  | { kind: "node"; nodeId: string; field?: string }
  | { kind: "edge"; edgeIndex: number; field?: string }
  | { kind: "policy"; field: string };

export interface ValidationIssue {
  target: IssueTarget;
  message: string;
}

function distinctIncoming(graph: WorkflowGraph): Map<string, Set<string>> {
  const incoming = new Map<string, Set<string>>();
  for (const node of graph.nodes) incoming.set(node.id, new Set());
  for (const edge of graph.edges) incoming.get(edge.to)?.add(edge.from);
  return incoming;
}

/** Mirrors `_has_cycle` (`atlas/workflows.py:1955`) — a DFS back-edge, not just a self-loop. */
export function hasCycle(graph: WorkflowGraph): boolean {
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) outgoing.set(node.id, []);
  for (const edge of graph.edges) outgoing.get(edge.from)?.push(edge.to);

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  return graph.nodes.some((node) => visit(node.id));
}

/** Mirrors `_has_loop_guard` (`atlas/workflows.py:2119`). */
export function hasLoopGuard(graph: WorkflowGraph, policy: WorkflowPolicy): boolean {
  if (typeof policy.max_iterations === "number" && policy.max_iterations > 0) return true;
  return graph.edges.some((edge) => edge.condition.type === "max_iterations_below");
}

/** Nodes with no path from `graph.start`. Atlas tolerates them; the editor warns. */
export function unreachableNodeIds(graph: WorkflowGraph): string[] {
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) outgoing.set(node.id, []);
  for (const edge of graph.edges) outgoing.get(edge.from)?.push(edge.to);

  const seen = new Set<string>();
  const stack = [graph.start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) stack.push(next);
  }
  return graph.nodes.map((node) => node.id).filter((id) => !seen.has(id));
}

/**
 * Every rule Atlas would reject the payload for, plus the identifier rules the editor adds.
 *
 * Returns an empty array when Atlas would accept the graph — with one deliberate exception:
 * `validate_workflow_references` (`atlas/workflows.py:304`) checks `worker_id`/`workspace_id`
 * against Atlas's own tables, which this client cannot do. That check stays server-side and
 * surfaces through `POST /api/workflows/{id}/validate`.
 */
export function validateWorkflow(graph: WorkflowGraph, policy: WorkflowPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeById = new Map<string, GraphNode>();

  if (graph.nodes.length === 0) {
    issues.push({ target: { kind: "graph", field: "nodes" }, message: "Add at least one node." });
  }

  for (const node of graph.nodes) {
    if (nodeById.has(node.id)) {
      issues.push({
        target: { kind: "node", nodeId: node.id, field: "id" },
        message: `Duplicate node id: ${node.id}`,
      });
      continue;
    }
    nodeById.set(node.id, node);

    if (!isIdentifier(node.id)) {
      issues.push({
        target: { kind: "node", nodeId: node.id, field: "id" },
        message:
          "Node id must start with a letter or underscore and contain only letters, digits, and underscores.",
      });
    }

    if (node.type === "worker") {
      if (node.outputs !== undefined && node.outputs.length !== 1) {
        issues.push({
          target: { kind: "node", nodeId: node.id, field: "outputs" },
          message: "A worker produces exactly one artifact key.",
        });
      }
      if (node.outputs?.[0] !== undefined && !isIdentifier(node.outputs[0])) {
        issues.push({
          target: { kind: "node", nodeId: node.id, field: "outputs" },
          message:
            "Artifact key must start with a letter or underscore and contain only letters, digits, and underscores.",
        });
      }
    }

    if (node.type === "join") {
      if (node.mode === "quorum") {
        if (!Number.isInteger(node.quorum) || (node.quorum ?? 0) < 1) {
          issues.push({
            target: { kind: "node", nodeId: node.id, field: "quorum" },
            message: "Quorum must be a positive integer.",
          });
        }
      }
    }

    if (node.type === "human_gate" && node.choices !== undefined) {
      if (node.choices.length === 0) {
        issues.push({
          target: { kind: "node", nodeId: node.id, field: "choices" },
          message: "Remove the choice list or give it at least one choice.",
        });
      }
      const ids = new Set<string>();
      for (const choice of node.choices) {
        if (choice.id.trim() === "") {
          issues.push({
            target: { kind: "node", nodeId: node.id, field: "choices" },
            message: "Every choice needs an id.",
          });
        } else if (ids.has(choice.id)) {
          issues.push({
            target: { kind: "node", nodeId: node.id, field: "choices" },
            message: `Duplicate choice id: ${choice.id}`,
          });
        }
        ids.add(choice.id);
        if (choice.label.trim() === "") {
          issues.push({
            target: { kind: "node", nodeId: node.id, field: "choices" },
            message: `Choice ${choice.id} needs a label.`,
          });
        }
      }
    }

    if (node.type === "worker" || node.type === "manager") {
      if (node.budget_units !== undefined) {
        if (!Number.isInteger(node.budget_units) || node.budget_units < 1) {
          issues.push({
            target: { kind: "node", nodeId: node.id, field: "budget_units" },
            message: "Budget units must be a positive integer.",
          });
        }
      }

      // Atlas rejects a bad pattern on save, so checking it here is what turns a 400 round trip
      // into an inline message on the field the user is typing in.
      if (node.collect_files !== undefined) {
        if (node.collect_files.length > COLLECT_FILES_MAX_PATHS) {
          issues.push({
            target: { kind: "node", nodeId: node.id, field: "collect_files" },
            message: `At most ${COLLECT_FILES_MAX_PATHS} collected paths.`,
          });
        }
        for (const pattern of node.collect_files) {
          const problem = collectFilesProblem(pattern);
          if (problem !== null) {
            issues.push({
              target: { kind: "node", nodeId: node.id, field: "collect_files" },
              message: `${problem} (${pattern})`,
            });
          }
        }
      }
    }
  }

  if (graph.start.trim() === "") {
    issues.push({ target: { kind: "graph", field: "start" }, message: "Choose a start node." });
  } else if (!nodeById.has(graph.start)) {
    issues.push({
      target: { kind: "graph", field: "start" },
      message: `Start references a node that does not exist: ${graph.start}`,
    });
  }

  graph.edges.forEach((edge, edgeIndex) => {
    const source = nodeById.get(edge.from);
    if (!source) {
      issues.push({
        target: { kind: "edge", edgeIndex, field: "from" },
        message: `Edge source does not exist: ${edge.from}`,
      });
    }
    if (!nodeById.has(edge.to)) {
      issues.push({
        target: { kind: "edge", edgeIndex, field: "to" },
        message: `Edge target does not exist: ${edge.to}`,
      });
    }

    const condition = edge.condition;

    // `workflows.py:224` — every edge leaving a manager must be manager_selected.
    if (source?.type === "manager" && condition.type !== "manager_selected") {
      issues.push({
        target: { kind: "edge", edgeIndex, field: "condition" },
        message: "An edge from a manager must use the manager_selected condition.",
      });
    }
    // `workflows.py:238` — a gate that declares choices routes only by human_selected.
    if (
      source?.type === "human_gate" &&
      (source.choices?.length ?? 0) > 0 &&
      condition.type !== "human_selected"
    ) {
      issues.push({
        target: { kind: "edge", edgeIndex, field: "condition" },
        message: "An edge from a gate with choices must use the human_selected condition.",
      });
    }

    if (condition.type === "manager_selected") {
      if (source && source.type !== "manager") {
        issues.push({
          target: { kind: "edge", edgeIndex, field: "condition" },
          message: "manager_selected is only valid on an edge whose source is a manager.",
        });
      }
      if (condition.target !== edge.to) {
        issues.push({
          target: { kind: "edge", edgeIndex, field: "condition" },
          message: "manager_selected target must be the edge's own target node.",
        });
      }
      if (!nodeById.has(condition.target)) {
        issues.push({
          target: { kind: "edge", edgeIndex, field: "condition" },
          message: `manager_selected references a node that does not exist: ${condition.target}`,
        });
      }
    }

    if (condition.type === "human_selected") {
      if (source && source.type !== "human_gate") {
        issues.push({
          target: { kind: "edge", edgeIndex, field: "condition" },
          message: "human_selected is only valid on an edge whose source is a human gate.",
        });
      } else if (source) {
        const declared = new Set((source as HumanGateNode).choices?.map((c) => c.id) ?? []);
        if (!declared.has(condition.choice)) {
          issues.push({
            target: { kind: "edge", edgeIndex, field: "condition" },
            message: `The source gate does not declare the choice ${condition.choice}.`,
          });
        }
      }
    }

    if (condition.type === "max_iterations_below") {
      if (!nodeById.has(condition.node)) {
        issues.push({
          target: { kind: "edge", edgeIndex, field: "condition" },
          message: `max_iterations_below references a node that does not exist: ${condition.node}`,
        });
      }
      // The guard's own bound needs checking as much as the node it names: a NaN or a zero here
      // is a loop with no limit, which is precisely what the guard exists to prevent.
      if (!Number.isInteger(condition.max) || condition.max < 1) {
        issues.push({
          target: { kind: "edge", edgeIndex, field: "condition" },
          message: "The iteration limit must be a whole number of at least 1.",
        });
      }
    }

    if (
      (condition.type === "artifact_equals" || condition.type === "artifact_in") &&
      !isIdentifier(condition.artifact)
    ) {
      issues.push({
        target: { kind: "edge", edgeIndex, field: "condition" },
        message:
          "Artifact key must start with a letter or underscore and contain only letters, digits, and underscores.",
      });
    }
    if (condition.type === "artifact_in" && condition.values.length === 0) {
      issues.push({
        target: { kind: "edge", edgeIndex, field: "condition" },
        message: "artifact_in needs at least one value.",
      });
    }

    if ((edge.push_files ?? []).some((pattern) => pattern.trim().length === 0)) {
      issues.push({
        target: { kind: "edge", edgeIndex, field: "push_files" },
        message: "Every pushed-file pattern must be non-empty.",
      });
    }

    // `workflows.py:243` — push_files is gated on the policy opt-in.
    if ((edge.push_files?.length ?? 0) > 0 && policy.file_handoff !== true) {
      issues.push({
        target: { kind: "edge", edgeIndex, field: "push_files" },
        message: "Pushing files on an edge requires policy.file_handoff.",
      });
    }
  });

  // `workflows.py:252` — quorum cannot exceed the number of distinct upstream nodes.
  const incoming = distinctIncoming(graph);
  for (const node of graph.nodes) {
    if (node.type !== "join" || node.mode !== "quorum") continue;
    const upstream = incoming.get(node.id)?.size ?? 0;
    if ((node.quorum ?? 0) > upstream) {
      issues.push({
        target: { kind: "node", nodeId: node.id, field: "quorum" },
        message: `Quorum ${node.quorum} exceeds the ${upstream} distinct upstream node(s) feeding this join.`,
      });
    }
  }

  // `workflows.py:255` — a cycle needs a guard.
  if (hasCycle(graph) && !hasLoopGuard(graph, policy)) {
    issues.push({
      target: { kind: "graph", field: "edges" },
      message:
        "This graph loops. Set policy.max_iterations, or give the back-edge a max_iterations_below condition.",
    });
  }

  issues.push(...validatePolicy(policy));
  return issues;
}

export function validatePolicy(policy: WorkflowPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [key, maximum] of Object.entries(POLICY_LIMITS)) {
    const value = (policy as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
      issues.push({
        target: { kind: "policy", field: key },
        message: `${key} must be a whole number between 1 and ${maximum}.`,
      });
    }
  }
  for (const key of POLICY_BOOLEANS) {
    const value = policy[key];
    if (value !== undefined && typeof value !== "boolean") {
      issues.push({
        target: { kind: "policy", field: key },
        message: `${key} must be true or false.`,
      });
    }
  }
  for (const key of POLICY_ID_LISTS) {
    const value = policy[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
      issues.push({
        target: { kind: "policy", field: key },
        message: `${key} must be a list of ids.`,
      });
    }
  }
  return issues;
}

/**
 * Anchors one of Atlas's validation messages to the thing it is about.
 *
 * Atlas raises a single `ValueError` and returns it as `{"error": "<one sentence>"}` — there is
 * no field path, no node reference, and no list. But the sentences are generated from a small
 * set of `f`-strings in `atlas/workflows.py`, and every one of them names its subject in a
 * fixed position: "workflow node {id} …", "workflow edge at index {i} …", "workflow policy
 * {key} …". Reading the subject back out is what lets a server rejection land on the same node
 * the local checks would have highlighted, instead of as a banner the user has to interpret.
 *
 * Deliberately conservative: anything that does not match a known shape stays a graph-level
 * message rather than being attached to a guess.
 */
export function mapAtlasValidationMessage(message: string): ValidationIssue {
  // Atlas also emits an index form — "workflow node at index 0 requires a non-empty id"
  // (`atlas/workflows.py:161,165`) — which has no id to anchor to. The negative lookahead keeps
  // it out of the id branch, where it would produce an issue attached to a node called "at".
  const node = /^workflow (?:manager |join |human_gate )?node (?!at index )([^\s]+) /.exec(message);
  if (node) {
    return { target: { kind: "node", nodeId: node[1]! }, message };
  }

  const edge = /^workflow (?:manager |human_gate )?edge at index (\d+) /.exec(message);
  if (edge) {
    return { target: { kind: "edge", edgeIndex: Number(edge[1]) }, message };
  }

  const policy = /^workflow policy ([a-z_]+) /.exec(message);
  if (policy) {
    return { target: { kind: "policy", field: policy[1]! }, message };
  }

  // `policy allowed_worker_ids references unknown worker: …` and its workspace twin.
  const allowList = /^policy (allowed_worker_ids|allowed_workspace_ids) /.exec(message);
  if (allowList) {
    return { target: { kind: "policy", field: allowList[1]! }, message };
  }

  if (message.startsWith("workflow graph start")) {
    return { target: { kind: "graph", field: "start" }, message };
  }
  if (message.startsWith("workflow graph has a cycle")) {
    return { target: { kind: "graph", field: "edges" }, message };
  }
  if (/^duplicate node id: /.test(message)) {
    return {
      target: { kind: "node", nodeId: message.slice("duplicate node id: ".length) },
      message,
    };
  }

  return { target: { kind: "graph" }, message };
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export type RenameResult = { ok: true; graph: WorkflowGraph } | { ok: false; reason: string };

/**
 * Renames a node id everywhere it is referenced, in one step.
 *
 * A node id is a foreign key in four places — `graph.start`, `edge.from`, `edge.to`,
 * `manager_selected.target`, and `max_iterations_below.node`. Renaming the node alone leaves
 * dangling references that Atlas rejects on save, and renaming them one at a time leaves the
 * graph invalid in between. This returns a whole new graph or nothing.
 */
export function renameNodeId(graph: WorkflowGraph, fromId: string, toId: string): RenameResult {
  if (fromId === toId) return { ok: true, graph };
  if (!isIdentifier(toId)) {
    return {
      ok: false,
      reason:
        "Node id must start with a letter or underscore and contain only letters, digits, and underscores.",
    };
  }
  if (!graph.nodes.some((node) => node.id === fromId)) {
    return { ok: false, reason: `No node with id ${fromId}.` };
  }
  if (graph.nodes.some((node) => node.id === toId)) {
    return { ok: false, reason: `A node with id ${toId} already exists.` };
  }

  const swap = (id: string) => (id === fromId ? toId : id);

  return {
    ok: true,
    graph: {
      start: swap(graph.start),
      nodes: graph.nodes.map((node) => (node.id === fromId ? { ...node, id: toId } : node)),
      edges: graph.edges.map((edge) => {
        let condition = edge.condition;
        if (condition.type === "manager_selected" && condition.target === fromId) {
          condition = { ...condition, target: toId };
        } else if (condition.type === "max_iterations_below" && condition.node === fromId) {
          condition = { ...condition, node: toId };
        }
        return { ...edge, from: swap(edge.from), to: swap(edge.to), condition };
      }),
    },
  };
}

/** Removes a node and every edge touching it. `graph.start` is repointed to the first survivor. */
export function removeNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  const nodes = graph.nodes.filter((node) => node.id !== nodeId);
  const edges = graph.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
  const start = graph.start === nodeId ? (nodes[0]?.id ?? "") : graph.start;
  return { start, nodes, edges };
}

/** A human-readable caption for an edge, derived from its condition and stored nowhere. */
export function describeCondition(condition: GraphCondition): string {
  switch (condition.type) {
    case "always":
      return "always";
    case "artifact_equals":
      return `${condition.artifact}${condition.path ? `.${condition.path}` : ""} = ${JSON.stringify(condition.value)}`;
    case "artifact_in":
      return `${condition.artifact}${condition.path ? `.${condition.path}` : ""} in ${JSON.stringify(condition.values)}`;
    case "manager_selected":
      return `manager picks ${condition.target}`;
    case "human_selected":
      return `choice: ${condition.choice}`;
    case "max_iterations_below":
      return `${condition.node} run < ${condition.max}×`;
  }
}

/**
 * A stable identity for a locally stored layout: the workflow and the graph version it fits.
 *
 * Note what the version component does and does not do today. `workflow_definitions.version` is
 * client-controlled — Atlas never increments it (`atlas/db.py` `update_workflow_definition`) —
 * and this client deliberately never sends it, so an ordinary save leaves it unchanged and the
 * layout is correctly reused. The component earns its place for the writes that *do* move it: a
 * pack import, an admin bump, or another client. Those genuinely replace the graph, and
 * reapplying an old arrangement to it would place nodes by coincidence.
 */
export function layoutStorageKey(workflowId: string, graphVersion: number): string {
  return `flow-designer:layout:${workflowId}:v${graphVersion}`;
}
