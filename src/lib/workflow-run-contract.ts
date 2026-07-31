/**
 * The **observed** run interface of a saved workflow graph.
 *
 * Pure and client-safe — no `*.server.ts` import, no React, no network. Everything here is
 * derived by reading prompt text and node configuration, which is why every name in this file
 * says *observed* or *possible* and never *declared*, *required*, *typed*, or *enforced*.
 *
 * ## What this is not
 *
 * Atlas has no workflow input schema today. `POST /api/workflow-runs` validates that `input` is
 * an object and that the reserved `_meta` envelope is well-formed; nothing else. A missing
 * `{input.x}` is discovered later, by a background node rendering its prompt, long after the
 * start API returned `202`. So this module cannot and does not promise types, defaults, business
 * meaning, branch-independent requiredness, or that any artifact will exist. It reports what the
 * saved graph *references* and what a worker *may* produce. That is useful for testing and for
 * scaffolding an application, and it is advisory.
 *
 * ## Ground truth, read at Atlas `4b837cc`
 *
 *  - `atlas/workflows.py:31` — `_FIELD_RE`, the only placeholder grammar Atlas has.
 *  - `atlas/workflows.py:363` — `render_prompt`, and the five roots it resolves.
 *  - `atlas/workflows.py:2178` — `_resolve_path`, which is why an intermediate scalar is a miss.
 *  - `atlas/workflows.py:1614-1618` — the branch that decides which prompt is interpolated.
 *
 * That last one is load-bearing and is the reason {@link ObservedContract.managerReferences}
 * exists. A **worker** node's prompt goes through `render_prompt`. A **manager** node's does
 * not: `_prepare_worker_node_payload` calls `_manager_prompt`, which takes `node["prompt"]`
 * verbatim, appends the `manager_decision_v1` instruction and a JSON context of
 * `{graph, current_node, artifacts, counters, policy}`, and never touches `_FIELD_RE`. There is
 * no `input` in that context at all. So `{input.x}` in a manager prompt is **not substituted**
 * and **not an error** — the literal eight characters reach the model. Atlas's own concepts and
 * visual-builder docs describe manager substitution, so the docs and the executable path
 * disagree; see `docs/ATLAS_LIMITATIONS.md`. Reporting a manager reference as a run input would
 * invent a requirement Atlas does not have, so this module refuses to.
 */

import {
  isIdentifier,
  type GraphNode,
  type JsonObject,
  type JsonValue,
  type WorkflowGraph,
} from "./workflow-graph";

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

/**
 * A faithful JavaScript mirror of Atlas's `_FIELD_RE`
 * (`re.compile(r"{([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)}")`).
 *
 * Two details are deliberate rather than incidental:
 *
 *  - **At least one dot is mandatory.** The inner group is `+`, not `*`, so `{input}` and
 *    `{files_dir}` are not placeholders at all and survive into the rendered prompt untouched.
 *    (`{files_dir}` is substituted separately, by a plain string replace at
 *    `atlas/workflows.py:1623`.)
 *  - **`\p{L}\p{N}_` rather than `\w`.** JavaScript's `\w` is ASCII-only; Python's, on a `str`
 *    pattern, is Unicode-aware and matches exactly "alphanumeric per `str.isalnum()` plus
 *    underscore" — that is `\p{L}` ∪ `\p{N}` ∪ `_`. Using `\w` here would silently fail to see
 *    `{input.a_ก}`, which Atlas does substitute. Note that a segment still has to *start* with
 *    ASCII `[A-Za-z_]`, so `{input.ชื่อ}` is not a placeholder in either engine, and combining
 *    marks (Thai vowel signs are `Mn`) end a segment in both.
 */
export const OBSERVED_PLACEHOLDER_RE =
  /\{([A-Za-z_][\p{L}\p{N}_]*(?:\.[A-Za-z_][\p{L}\p{N}_]*)+)\}/gu;

/**
 * The five roots `render_prompt` builds a context for (`atlas/workflows.py:372-378`).
 *
 * A dotted placeholder whose root is not one of these still *matches* the grammar, and then
 * `_resolve_path` raises `unknown prompt variable`. That is a hard node failure at run time, not
 * a caller-suppliable input, which is why it is reported as a diagnostic and never as a path.
 */
export const PLACEHOLDER_ROOTS = ["input", "artifact", "run", "node", "job"] as const;

/** Loose brace scan, used only to find text that *looks* like a placeholder but is not one. */
const BRACE_CANDIDATE_RE = /\{([^{}\r\n]{1,200})\}/g;

/**
 * Bounds on what a contract *renders* — never on what it checks.
 *
 * A graph is user-authored and could reference hundreds of paths, and every consumer displays or
 * serialises the result, so the list shown is capped and the remainder is stated. The contract
 * itself keeps every path, because {@link preflightRunInput} has to see all of them: a bound
 * applied to the data rather than to its presentation is how a required field silently stops
 * being checked.
 */
export const MAX_RENDERED_PATHS = 200;
export const MAX_RENDERED_OUTPUTS = 200;

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** One deduplicated `input.*` path, with every node observed to consume it. */
export interface ObservedInputPath {
  /** The placeholder path exactly as Atlas reads it, e.g. `input.applicant.name`. */
  path: string;
  /** The segments below the `input` root. Never empty — the grammar requires a dot. */
  segments: string[];
  /** Every node whose executable prompt references it: graph order, deduplicated. */
  nodeIds: string[];
  /**
   * True when the graph's start node is a **worker** that references this path.
   *
   * This is the only case that can be called blocking without inventing anything: the start
   * node's prompt is rendered before any branch decision, so Atlas fails the run immediately.
   * Every other reference is branch-dependent — the node may never execute.
   */
  referencedByStartWorker: boolean;
}

/**
 * An artifact key a worker node **may** write. Never a guarantee.
 *
 * Whether the node runs at all depends on the branch taken, and whether it succeeds depends on
 * the worker. `outputs` is also optional in Atlas's schema, so a worker without one produces no
 * keyed artifact and simply does not appear here.
 */
export interface ObservedOutput {
  key: string;
  /** The single worker node that declares this key. */
  nodeId: string;
  /**
   * `json` only when the node sets `output_format: "json"`; `text` otherwise.
   *
   * `output_format` is the only signal in the graph. It is not a content schema: a worker that
   * declares `json` can still return something else, and Atlas stores what it got.
   */
  kind: "json" | "text";
}

export type ObservedDiagnosticSeverity = "error" | "warning" | "note";

export type ObservedDiagnosticCode =
  /** A parent reference that also has members referenced beneath it. Informational. */
  | "parent_path_renders_json"
  /** Brace text that resembles a placeholder but does not match Atlas's grammar. */
  | "unsupported_placeholder"
  /** A dotted placeholder whose root is not one of the five Atlas resolves. */
  | "unknown_placeholder_root"
  /** `{input.*}` in a manager prompt, which the executable path does not substitute. */
  | "manager_placeholder_not_substituted"
  /** More output keys than {@link MAX_RENDERED_OUTPUTS}; the rest are omitted from documents. */
  | "truncated";

export interface ObservedDiagnostic {
  code: ObservedDiagnosticCode;
  severity: ObservedDiagnosticSeverity;
  message: string;
  /** The nodes the diagnostic is about, when it is about nodes. */
  nodeIds: string[];
}

export interface ObservedContract {
  workflowId: string;
  /** The workflow version observed when this was derived. Nothing pins a run to it. */
  observedVersion: number;
  startNodeId: string;
  /** Null when `graph.start` names no node in the graph. */
  startNodeKind: GraphNode["type"] | null;
  inputPaths: ObservedInputPath[];
  outputs: ObservedOutput[];
  /**
   * `{input.*}` references found in **manager** prompts.
   *
   * Listed separately and never merged into {@link inputPaths}, because Atlas does not
   * substitute them. See this module's header for the exact call path.
   */
  managerReferences: Array<{ path: string; nodeIds: string[] }>;
  diagnostics: ObservedDiagnostic[];
  /**
   * A deterministic illustrative object shaped like {@link inputPaths}.
   *
   * Every leaf is the string `<input.the.path>`. These are **not** defaults and **not** typed
   * examples — Atlas has no type information to give and this module invents none. The value is
   * a placeholder that shows the shape and is obviously not real data.
   *
   * `null` when a path collision makes any single object lossy: emitting one of the two
   * conflicting shapes would quietly discard the other.
   */
  skeleton: JsonObject | null;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Every distinct dotted placeholder in one template, in first-appearance order. */
export function extractPlaceholders(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(OBSERVED_PLACEHOLDER_RE)) seen.add(match[1]!);
  return [...seen];
}

/**
 * Brace text a reader would take for a placeholder but Atlas leaves literal.
 *
 * Reported rather than repaired. Rewriting someone's prompt to what we guessed they meant is a
 * far worse failure than telling them Atlas will send `{input.items[0]}` to the model verbatim.
 */
function unsupportedCandidates(template: string): string[] {
  const supported = new Set(extractPlaceholders(template));
  const found = new Set<string>();
  for (const match of template.matchAll(BRACE_CANDIDATE_RE)) {
    const body = match[1]!;
    if (supported.has(body)) continue;
    // Only flag text that is trying to be a path. `{"verdict":"ok"}` in a prompt asking for
    // JSON output is not a typo, and Atlas leaves it alone for the same reason we do.
    if (!/^[A-Za-z_][^\s:"']*[.[][^\s:"']*$/.test(body)) continue;
    found.add(body);
  }
  return [...found];
}

/** The prompt Atlas actually interpolates for a node, or null when it interpolates none. */
function executablePrompt(node: GraphNode): string | null {
  // `atlas/workflows.py:1614` — only a worker's prompt reaches `render_prompt`. A manager's is
  // handled by `_manager_prompt`; join and human_gate nodes have no prompt field at all.
  return node.type === "worker" ? (node.prompt ?? "") : null;
}

/**
 * Whether one path is a strict prefix of another, segment-wise.
 *
 * Compared on segments, not on the string: `input.user` is a prefix of `input.user.name` but not
 * of `input.username`, and a `startsWith` test would get the second one wrong.
 */
function isPrefixOf(shorter: string[], longer: string[]): boolean {
  if (shorter.length >= longer.length) return false;
  return shorter.every((segment, index) => longer[index] === segment);
}

/**
 * A container for skeleton building that has no prototype to walk or write through.
 *
 * `__proto__` is an ordinary dictionary key to Atlas — Python has no prototype chain — and the
 * grammar accepts it, so `{input.__proto__.atlasPolluted}` is a path a caller could legitimately
 * supply. Built with `{}` this function would read `cursor["__proto__"]`, find `Object.prototype`,
 * treat it as the nested object to descend into, and write the leaf onto it: one saved workflow
 * would then poison every object in the running app. `Object.create(null)` removes the chain, so
 * the same key becomes an ordinary own property that serialises and round-trips normally.
 */
function emptyBranch(): JsonObject {
  return Object.create(null) as JsonObject;
}

function ownValue(container: JsonObject, key: string): JsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(container, key) ? container[key] : undefined;
}

/**
 * The illustrative object, nested so that a parent reference and its children are both satisfied.
 *
 * `{input.user}` and `{input.user.name}` are *not* in conflict: `_prompt_value`
 * (`atlas/workflows.py:2193`) JSON-encodes a dict, so given `{"user":{"name":"Alice"}}` the first
 * renders `{"name":"Alice"}` and the second renders `Alice`. The nested object is therefore the
 * one answer that serves both, and a leaf placeholder is written only where nothing deeper needs
 * that position.
 */
function buildSkeleton(paths: ObservedInputPath[]): JsonObject {
  const root = emptyBranch();
  // Deepest first, so a parent never overwrites a nested branch that a child already built.
  const ordered = [...paths].sort((a, b) => b.segments.length - a.segments.length);

  for (const { segments, path } of ordered) {
    let cursor = root;
    for (const [index, segment] of segments.entries()) {
      if (index === segments.length - 1) {
        // A parent whose children are already present keeps the object: overwriting it with a
        // string would break every child path, and Atlas renders the object for the parent.
        if (ownValue(cursor, segment) === undefined) cursor[segment] = `<${path}>`;
        break;
      }
      const existing = ownValue(cursor, segment);
      const child =
        existing !== undefined &&
        existing !== null &&
        typeof existing === "object" &&
        !Array.isArray(existing)
          ? (existing as JsonObject)
          : emptyBranch();
      cursor[segment] = child;
      cursor = child;
    }
  }
  return root;
}

/**
 * Derives the observed contract of a saved graph.
 *
 * Deterministic: paths appear in graph-node order then prompt order, so two calls on the same
 * graph produce byte-identical JSON and the unit snapshots are meaningful.
 */
export function observeWorkflowContract(
  graph: WorkflowGraph,
  meta: { workflowId: string; observedVersion: number },
): ObservedContract {
  const startNode = graph.nodes.find((node) => node.id === graph.start) ?? null;
  const diagnostics: ObservedDiagnostic[] = [];

  const byPath = new Map<string, ObservedInputPath>();
  const managerByPath = new Map<string, string[]>();
  const unknownRoots = new Map<string, string[]>();
  const unsupported = new Map<string, string[]>();

  const push = (map: Map<string, string[]>, key: string, nodeId: string) => {
    const nodeIds = map.get(key);
    if (!nodeIds) map.set(key, [nodeId]);
    else if (!nodeIds.includes(nodeId)) nodeIds.push(nodeId);
  };

  for (const node of graph.nodes) {
    // A manager's prompt is scanned so its `{input.*}` references can be *reported*, but it is
    // never treated as executable — see the header.
    const prompt = node.type === "worker" || node.type === "manager" ? (node.prompt ?? "") : null;
    if (prompt === null || prompt === "") continue;

    for (const candidate of unsupportedCandidates(prompt)) push(unsupported, candidate, node.id);

    const executable = executablePrompt(node) !== null;

    for (const placeholder of extractPlaceholders(prompt)) {
      const segments = placeholder.split(".");
      const root = segments[0]!;

      if (!(PLACEHOLDER_ROOTS as readonly string[]).includes(root)) {
        // Reported only for a prompt Atlas interpolates. In a manager prompt the same text is
        // simply literal, so calling it an error would be false.
        if (executable) push(unknownRoots, placeholder, node.id);
        continue;
      }
      // `artifact`, `run`, `node`, and `job` are resolved by Atlas from run state. They are not
      // supplied by the caller, so they are deliberately not part of a run-input contract.
      if (root !== "input") continue;

      if (!executable) {
        push(managerByPath, placeholder, node.id);
        continue;
      }

      const existing = byPath.get(placeholder);
      if (existing) {
        if (!existing.nodeIds.includes(node.id)) existing.nodeIds.push(node.id);
        existing.referencedByStartWorker ||= node.id === graph.start;
        continue;
      }
      byPath.set(placeholder, {
        path: placeholder,
        segments: segments.slice(1),
        nodeIds: [node.id],
        referencedByStartWorker: node.id === graph.start,
      });
    }
  }

  /**
   * Every observed path, never truncated.
   *
   * Truncating here would blind {@link preflightRunInput}: a start worker referencing more paths
   * than the display cap would look satisfied once the visible ones were supplied, and Atlas
   * would then fail the run on a field this UI had declared present. Rendering is bounded at
   * {@link MAX_RENDERED_PATHS} by the document builders instead, which is a display concern.
   */
  const inputPaths = [...byPath.values()];

  // A parent and its child are both satisfiable at once: Atlas JSON-encodes a dict for the
  // parent reference (`_prompt_value`), so `{"user":{"name":"Alice"}}` serves `{input.user}` and
  // `{input.user.name}` together. Worth pointing out — the parent's value will be a JSON blob in
  // the prompt, which is rarely what someone expects — but it is not a problem to solve.
  const noted = new Set<string>();
  for (const outer of inputPaths) {
    for (const inner of inputPaths) {
      if (outer === inner || !isPrefixOf(outer.segments, inner.segments)) continue;
      if (noted.has(outer.path)) continue;
      noted.add(outer.path);
      diagnostics.push({
        code: "parent_path_renders_json",
        severity: "note",
        message: `${outer.path} is referenced as a whole value and also has members referenced beneath it (${inner.path}). One object satisfies both: Atlas renders the parent as compact JSON and the member as its own value.`,
        nodeIds: [...new Set([...outer.nodeIds, ...inner.nodeIds])],
      });
    }
  }

  for (const [path, nodeIds] of unknownRoots) {
    diagnostics.push({
      code: "unknown_placeholder_root",
      severity: "error",
      message: `{${path}} has no root Atlas resolves. Rendering this prompt raises "unknown prompt variable" and fails the node; Atlas resolves only ${PLACEHOLDER_ROOTS.join(", ")}.`,
      nodeIds,
    });
  }

  for (const [candidate, nodeIds] of unsupported) {
    diagnostics.push({
      code: "unsupported_placeholder",
      severity: "note",
      message: `{${candidate}} is not a placeholder Atlas substitutes — its grammar accepts dotted identifiers only, with no array index. Atlas sends these characters to the worker unchanged.`,
      nodeIds,
    });
  }

  const managerReferences = [...managerByPath].map(([path, nodeIds]) => ({ path, nodeIds }));
  if (managerReferences.length > 0) {
    diagnostics.push({
      code: "manager_placeholder_not_substituted",
      severity: "warning",
      message:
        "An AI Decision (manager) prompt references {input.*}. Atlas builds a manager prompt without input substitution, so this text reaches the model literally and supplying a value changes nothing. It is not listed as a run input.",
      nodeIds: [...new Set(managerReferences.flatMap((reference) => reference.nodeIds))],
    });
  }

  const outputs: ObservedOutput[] = graph.nodes.flatMap((node) => {
    if (node.type !== "worker") return [];
    // Exactly `outputs[0]`: Atlas's schema pins the list to one entry, and a graph that somehow
    // carries more is not a reason to invent artifact keys. `collect_files` is deliberately not
    // read here — it declares *patterns* whose matches Atlas discovers at run time, so it can
    // never yield a known file-ref key up front.
    const key = node.outputs?.[0];
    if (key === undefined || !isIdentifier(key)) return [];
    return [{ key, nodeId: node.id, kind: node.output_format === "json" ? "json" : "text" }];
  });
  if (outputs.length > MAX_RENDERED_OUTPUTS) {
    diagnostics.push({
      code: "truncated",
      severity: "note",
      message: `This graph declares ${outputs.length} output keys; documents and lists show the first ${MAX_RENDERED_OUTPUTS}.`,
      nodeIds: [],
    });
  }

  return {
    workflowId: meta.workflowId,
    observedVersion: meta.observedVersion,
    startNodeId: graph.start,
    startNodeKind: startNode?.type ?? null,
    inputPaths,
    outputs,
    managerReferences,
    diagnostics,
    skeleton: buildSkeleton(inputPaths),
  };
}

// ---------------------------------------------------------------------------
// Run input parsing and preflight
// ---------------------------------------------------------------------------

export type RunInputParse =
  | { ok: true; value: JsonObject }
  | { ok: false; reason: "invalid_json" | "not_object"; message: string };

/**
 * Parses the textarea contents into the object `POST /api/workflow-runs` accepts.
 *
 * The root check is not cosmetic. Atlas requires an object; an array, a string, a number, a
 * boolean, or `null` is refused, and refusing it here means the operator reads the reason
 * instead of a 400 that cost a round trip.
 */
export function parseRunInput(text: string): RunInputParse {
  const trimmed = text.trim();
  if (trimmed === "") {
    return {
      ok: false,
      reason: "invalid_json",
      message: "Enter a JSON object. Use {} to start the run with no business input.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_json",
      // The parser's own message carries the position, which is the useful part.
      message: `That is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const actual = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    return {
      ok: false,
      reason: "not_object",
      message: `Run input must be a JSON object; this is ${actual}. Atlas refuses any other root.`,
    };
  }

  return { ok: true, value: parsed as JsonObject };
}

/**
 * Whether `_resolve_path` would find this path, using exactly its rule.
 *
 * Every intermediate segment has to be a plain object with that key present
 * (`atlas/workflows.py:2178-2184`). An intermediate array or scalar is a miss, and so is a key
 * whose value is `null` at an intermediate level — but a `null` **leaf** is found, because Atlas
 * only requires the key to exist and renders it as the string `None`.
 */
export function resolvesInput(input: JsonObject, segments: string[]): boolean {
  let value: JsonValue = input;
  for (const segment of segments) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return false;
    value = (value as JsonObject)[segment]!;
  }
  return true;
}

export interface RunInputFinding {
  path: string;
  nodeIds: string[];
  message: string;
}

export interface RunInputPreflight {
  /** Paths the start worker renders. Missing one fails the run immediately, so this blocks. */
  blocking: RunInputFinding[];
  /** Paths only a later or conditional node renders. That node may never run, so this warns. */
  warnings: RunInputFinding[];
}

/**
 * Checks an already-parsed input object against the observed contract.
 *
 * The asymmetry between the two lists is the whole point. Anything the start worker needs is
 * provably rendered before a single branch decision is taken, so Atlas fails the run at once and
 * blocking is truthful. Anything else is reached only along a path this function cannot predict —
 * calling it required would invent a global requirement the graph does not have.
 */
export function preflightRunInput(
  contract: ObservedContract,
  input: JsonObject,
): RunInputPreflight {
  const blocking: RunInputFinding[] = [];
  const warnings: RunInputFinding[] = [];

  for (const observed of contract.inputPaths) {
    if (resolvesInput(input, observed.segments)) continue;
    const finding: RunInputFinding = {
      path: observed.path,
      nodeIds: observed.nodeIds,
      message: observed.referencedByStartWorker
        ? `The start node ${contract.startNodeId} renders {${observed.path}} before any branch is chosen, so Atlas fails this run as soon as it starts.`
        : `{${observed.path}} is referenced by ${observed.nodeIds.join(", ")}. Those nodes may not run on every path, so this is a risk rather than a known requirement — but if one of them does run without it, that node fails.`,
    };
    if (observed.referencedByStartWorker) blocking.push(finding);
    else warnings.push(finding);
  }

  return { blocking, warnings };
}

// ---------------------------------------------------------------------------
// Advisory documents and snippets
// ---------------------------------------------------------------------------

/**
 * Placeholders every generated snippet uses instead of real values.
 *
 * Nothing in this section may read the operator's entered test input, the deployment's Atlas
 * origin, the session cookie, or a bearer. Snippets are generated from the contract alone, which
 * is what makes "copy" and "download" safe to offer at all.
 */
export const SNIPPET_BASE_URL = "$ATLAS_BASE_URL";
export const SNIPPET_TOKEN = "$ATLAS_TOKEN";

/** The illustrative body a snippet posts: the skeleton, or `{}` when none can be generated. */
function snippetInput(contract: ObservedContract): JsonObject {
  return contract.skeleton ?? {};
}

/** Stable, pretty JSON with a trailing newline, so copy and download agree byte for byte. */
function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The advisory contract as JSON.
 *
 * `observed: true` and `enforced_by_atlas: false` are the first two keys on purpose: whatever
 * this file is pasted into, the reader meets the caveat before the data.
 */
export function contractJson(contract: ObservedContract): string {
  return stableJson({
    observed: true,
    enforced_by_atlas: false,
    note: "Derived by reading prompt text in a saved Atlas workflow graph. Not a schema. Types, defaults, requiredness across branches, and artifact presence are unknown.",
    workflow_definition_id: contract.workflowId,
    observed_workflow_version: contract.observedVersion,
    start_node: { id: contract.startNodeId, type: contract.startNodeKind },
    observed_input_paths: contract.inputPaths.slice(0, MAX_RENDERED_PATHS).map((path) => ({
      path: path.path,
      referenced_by: path.nodeIds,
      referenced_by_start_worker: path.referencedByStartWorker,
    })),
    /** How many paths this document omits. The dialog still checks every one of them. */
    observed_input_paths_omitted: Math.max(0, contract.inputPaths.length - MAX_RENDERED_PATHS),
    // Complete on purpose: this is the object that makes a run work, not a summary of it.
    illustrative_input: contract.skeleton,
    possible_outputs: contract.outputs.slice(0, MAX_RENDERED_OUTPUTS).map((output) => ({
      key: output.key,
      produced_by: output.nodeId,
      observed_kind: output.kind,
      guaranteed: false,
    })),
    possible_outputs_omitted: Math.max(0, contract.outputs.length - MAX_RENDERED_OUTPUTS),
    manager_prompt_references: contract.managerReferences,
    diagnostics: contract.diagnostics,
  });
}

/**
 * Where each value lives inside Atlas's response envelopes.
 *
 * Atlas wraps every one of these bodies, which `src/lib/atlas-api.server.ts` proves by asserting
 * the exact shapes: `POST /api/workflow-runs` answers `{run}`, `GET /api/workflow-runs/{id}`
 * answers `{run, nodes, edges, approvals}`, and `GET …/artifacts` answers `{artifacts}`. An
 * example that read `body.state` instead of `body.run.state` would poll forever, and its Python
 * twin would raise `KeyError` — neither of which a string-presence test can see.
 *
 * Exported as data so the snippets and the tests share one source of truth, and so the contract
 * suite can walk these paths against a live Atlas response rather than a hand-written fixture.
 */
export const SNIPPET_ENVELOPE = {
  /** `POST /api/workflow-runs` → the new run's id. */
  startRunId: ["run", "id"],
  /** `GET /api/workflow-runs/{id}` → the run's current state. */
  runState: ["run", "state"],
  /** `GET /api/workflow-runs/{id}/artifacts` → the artifact rows. */
  artifacts: ["artifacts"],
} as const satisfies Record<string, readonly string[]>;

/** `a.b.c` for a comment or a jq filter, from the same constant the code uses. */
function dotted(path: readonly string[]): string {
  return path.join(".");
}

function curlSnippet(contract: ObservedContract): string {
  const body = JSON.stringify(
    { workflow_definition_id: contract.workflowId, input: snippetInput(contract) },
    null,
    2,
  );
  return [
    `# Start a run. Atlas answers 202 with the run wrapped in an envelope:`,
    `#   {"run":{"id":"wfr_...","state":"queued", ...}}`,
    `RUN_ID=$(curl -sS --fail-with-body -X POST "${SNIPPET_BASE_URL}/api/workflow-runs" \\`,
    `  -H "Authorization: Bearer ${SNIPPET_TOKEN}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body.replaceAll("'", `'\\''`)}' \\`,
    `  | jq -r '.${dotted(SNIPPET_ENVELOPE.startRunId)}')`,
    ``,
    `# Poll until terminal. The detail body is {"run":…,"nodes":…,"edges":…,"approvals":…}.`,
    `curl -sS --fail-with-body "${SNIPPET_BASE_URL}/api/workflow-runs/$RUN_ID" \\`,
    `  -H "Authorization: Bearer ${SNIPPET_TOKEN}" | jq -r '.${dotted(SNIPPET_ENVELOPE.runState)}'`,
    ``,
    `# List what it produced: {"artifacts":[…]}.`,
    `curl -sS --fail-with-body "${SNIPPET_BASE_URL}/api/workflow-runs/$RUN_ID/artifacts" \\`,
    `  -H "Authorization: Bearer ${SNIPPET_TOKEN}" | jq '.${dotted(SNIPPET_ENVELOPE.artifacts)}'`,
    ``,
  ].join("\n");
}

function typescriptSnippet(contract: ObservedContract): string {
  return [
    `// Server-side only. The Atlas bearer must never reach browser JavaScript, a URL, or`,
    `// localStorage — anything that holds it can be read by anything running on the page.`,
    `const base = process.env.ATLAS_BASE_URL!;`,
    `const headers = {`,
    `  authorization: \`Bearer \${process.env.ATLAS_TOKEN!}\`,`,
    `  "content-type": "application/json",`,
    `};`,
    ``,
    `// Atlas reports failures as a JSON body with a non-2xx status, so the status is checked`,
    `// before the body is trusted — a 403 body has no "run" key to read.`,
    `async function call<T>(path: string, init?: RequestInit): Promise<T> {`,
    `  const response = await fetch(\`\${base}\${path}\`, { ...init, headers });`,
    `  if (!response.ok) {`,
    `    throw new Error(\`Atlas \${response.status} on \${path}: \${await response.text()}\`);`,
    `  }`,
    `  return (await response.json()) as T;`,
    `}`,
    ``,
    `// 202. Every Atlas response is wrapped; this one is { run: … }.`,
    `// There is no dedupe key on this route: two POSTs are two runs.`,
    `const { run } = await call<{ run: { id: string; state: string } }>("/api/workflow-runs", {`,
    `  method: "POST",`,
    `  body: JSON.stringify({`,
    `    workflow_definition_id: ${JSON.stringify(contract.workflowId)},`,
    `    input: ${JSON.stringify(snippetInput(contract), null, 4).replaceAll("\n", "\n    ")},`,
    `  }),`,
    `});`,
    ``,
    `// Atlas has no run-level event stream, so poll the run row. The detail envelope is`,
    `// { run, nodes, edges, approvals } — the state lives at body.run.state, not body.state.`,
    `const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);`,
    `let state = run.state;`,
    `while (!TERMINAL.has(state)) {`,
    `  await new Promise((resolve) => setTimeout(resolve, 2_000));`,
    `  const body = await call<{ run: { state: string }; approvals: Array<{ id: string }> }>(`,
    `    \`/api/workflow-runs/\${run.id}\`,`,
    `  );`,
    `  state = body.run.state;`,
    `  // "waiting_for_human" is not terminal: a gate in body.approvals needs a decision.`,
    `}`,
    ``,
    `const { artifacts } = await call<{ artifacts: Array<{ key: string; kind: string }> }>(`,
    `  \`/api/workflow-runs/\${run.id}/artifacts\`,`,
    `);`,
    ``,
  ].join("\n");
}

function pythonSnippet(contract: ObservedContract): string {
  return [
    `# Server-side only. Keep the bearer in the process environment, never in a client.`,
    `import json, os, time, urllib.error, urllib.request`,
    ``,
    `BASE = os.environ["ATLAS_BASE_URL"]`,
    `HEADERS = {`,
    `    "Authorization": f"Bearer {os.environ['ATLAS_TOKEN']}",`,
    `    "Content-Type": "application/json",`,
    `}`,
    ``,
    ``,
    `def call(path, payload=None):`,
    `    data = json.dumps(payload).encode() if payload is not None else None`,
    `    request = urllib.request.Request(f"{BASE}{path}", data=data, headers=HEADERS)`,
    `    try:`,
    `        with urllib.request.urlopen(request) as response:`,
    `            return json.load(response)`,
    `    except urllib.error.HTTPError as error:`,
    `        # A non-2xx body carries {"error": "..."} and no "run" key; fail loudly rather`,
    `        # than KeyError-ing three lines later.`,
    `        raise SystemExit(f"Atlas {error.code} on {path}: {error.read().decode()}") from error`,
    ``,
    ``,
    `# 202. Every Atlas response is wrapped; this one is {"run": ...}.`,
    `# No dedupe key on this route, so two calls are two runs.`,
    `run = call(`,
    `    "/api/workflow-runs",`,
    `    {`,
    `        "workflow_definition_id": ${JSON.stringify(contract.workflowId)},`,
    `        "input": ${JSON.stringify(snippetInput(contract), null, 4).replaceAll("\n", "\n        ")},`,
    `    },`,
    `)["run"]`,
    ``,
    `TERMINAL = {"succeeded", "failed", "cancelled"}`,
    `while run["state"] not in TERMINAL:`,
    `    time.sleep(2)`,
    `    # The detail envelope is {"run":…,"nodes":…,"edges":…,"approvals":…}.`,
    `    run = call(f"/api/workflow-runs/{run['id']}")["run"]`,
    `    # "waiting_for_human" is not terminal: approve via POST /api/approvals/{id}/approve.`,
    ``,
    `artifacts = call(f"/api/workflow-runs/{run['id']}/artifacts")["artifacts"]`,
    ``,
  ].join("\n");
}

/** Deciding a human gate. The approval id comes from the run detail envelope's `approvals`. */
function approvalSnippet(): string {
  return [
    `# A run parked in waiting_for_human has its open gates in the run detail envelope.`,
    `curl -sS --fail-with-body "${SNIPPET_BASE_URL}/api/workflow-runs/$RUN_ID" \\`,
    `  -H "Authorization: Bearer ${SNIPPET_TOKEN}" | jq '.approvals'`,
    ``,
    `# Approve it. Use /reject to fail the run instead.`,
    `curl -sS --fail-with-body -X POST \\`,
    `  "${SNIPPET_BASE_URL}/api/approvals/$APPROVAL_ID/approve" \\`,
    `  -H "Authorization: Bearer ${SNIPPET_TOKEN}"`,
    ``,
    `# A gate that declares choices refuses /approve — send the chosen id to /choose instead.`,
    `curl -sS --fail-with-body -X POST \\`,
    `  "${SNIPPET_BASE_URL}/api/approvals/$APPROVAL_ID/choose" \\`,
    `  -H "Authorization: Bearer ${SNIPPET_TOKEN}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"choice":"$CHOICE_ID"}'`,
    ``,
  ].join("\n");
}

/**
 * Receiving the optional signed callback.
 *
 * Atlas signs the **raw** request body with its `ATLAS_SECRET_KEY` and sends
 * `X-Atlas-Signature: sha256=<hex>` (`atlas/outbound.py:137,421`). Verification has to run over
 * the bytes as received: parsing to JSON and re-serialising changes key order and whitespace, and
 * the digest no longer matches. Compare in constant time.
 */
function webhookSnippet(): string {
  return [
    `// Express, server-side. Ask an Atlas operator for the value of ATLAS_SECRET_KEY; it is the`,
    `// same key Atlas signs with, so treat it exactly like a bearer.`,
    `import { createHmac, timingSafeEqual } from "node:crypto";`,
    `import express from "express";`,
    ``,
    `const app = express();`,
    ``,
    `// The RAW body, not a parsed one. Re-serialising JSON reorders keys and changes spacing,`,
    `// and the digest would never match again.`,
    `app.post("/hook", express.raw({ type: "application/json" }), (request, response) => {`,
    `  const expected =`,
    `    "sha256=" +`,
    `    createHmac("sha256", process.env.ATLAS_SECRET_KEY!).update(request.body).digest("hex");`,
    `  const received = String(request.get("X-Atlas-Signature") ?? "");`,
    ``,
    `  const a = Buffer.from(expected);`,
    `  const b = Buffer.from(received);`,
    `  // Length is checked first because timingSafeEqual throws on a mismatch.`,
    `  if (a.length !== b.length || !timingSafeEqual(a, b)) {`,
    `    return response.status(401).send("bad signature");`,
    `  }`,
    ``,
    `  const delivery = JSON.parse(request.body.toString("utf8"));`,
    `  // Acknowledge fast; Atlas retries on a non-2xx. Do the real work out of band.`,
    `  response.status(204).end();`,
    `  void handle(delivery);`,
    `});`,
    ``,
    `// Ask for it per run with:`,
    `//   input._meta.reply = { mode: "webhook", callback_url: "$YOUR_CALLBACK_URL" }`,
    `// The URL must be on Atlas's outbound allowlist, and must not embed credentials.`,
    ``,
  ].join("\n");
}

export interface ContractSnippets {
  curl: string;
  typescript: string;
  python: string;
  approval: string;
  webhook: string;
}

export function contractSnippets(contract: ObservedContract): ContractSnippets {
  return {
    curl: curlSnippet(contract),
    typescript: typescriptSnippet(contract),
    python: pythonSnippet(contract),
    approval: approvalSnippet(),
    webhook: webhookSnippet(),
  };
}

export function contractMarkdown(contract: ObservedContract): string {
  const lines: string[] = [
    `# Observed integration contract`,
    ``,
    `> **Observed, not enforced by Atlas.** Everything below was derived by reading prompt text`,
    `> in a saved workflow graph. Atlas stores no input schema for this workflow, so it validates`,
    `> only that \`input\` is a JSON object. Types, defaults, which fields are required on which`,
    `> branch, and whether any artifact is produced are all unknown.`,
    ``,
    `- Workflow: \`${contract.workflowId}\``,
    `- Observed version: ${contract.observedVersion} (nothing pins a run to this version)`,
    `- Start node: \`${contract.startNodeId}\`${contract.startNodeKind ? ` (${contract.startNodeKind})` : ""}`,
    ``,
    `## Atlas API facts`,
    ``,
    `| | |`,
    `| --- | --- |`,
    `| Start a run | \`POST /api/workflow-runs\` with \`{"workflow_definition_id", "input"}\` |`,
    `| Response | \`202\` and the real run row, whose \`id\` is \`wfr_…\` |`,
    `| Progress | Poll \`GET /api/workflow-runs/{id}\`; there is no run-level event stream |`,
    `| Outputs | \`GET /api/workflow-runs/{id}/artifacts\` |`,
    `| Waiting states | \`queued\`, \`running\`, \`paused\`, \`waiting_for_human\`, \`recovery_required\` |`,
    `| Terminal states | \`succeeded\`, \`failed\`, \`cancelled\` |`,
    `| Approvals | \`POST /api/approvals/{id}/approve\`, \`/reject\`, or \`/choose\` |`,
    `| Reply webhook | Optional, via \`input._meta.reply\`; Atlas signs the callback |`,
    `| Duplicate protection | **None on this route.** Two POSTs are two runs. A trigger \`POST /api/workflow-triggers/{id}/fire\` does support a dedupe key |`,
    ``,
    `## Observed input paths`,
    ``,
  ];

  if (contract.inputPaths.length === 0) {
    lines.push(`No \`{input.*}\` reference was found in any executable prompt.`, ``);
  } else {
    lines.push(`| Path | Referenced by | Rendered by the start worker |`, `| --- | --- | --- |`);
    for (const path of contract.inputPaths.slice(0, MAX_RENDERED_PATHS)) {
      lines.push(
        `| \`${path.path}\` | ${path.nodeIds.map((id) => `\`${id}\``).join(", ")} | ${path.referencedByStartWorker ? "yes" : "no"} |`,
      );
    }
    const omitted = contract.inputPaths.length - MAX_RENDERED_PATHS;
    if (omitted > 0) {
      lines.push(
        ``,
        `This table is capped at ${MAX_RENDERED_PATHS} rows; **${omitted} further path${omitted === 1 ? "" : "s"}** are`,
        `referenced and omitted here. The Test run dialog checks all of them regardless.`,
      );
    }
    lines.push(
      ``,
      `A path rendered by the start worker fails the run immediately when it is absent. Every`,
      `other path belongs to a node that may never execute, so its absence is a risk, not a`,
      `known requirement.`,
      ``,
    );
  }

  lines.push(`## Possible outputs`, ``);
  if (contract.outputs.length === 0) {
    lines.push(`No worker node declares an output artifact key.`, ``);
  } else {
    lines.push(`| Key | Produced by | Observed kind |`, `| --- | --- | --- |`);
    for (const output of contract.outputs.slice(0, MAX_RENDERED_OUTPUTS)) {
      lines.push(`| \`${output.key}\` | \`${output.nodeId}\` | ${output.kind} |`);
    }
    lines.push(
      ``,
      `Every row is **possible**, never guaranteed: the producing node runs only on the branch`,
      `Atlas takes, and only a successful run writes the artifact. \`collect_files\` patterns are`,
      `deliberately absent — which files match is discovered while the worker runs, so no file`,
      `artifact key can be known in advance.`,
      ``,
    );
  }

  if (contract.diagnostics.length > 0) {
    lines.push(`## Diagnostics`, ``);
    for (const diagnostic of contract.diagnostics) {
      lines.push(`- **${diagnostic.severity}** — ${diagnostic.message}`);
    }
    lines.push(``);
  }

  lines.push(
    `## Limitations`,
    ``,
    `- No Atlas-enforced schema. Atlas cannot reject bad business input before creating a run.`,
    `- No version pin. \`POST /api/workflow-runs\` has no \`expected_workflow_version\`, so an`,
    `  edit between reading this and calling it is not detected.`,
    `- Branch-dependent. A path or an artifact seen here belongs to one possible route.`,
    `- No types. Prompt text cannot show whether a value should be a string, a number, or a list.`,
    `- \`attachments\`-style fields in JSON are text or metadata, never an uploaded file. Atlas's`,
    `  \`POST /api/workflow-runs/{id}/files\` needs a run that already exists, so it cannot stage`,
    `  binary input for the start node.`,
    ``,
  );

  return `${lines.join("\n")}`;
}
