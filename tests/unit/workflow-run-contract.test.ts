/**
 * The observed run contract: grammar, inference, and the truthfulness rules.
 *
 * The grammar cases are transcribed from a run of Atlas's own `_FIELD_RE`
 * (`atlas/workflows.py:31`) against the same strings, so this file is a parity check and not a
 * restatement of what the implementation happens to do. Where a case is about Atlas's *executable*
 * behaviour rather than its regex — a manager prompt, `collect_files` — the assertion names the
 * source line it is derived from.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  contractJson,
  contractMarkdown,
  contractSnippets,
  extractPlaceholders,
  MAX_RENDERED_PATHS,
  observeWorkflowContract,
  parseRunInput,
  preflightRunInput,
  resolvesInput,
  SNIPPET_BASE_URL,
  SNIPPET_ENVELOPE,
  SNIPPET_TOKEN,
  type ObservedContract,
} from "@/lib/workflow-run-contract";
import { parseWorkflowGraph, type JsonObject, type WorkflowGraph } from "@/lib/workflow-graph";

function graphOf(raw: unknown): WorkflowGraph {
  const parsed = parseWorkflowGraph(raw);
  if (!parsed.ok) throw new Error(`fixture does not parse: ${parsed.reason}`);
  return parsed.value;
}

function observe(raw: unknown, version = 3): ObservedContract {
  return observeWorkflowContract(graphOf(raw), {
    workflowId: "wfd_test",
    observedVersion: version,
  });
}

/** One worker as the start node, with whatever prompt the case is about. */
function oneWorker(prompt: string, extra: Record<string, unknown> = {}) {
  return {
    start: "start",
    nodes: [{ id: "start", type: "worker", prompt, ...extra }],
    edges: [],
  };
}

describe("Atlas placeholder grammar", () => {
  // Each expectation was produced by running Atlas's own compiled `_FIELD_RE` over the same
  // string. A divergence here is a divergence from the executor.
  it.each([
    ["{input.a}", ["input.a"]],
    ["{input.a.b}", ["input.a.b"]],
    ["{input.a.b.c}", ["input.a.b.c"]],
    // The inner group is `+`: a bare root carries no dot and is not a placeholder at all.
    ["{input}", []],
    // `{files_dir}` is substituted by a separate string replace (`atlas/workflows.py:1623`),
    // precisely because the dotted grammar cannot see it.
    ["{files_dir}", []],
    // No array index in the grammar. Atlas sends these characters through untouched.
    ["{input.items[0]}", []],
    // A segment must start with an ASCII letter or underscore.
    ["{input.1bad}", []],
    ["{input.a-b}", []],
    ["{input.a.}", []],
    // Python's `\w` is Unicode-aware, so a non-ASCII letter *inside* a segment matches.
    ["{input.a_ก}", ["input.a_ก"]],
    // ...but it cannot start one, and Thai vowel signs are combining marks, which end a segment.
    ["{input.ชื่อ}", []],
    ["{Input.A9_z}", ["Input.A9_z"]],
    // A JSON example in a prompt is not a placeholder; Atlas leaves it, and so does this.
    ['{"verdict":"ok"}', []],
    ["{a.b.c.d}", ["a.b.c.d"]],
  ])("matches Atlas on %j", (template, expected) => {
    expect(extractPlaceholders(template)).toEqual(expected);
  });

  it("finds every distinct placeholder in one prompt, in first-appearance order", () => {
    expect(extractPlaceholders("{input.b} then {input.a} then {input.b} and {artifact.x}")).toEqual(
      ["input.b", "input.a", "artifact.x"],
    );
  });
});

describe("root selection", () => {
  it("keeps only the input root and ignores the four Atlas resolves from run state", () => {
    const contract = observe(
      oneWorker("{input.topic} {artifact.notes} {run.id} {node.id} {job.previous}"),
    );
    expect(contract.inputPaths.map((path) => path.path)).toEqual(["input.topic"]);
    // Those four are not diagnostics either: they are correct, they are simply not run input.
    expect(contract.diagnostics).toEqual([]);
  });

  it("reports a root Atlas cannot resolve, because rendering it fails the node", () => {
    const contract = observe(oneWorker("{payload.topic}"));
    expect(contract.inputPaths).toEqual([]);
    expect(contract.diagnostics).toEqual([
      expect.objectContaining({ code: "unknown_placeholder_root", severity: "error" }),
    ]);
    expect(contract.diagnostics[0]!.message).toContain("unknown prompt variable");
  });

  it("says nothing at all about a graph with no placeholders", () => {
    const contract = observe(oneWorker("Summarise the attached material."));
    expect(contract.inputPaths).toEqual([]);
    expect(contract.diagnostics).toEqual([]);
    expect(contract.skeleton).toEqual({});
  });
});

describe("paths, duplicates, and consumers", () => {
  it("deduplicates a path while retaining every consuming node", () => {
    const contract = observe({
      start: "a",
      nodes: [
        { id: "a", type: "worker", prompt: "{input.topic} {input.topic}" },
        { id: "b", type: "worker", prompt: "again {input.topic}" },
        { id: "c", type: "worker", prompt: "no reference" },
      ],
      edges: [
        { from: "a", to: "b", condition: { type: "always" } },
        { from: "b", to: "c", condition: { type: "always" } },
      ],
    });

    expect(contract.inputPaths).toHaveLength(1);
    expect(contract.inputPaths[0]!.nodeIds).toEqual(["a", "b"]);
  });

  it("keeps nested paths as segments and builds a nested illustrative object", () => {
    const contract = observe(
      oneWorker("{input.applicant.name} and {input.applicant.address.city}"),
    );

    expect(contract.inputPaths.map((path) => path.segments)).toEqual([
      ["applicant", "name"],
      ["applicant", "address", "city"],
    ]);
    expect(contract.skeleton).toEqual({
      applicant: {
        name: "<input.applicant.name>",
        address: { city: "<input.applicant.address.city>" },
      },
    });
  });

  it("marks a start-worker reference apart from a downstream one", () => {
    const contract = observe({
      start: "a",
      nodes: [
        { id: "a", type: "worker", prompt: "{input.needed_now}" },
        { id: "b", type: "worker", prompt: "{input.maybe_later}" },
      ],
      edges: [{ from: "a", to: "b", condition: { type: "always" } }],
    });

    expect(contract.inputPaths).toEqual([
      expect.objectContaining({ path: "input.needed_now", referencedByStartNode: true }),
      expect.objectContaining({ path: "input.maybe_later", referencedByStartNode: false }),
    ]);
  });
});

/**
 * A parent and its child are both satisfiable from one object — verified against Atlas.
 *
 * `_prompt_value` (`atlas/workflows.py:2193`) JSON-encodes a dict, so with
 * `{"user":{"name":"Alice"}}` the prompt `{input.user}` renders `{"name":"Alice"}` and
 * `{input.user.name}` renders `Alice`. Both succeed from the same input. An earlier revision of
 * this module called that an unsatisfiable collision and refused to generate an example; it was
 * wrong, and the nested object is the answer that serves both.
 */
describe("parent and child paths", () => {
  it.each([
    ["parent first", "{input.user} then {input.user.name}"],
    ["child first", "{input.user.name} then {input.user}"],
  ])("builds one nested skeleton that satisfies both (%s)", (_order, prompt) => {
    const contract = observe(oneWorker(prompt));

    // The nested object is what Atlas needs: the child resolves, and the parent renders it.
    expect(contract.skeleton).toEqual({ user: { name: "<input.user.name>" } });
    expect(contract.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("notes that the parent renders as JSON, without calling it a problem", () => {
    const contract = observe(oneWorker("{input.user} then {input.user.name}"));
    const note = contract.diagnostics.find((entry) => entry.code === "parent_path_renders_json");

    expect(note).toMatchObject({ severity: "note" });
    expect(note!.message).toContain("input.user");
  });

  it("accepts an object at the parent when preflighting both paths", () => {
    const contract = observe(oneWorker("{input.user} and {input.user.name}"));
    expect(preflightRunInput(contract, { user: { name: "Alice" } })).toEqual({
      blocking: [],
      warnings: [],
    });
  });

  it("compares segments, so a shared string prefix is not nesting", () => {
    const contract = observe(oneWorker("{input.user} and {input.username}"));
    expect(contract.diagnostics).toEqual([]);
    expect(contract.skeleton).toEqual({
      user: "<input.user>",
      username: "<input.username>",
    });
  });
});

/**
 * `__proto__` is an ordinary dict key to Atlas — Python has no prototype chain — so the grammar
 * matches it and a caller could legitimately supply it. What must never happen is this module
 * walking or writing through JavaScript's prototype chain while building the example object.
 */
describe("prototype safety", () => {
  const pristine = () => Object.getOwnPropertyNames(Object.prototype).sort().join(",");

  it.each([
    ["as an intermediate segment", "{input.__proto__.atlasPolluted}", ["__proto__"]],
    ["as a leaf", "{input.a.__proto__}", ["a"]],
    ["as a repeated segment", "{input.__proto__.__proto__.x}", ["__proto__"]],
    ["via constructor.prototype", "{input.constructor.prototype.atlasPolluted}", ["constructor"]],
  ])("does not touch Object.prototype %s", (_name, prompt, topKeys) => {
    const before = pristine();
    const contract = observe(oneWorker(prompt));

    // Nothing leaked onto the shared prototype...
    expect(pristine()).toBe(before);
    expect(({} as Record<string, unknown>).atlasPolluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();

    // ...and the path is still represented as a real own property of the example.
    expect(contract.skeleton).not.toBeNull();
    expect(Object.keys(contract.skeleton!)).toEqual(topKeys);
  });

  it("keeps a __proto__ key serialisable, so the dialog can still show it", () => {
    const contract = observe(oneWorker("{input.__proto__.atlasPolluted}"));
    const json = JSON.stringify(contract.skeleton);

    expect(json).toBe('{"__proto__":{"atlasPolluted":"<input.__proto__.atlasPolluted>"}}');
    // And it round-trips back to something whose own property is intact.
    expect(Object.keys(JSON.parse(json))).toEqual(["__proto__"]);
  });

  it("resolves a __proto__ path only from an own property", () => {
    // `{}` inherits `__proto__` through the chain; Atlas would report it missing, so must we.
    expect(resolvesInput({}, ["__proto__"])).toBe(false);
    expect(resolvesInput({}, ["constructor", "prototype"])).toBe(false);
    expect(resolvesInput(JSON.parse('{"__proto__":{"a":1}}'), ["__proto__", "a"])).toBe(true);
  });
});

describe("malformed and unsupported placeholder text", () => {
  it("reports array-index syntax as unsupported without rewriting the prompt", () => {
    const contract = observe(oneWorker("{input.items[0]}"));

    expect(contract.inputPaths).toEqual([]);
    expect(contract.diagnostics).toEqual([
      expect.objectContaining({ code: "unsupported_placeholder", severity: "note" }),
    ]);
    expect(contract.diagnostics[0]!.message).toContain("unchanged");
  });

  it("does not mistake a JSON example in a prompt for a broken placeholder", () => {
    const contract = observe(oneWorker('Return exactly {"verdict":"ok"} and nothing else.'));
    expect(contract.diagnostics).toEqual([]);
  });
});

describe("manager prompts (requalified after Atlas's manager-prompt-parity fix)", () => {
  // `_manager_prompt` (`atlas/workflows.py:2249`, Atlas checkout
  // `15c4876aa4f86e109a3cc52d6a299f46791053a2`) now renders through `render_prompt` first, exactly
  // like a worker's prompt — so a manager's `{input.*}` is executable and fail-closed the same way.
  const managerGraph = {
    start: "a",
    nodes: [
      { id: "a", type: "worker", prompt: "{input.topic}" },
      { id: "m", type: "manager", schema: "manager_decision_v1", prompt: "Decide on {input.mode}" },
      { id: "b", type: "worker", prompt: "done" },
    ],
    edges: [
      { from: "a", to: "m", condition: { type: "always" } },
      { from: "m", to: "b", condition: { type: "manager_selected", target: "b" } },
    ],
  };

  it("lists a downstream manager's {input.*} as an observed input path, not a special bucket", () => {
    const contract = observe(managerGraph);

    expect(contract.inputPaths.map((path) => path.path)).toEqual(["input.topic", "input.mode"]);
    expect(contract.diagnostics.find((entry) => entry.severity === "warning")).toBeUndefined();
  });

  it("marks a downstream manager's reference as a warning, not blocking — it may never run", () => {
    const contract = observe(managerGraph);
    const modePath = contract.inputPaths.find((path) => path.path === "input.mode");

    expect(modePath).toMatchObject({ nodeIds: ["m"], referencedByStartNode: false });
    // Now genuinely executable, so it belongs in the illustrative example.
    expect(contract.skeleton).toEqual({ topic: "<input.topic>", mode: "<input.mode>" });
  });

  it("blocks preflight when the graph's start node is a manager missing a referenced path", () => {
    const contract = observe({
      start: "m",
      nodes: [
        {
          id: "m",
          type: "manager",
          schema: "manager_decision_v1",
          prompt: "Decide on {input.mode}",
        },
        { id: "b", type: "worker", prompt: "done" },
      ],
      edges: [{ from: "m", to: "b", condition: { type: "manager_selected", target: "b" } }],
    });

    const startPath = contract.inputPaths.find((path) => path.path === "input.mode");
    expect(startPath).toMatchObject({ referencedByStartNode: true });

    const preflight = preflightRunInput(contract, {});
    expect(preflight.blocking).toHaveLength(1);
    expect(preflight.blocking[0]!.path).toBe("input.mode");
    expect(preflight.warnings).toEqual([]);
  });

  it("treats an unresolvable root inside a manager prompt as an error, same as a worker's", () => {
    // `render_prompt` now raises "unknown prompt variable" for this exactly like it would for a
    // worker — reporting it as a note (or nothing) would be false after the parity fix.
    const contract = observe({
      start: "m",
      nodes: [{ id: "m", type: "manager", schema: "manager_decision_v1", prompt: "{payload.x}" }],
      edges: [],
    });
    expect(contract.diagnostics).toEqual([
      expect.objectContaining({ code: "unknown_placeholder_root", severity: "error" }),
    ]);
  });
});

describe("possible outputs", () => {
  it("reads outputs[0] and derives kind from output_format", () => {
    const contract = observe({
      start: "a",
      nodes: [
        { id: "a", type: "worker", prompt: "x", outputs: ["structured"], output_format: "json" },
        { id: "b", type: "worker", prompt: "y", outputs: ["prose"] },
        { id: "c", type: "worker", prompt: "z" },
        { id: "j", type: "join", mode: "all" },
      ],
      edges: [
        { from: "a", to: "b", condition: { type: "always" } },
        { from: "b", to: "c", condition: { type: "always" } },
        { from: "c", to: "j", condition: { type: "always" } },
      ],
    });

    expect(contract.outputs).toEqual([
      { key: "structured", nodeId: "a", kind: "json" },
      // No `output_format` means Atlas stores whatever text the worker returned.
      { key: "prose", nodeId: "b", kind: "text" },
    ]);
  });

  it("never infers a file output from collect_files", () => {
    // Which files match is discovered while the worker runs, so no key can be known up front.
    const contract = observe(
      oneWorker("x", { collect_files: ["reports/*.md", "out/**/*.json"], outputs: ["only_this"] }),
    );

    expect(contract.outputs).toEqual([{ key: "only_this", nodeId: "start", kind: "text" }]);
    expect(contractJson(contract)).not.toContain("reports/");
  });

  it("marks every possible output as not guaranteed in the generated contract", () => {
    const contract = observe(oneWorker("x", { outputs: ["review"] }));
    expect(JSON.parse(contractJson(contract)).possible_outputs).toEqual([
      { key: "review", produced_by: "start", observed_kind: "text", guaranteed: false },
    ]);
  });
});

describe("generated documents are deterministic and safe", () => {
  const contract = observe(
    oneWorker("Review {input.applicant.name} for {input.permit_type}", { outputs: ["review"] }),
  );

  it("produces byte-identical output for the same graph", () => {
    const again = observe(
      oneWorker("Review {input.applicant.name} for {input.permit_type}", { outputs: ["review"] }),
    );
    expect(contractJson(again)).toBe(contractJson(contract));
    expect(contractMarkdown(again)).toBe(contractMarkdown(contract));
    expect(contractSnippets(again)).toEqual(contractSnippets(contract));
  });

  it("labels itself observed and not enforced, in both formats", () => {
    const parsed = JSON.parse(contractJson(contract));
    expect(parsed.observed).toBe(true);
    expect(parsed.enforced_by_atlas).toBe(false);
    expect(contractMarkdown(contract)).toContain("Observed, not enforced by Atlas");
  });

  it("never claims a type, a default, or an enforced schema", () => {
    const everything = [
      contractJson(contract),
      contractMarkdown(contract),
      ...Object.values(contractSnippets(contract)),
    ].join("\n");

    for (const forbidden of ["OpenAPI", "JSON Schema", "authoritative", "type-safe", "validated"]) {
      expect(everything).not.toContain(forbidden);
    }
  });

  it("uses only placeholders for the origin and the bearer", () => {
    const snippets = contractSnippets(contract);
    for (const snippet of Object.values(snippets)) {
      expect(snippet).not.toMatch(/https?:\/\/(?!\$)/);
    }
    expect(snippets.curl).toContain(SNIPPET_BASE_URL);
    expect(snippets.curl).toContain(SNIPPET_TOKEN);
    expect(snippets.typescript).toContain("process.env.ATLAS_TOKEN");
    expect(snippets.python).toContain(`os.environ['ATLAS_TOKEN']`);
  });

  it("tells a backend author to keep the bearer out of the browser", () => {
    expect(contractSnippets(contract).typescript).toContain("never reach browser JavaScript");
  });

  it("states the direct-run dedupe gap and points at the trigger route that has one", () => {
    expect(contractMarkdown(contract)).toContain("Two POSTs are two runs");
    expect(contractMarkdown(contract)).toContain("/fire");
  });

  it("says a JSON attachments field is not a file upload", () => {
    const markdown = contractMarkdown(contract);
    expect(markdown).toContain("never an uploaded file");
    expect(markdown).toContain("cannot stage");
  });

  it("posts the illustrative skeleton, never a real value", () => {
    const snippets = contractSnippets(contract);
    // The three that actually carry a request body. `approval` and `webhook` are workflow-
    // independent by nature and embed no input at all.
    for (const key of ["curl", "typescript", "python"] as const) {
      expect(snippets[key], key).toContain("<input.applicant.name>");
    }
  });

  it("posts an empty body when the graph references no input", () => {
    const none = observe(oneWorker("Do the thing."));
    expect(none.skeleton).toEqual({});
    expect(contractSnippets(none).curl).toContain(`"input": {}`);
  });

  it("posts a nested body that satisfies a parent and its child together", () => {
    const nested = observe(oneWorker("{input.user} {input.user.name}"));
    expect(contractSnippets(nested).curl).toContain(`"name": "<input.user.name>"`);
  });
});

/**
 * A source-level tripwire, not a behavioural test.
 *
 * The Test Run surface is the obvious place for someone to "just call Atlas directly" — it is
 * about an API, its Integration tab is full of endpoint paths, and the temptation to make the
 * examples runnable in the browser is real. These files must keep going through the existing
 * typed server function, so the bearer stays in the httpOnly cookie and never enters the bundle.
 */
describe("no browser-side Atlas transport", () => {
  const clientFiles = [
    "src/lib/workflow-run-contract.ts",
    "src/components/atlas/workflow-test-run-dialog.tsx",
  ];

  /**
   * Source with comments removed.
   *
   * These files *document* the things they must not do — "no localStorage", "never reach browser
   * JavaScript" — so a scan over raw text would flag the rule as a violation of itself.
   */
  const codeOf = (path: string) =>
    readFileSync(path, "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/^\s*\/\/.*$/gm, "");

  it.each(clientFiles)("%s imports no server-only module", (path) => {
    const source = codeOf(path);
    expect(source).not.toMatch(/from\s+["'][^"']*\.server["']/);
    expect(source).not.toMatch(/import\(\s*["'][^"']*\.server["']/);
  });

  /**
   * The contract module's whole import list, which is the strongest statement available: a
   * module that imports one pure sibling has nothing to call and nothing to leak. A scan for
   * `fetch(` cannot serve here, because `fetch` legitimately appears as *text* inside the
   * backend snippets the Integration tab hands to an application author.
   */
  it("keeps the contract module pure", () => {
    const source = readFileSync("src/lib/workflow-run-contract.ts", "utf8");
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["'];$/gm)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(["./workflow-graph"]);
  });

  it("opens no connection and reads no environment from the dialog", () => {
    const source = codeOf("src/components/atlas/workflow-test-run-dialog.tsx");
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/\bnew\s+(XMLHttpRequest|EventSource|WebSocket)\b/);
    expect(source).not.toMatch(/ATLAS_API_ORIGIN|import\.meta\.env|process\.env/);
  });

  it("persists nothing the operator typed", () => {
    const source = codeOf("src/components/atlas/workflow-test-run-dialog.tsx");
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
  });

  it("starts runs through the existing typed mutation, not a new path", () => {
    const route = readFileSync("src/routes/_app/workflows.$id.tsx", "utf8");
    expect(route).toContain("useStartRun");
    // Whitespace-tolerant: the shape that matters is `workflowDefinitionId` and `input` reaching
    // `startRun.mutate` (plus, in declared mode, `expectedWorkflowVersion`), not how Prettier
    // chose to wrap it.
    expect(route).toMatch(/startRun\.mutate\(\s*\{\s*workflowDefinitionId:\s*id,\s*input,/);
    expect(route).toContain("expectedWorkflowVersion");
  });
});

/**
 * Bounding what is *rendered* must never bound what is *checked*.
 *
 * An earlier revision truncated `inputPaths` itself, so a graph whose start worker referenced
 * more paths than the display cap became startable once the visible ones were supplied — the
 * preflight simply could not see the rest, and Atlas failed the run on a field the UI had
 * declared satisfied.
 */
describe("many observed paths", () => {
  const FIELDS = 201;
  const manyPaths = oneWorker(
    Array.from({ length: FIELDS }, (_, index) => `{input.field_${index}}`).join(" "),
  );

  it("keeps every path available to the preflight", () => {
    const contract = observe(manyPaths);
    expect(contract.inputPaths).toHaveLength(FIELDS);
  });

  it("still blocks on an omitted start-worker path beyond the display cap", () => {
    const contract = observe(manyPaths);
    // Everything the display would have shown, and nothing more.
    const supplied: JsonObject = {};
    for (let index = 0; index < MAX_RENDERED_PATHS; index += 1) {
      supplied[`field_${index}`] = "x";
    }

    const result = preflightRunInput(contract, supplied);
    expect(result.blocking.map((finding) => finding.path)).toEqual(
      Array.from(
        { length: FIELDS - MAX_RENDERED_PATHS },
        (_, i) => `input.field_${MAX_RENDERED_PATHS + i}`,
      ),
    );
  });

  it("is satisfied only once every path is supplied", () => {
    const contract = observe(manyPaths);
    const supplied: JsonObject = {};
    for (let index = 0; index < FIELDS; index += 1) supplied[`field_${index}`] = "x";

    expect(preflightRunInput(contract, supplied).blocking).toEqual([]);
  });

  it("bounds the rendered document and says how much was omitted", () => {
    const contract = observe(manyPaths);
    const parsed = JSON.parse(contractJson(contract));

    expect(parsed.observed_input_paths).toHaveLength(MAX_RENDERED_PATHS);
    expect(parsed.observed_input_paths_omitted).toBe(FIELDS - MAX_RENDERED_PATHS);
    expect(contractMarkdown(contract)).toContain(`${FIELDS - MAX_RENDERED_PATHS} further path`);
  });

  it("keeps the example object complete, because it is what makes the run work", () => {
    const contract = observe(manyPaths);
    expect(Object.keys(contract.skeleton!)).toHaveLength(FIELDS);
  });
});

/**
 * The generated examples must unwrap Atlas's real envelopes.
 *
 * Atlas wraps every one of these responses — `{run}`, `{run,nodes,edges,approvals}`,
 * `{artifacts}` — which `src/lib/atlas-api.server.ts` proves by asserting those exact shapes.
 * An example that reads `body.state` instead of `body.run.state` polls forever, and the Python
 * equivalent raises `KeyError`. String-presence assertions cannot catch that, so the access
 * paths are exported as data, checked here against representative wire bodies, and rendered
 * into the snippets from the same constants. `tests/contract` walks them against a live Atlas.
 */
describe("generated examples match Atlas's wire envelopes", () => {
  const startBody = { run: { id: "wfr_abc", state: "queued" } };
  const detailBody = {
    run: { id: "wfr_abc", state: "succeeded" },
    nodes: [],
    edges: [],
    approvals: [],
  };
  const artifactsBody = { artifacts: [{ id: "art_1", key: "review", kind: "text" }] };

  const walk = (body: unknown, path: readonly string[]) =>
    path.reduce<unknown>(
      (value, key) =>
        value !== null && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined,
      body,
    );

  it("resolves every exported access path against a representative body", () => {
    expect(walk(startBody, SNIPPET_ENVELOPE.startRunId)).toBe("wfr_abc");
    expect(walk(detailBody, SNIPPET_ENVELOPE.runState)).toBe("succeeded");
    expect(walk(artifactsBody, SNIPPET_ENVELOPE.artifacts)).toEqual(artifactsBody.artifacts);
  });

  it("never reads the run row off the top level, which is the bug this replaced", () => {
    expect(walk(startBody, ["id"])).toBeUndefined();
    expect(walk(detailBody, ["state"])).toBeUndefined();
    expect(SNIPPET_ENVELOPE.startRunId[0]).toBe("run");
    expect(SNIPPET_ENVELOPE.runState[0]).toBe("run");
  });

  it("renders those paths into every snippet", () => {
    const contract = observe(oneWorker("x", { outputs: ["review"] }));
    const snippets = contractSnippets(contract);

    expect(snippets.typescript).toContain("body.run");
    expect(snippets.typescript).not.toMatch(/=\s*\(await started\.json\(\)\) as \{ id/);
    expect(snippets.python).toContain('["run"]');
    expect(snippets.python).toContain('["artifacts"]');
    expect(snippets.curl).toContain(".run.id");
  });

  it("checks the HTTP status before trusting a body", () => {
    const snippets = contractSnippets(observe(oneWorker("x")));
    expect(snippets.typescript).toContain("response.ok");
    expect(snippets.python).toContain("HTTPError");
  });
});

describe("run input parsing", () => {
  it("accepts an object", () => {
    expect(parseRunInput('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("accepts an empty object", () => {
    expect(parseRunInput("{}")).toEqual({ ok: true, value: {} });
  });

  it.each([
    ["[]", "an array"],
    ['["a"]', "an array"],
    ['"text"', "string"],
    ["12", "number"],
    ["true", "boolean"],
    ["null", "null"],
  ])("refuses %s as a root because Atlas requires an object", (text, described) => {
    const result = parseRunInput(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not_object");
    expect(result.message).toContain(described);
  });

  it("refuses malformed JSON and keeps the parser's own message", () => {
    const result = parseRunInput("{ oops");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid_json");
    expect(result.message).toContain("not valid JSON");
  });

  it("treats an empty textarea as invalid and suggests the empty object", () => {
    const result = parseRunInput("   ");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("{}");
  });
});

describe("path resolution mirrors Atlas's _resolve_path", () => {
  it("requires every intermediate segment to be a plain object", () => {
    expect(resolvesInput({ a: { b: 1 } }, ["a", "b"])).toBe(true);
    // An intermediate scalar or array is a miss (`atlas/workflows.py:2181`).
    expect(resolvesInput({ a: 1 }, ["a", "b"])).toBe(false);
    expect(resolvesInput({ a: [{ b: 1 }] }, ["a", "b"])).toBe(false);
    expect(resolvesInput({}, ["a"])).toBe(false);
  });

  it("finds a null leaf, because Atlas only needs the key to exist", () => {
    expect(resolvesInput({ a: null }, ["a"])).toBe(true);
    expect(resolvesInput({ a: null }, ["a", "b"])).toBe(false);
  });
});

describe("preflight", () => {
  const contract = observe({
    start: "a",
    nodes: [
      { id: "a", type: "worker", prompt: "{input.needed_now}" },
      { id: "b", type: "worker", prompt: "{input.maybe_later}" },
    ],
    edges: [{ from: "a", to: "b", condition: { type: "always" } }],
  });

  it("blocks on a start-worker path, because Atlas fails the run at once", () => {
    const result = preflightRunInput(contract, { maybe_later: "x" });

    expect(result.blocking).toEqual([
      expect.objectContaining({ path: "input.needed_now", nodeIds: ["a"] }),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.blocking[0]!.message).toContain("before any branch is chosen");
  });

  it("only warns on a downstream path, and says why it is not a requirement", () => {
    const result = preflightRunInput(contract, { needed_now: "x" });

    expect(result.blocking).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ path: "input.maybe_later", nodeIds: ["b"] }),
    ]);
    expect(result.warnings[0]!.message).toContain("may not run on every path");
    expect(result.warnings[0]!.message).not.toContain("required");
  });

  it("is silent when everything resolves", () => {
    expect(preflightRunInput(contract, { needed_now: 1, maybe_later: 2 })).toEqual({
      blocking: [],
      warnings: [],
    });
  });

  it("blocks on a start-manager reference too, after the manager-prompt-parity fix", () => {
    // Requalified: a manager's `{input.*}` is executable exactly like a worker's since Atlas
    // checkout 15c4876, so a start *manager* missing a referenced path fails the run just as
    // immediately as a start *worker* would — see the "manager prompts" describe block below.
    const managerStart = observe({
      start: "a",
      nodes: [
        { id: "a", type: "manager", schema: "manager_decision_v1", prompt: "{input.mode}" },
        { id: "b", type: "worker", prompt: "x" },
      ],
      edges: [{ from: "a", to: "b", condition: { type: "manager_selected", target: "b" } }],
    });

    expect(preflightRunInput(managerStart, {})).toEqual({
      blocking: [expect.objectContaining({ path: "input.mode", nodeIds: ["a"] })],
      warnings: [],
    });
  });
});
