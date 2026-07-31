/**
 * The local, advisory mirror of Atlas's authoritative `workflow.interface` v1 profile
 * (`src/lib/workflow-interface-contract.ts`), plus the boundary guards that route a raw Atlas
 * response into an editable-or-read-only view (`src/lib/atlas-mappers.ts`) and the panel's
 * draft<->wire conversion (`src/components/atlas/workflow-interface-panel.tsx`).
 *
 * The canonical Permit Application fixture below is the same one named
 * `PERMIT_APPLICATION_CONTRACT_V1` in `docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_TEST_PLAN.md` §4,
 * reused here rather than invented so the unit and contract layers share one shape.
 */

import { describe, expect, it } from "vitest";

import {
  authoritativeContractJson,
  authoritativeContractMarkdown,
  authoritativeSnippets,
  businessProjection,
  deriveInterfaceOutputCandidates,
  detectInterfaceGraphDrift,
  estimateCanonicalBytes,
  isExactlyObjectType,
  MIN_COMPATIBLE_ATLAS_COMMIT,
  pathRepresentable,
  pathRequiredAndTyped,
  schemaTypes,
  validateInputSchemaStructure,
  validateInstanceAgainstSchema,
  validateOutputs,
} from "@/lib/workflow-interface-contract";
import {
  runDeclaredOutputs,
  toRunDetailView,
  toWorkflowEditableInterface,
  type WorkflowEditableInterface,
} from "@/lib/atlas-mappers";
import type { AtlasWorkflowDefinition, AtlasWorkflowRunDetail } from "@/lib/atlas-types";
import {
  buildInterfacePayload,
  initialInterfaceDraftState,
  type InterfaceDraftState,
} from "@/components/atlas/workflow-interface-panel";
import { observeWorkflowContract } from "@/lib/workflow-run-contract";
import { parseWorkflowGraph } from "@/lib/workflow-graph";

const PERMIT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["applicant_name", "permit_type", "detail", "attachments"],
  properties: {
    applicant_name: { type: "string", minLength: 1 },
    permit_type: { type: "string", enum: ["build", "renovate"] },
    detail: {
      type: "object",
      additionalProperties: false,
      required: ["building_type", "floors"],
      properties: {
        building_type: { type: "string" },
        floors: { type: "integer", minimum: 1 },
      },
    },
    attachments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind"],
        properties: { name: { type: "string" }, kind: { type: "string" } },
      },
    },
    review_context: { type: "string" },
  },
};

const PERMIT_SAMPLE_INPUT = {
  applicant_name: "Test Applicant",
  permit_type: "build",
  detail: { building_type: "commercial", floors: 2 },
  attachments: [{ name: "synthetic-id.pdf", kind: "identity-copy" }],
  review_context: "synthetic test data only",
};

const PERMIT_GRAPH_RAW = {
  start: "intake",
  nodes: [
    {
      id: "intake",
      type: "worker",
      prompt:
        "applicant: {input.applicant_name} type: {input.permit_type} detail: {input.detail} attachments: {input.attachments}",
      outputs: ["intake_review"],
    },
    {
      id: "assessment",
      type: "worker",
      prompt: "review {artifact.intake_review} context: {input.review_context}",
      outputs: ["assessment_result"],
    },
  ],
  edges: [{ from: "intake", to: "assessment", condition: { type: "always" } }],
};

function permitGraph() {
  const parsed = parseWorkflowGraph(PERMIT_GRAPH_RAW);
  if (!parsed.ok) throw new Error(`fixture graph does not parse: ${parsed.reason}`);
  return parsed.value;
}

function permitContract() {
  return observeWorkflowContract(permitGraph(), {
    workflowId: "wfd_permit",
    observedVersion: 3,
  });
}

describe("_schema_types / _is_exactly_object parity", () => {
  it("normalises a string type to a one-element tuple", () => {
    expect(schemaTypes({ type: "object" })).toEqual(["object"]);
  });

  it('accepts type: object and the single-entry equivalent ["object"]', () => {
    expect(isExactlyObjectType({ type: "object" })).toBe(true);
    expect(isExactlyObjectType({ type: ["object"] })).toBe(true);
  });

  it('rejects a nullable or mixed union such as ["object","null"]', () => {
    expect(isExactlyObjectType({ type: ["object", "null"] })).toBe(false);
    expect(isExactlyObjectType({ type: "string" })).toBe(false);
    expect(isExactlyObjectType({})).toBe(false);
  });
});

describe("validateInputSchemaStructure — root/start-intermediate object-only rule", () => {
  it("accepts the canonical Permit input_schema with no diagnostics", () => {
    expect(validateInputSchemaStructure(PERMIT_INPUT_SCHEMA)).toEqual([]);
  });

  it('accepts type: ["object"] at the root, same as the bare string form', () => {
    const diagnostics = validateInputSchemaStructure({
      type: ["object"],
      properties: {},
    });
    expect(diagnostics).toEqual([]);
  });

  it("rejects a mixed/nullable root type union", () => {
    const diagnostics = validateInputSchemaStructure({ type: ["object", "null"] });
    expect(diagnostics).toEqual([expect.objectContaining({ severity: "error", path: "$" })]);
    expect(diagnostics[0]!.message).toContain("object");
  });

  it("rejects a non-object root", () => {
    const diagnostics = validateInputSchemaStructure({ type: "string" });
    expect(diagnostics.some((d) => d.severity === "error" && d.path === "$")).toBe(true);
  });

  it("rejects an unsupported keyword at any depth", () => {
    const diagnostics = validateInputSchemaStructure({
      type: "object",
      properties: { a: { type: "string", pattern: "^[a-z]+$" } },
    });
    expect(diagnostics.some((d) => d.message.includes("pattern"))).toBe(true);
  });

  it("rejects $ref, combinators, and format outright", () => {
    for (const keyword of [
      "$ref",
      "oneOf",
      "anyOf",
      "allOf",
      "not",
      "format",
      "patternProperties",
    ]) {
      const diagnostics = validateInputSchemaStructure({ type: "object", [keyword]: {} });
      expect(diagnostics.some((d) => d.message.includes(keyword))).toBe(true);
    }
  });

  it("requires the exact $schema URI when present, and accepts it when correct", () => {
    const wrong = validateInputSchemaStructure({
      type: "object",
      $schema: "https://example.com/wrong.json",
    });
    expect(wrong.some((d) => d.path.endsWith(".$schema"))).toBe(true);

    const right = validateInputSchemaStructure({
      type: "object",
      $schema: "https://atlas.local/schemas/workflow-interface-input-v1.schema.json",
    });
    expect(right).toEqual([]);
  });

  it("flags required naming an undeclared property — as a warning, since Atlas accepts it", () => {
    const diagnostics = validateInputSchemaStructure({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "b"],
    });
    expect(diagnostics.some((d) => d.severity === "warning" && d.message.includes("b"))).toBe(true);
  });

  // The following all mirror rejections Atlas's `_validate_schema_node` makes; each was a
  // confirmed accepts-what-Atlas-rejects gap in this mirror before being closed.

  it("rejects $schema anywhere but the schema root, even with the exact URI", () => {
    const diagnostics = validateInputSchemaStructure({
      type: "object",
      properties: {
        a: {
          type: "string",
          $schema: "https://atlas.local/schemas/workflow-interface-input-v1.schema.json",
        },
      },
    });
    expect(
      diagnostics.some((d) => d.severity === "error" && d.message.includes("schema root")),
    ).toBe(true);
  });

  it("rejects a non-array examples value", () => {
    const diagnostics = validateInputSchemaStructure({ type: "object", examples: { a: 1 } });
    expect(diagnostics.some((d) => d.severity === "error" && d.path === "$.examples")).toBe(true);
  });

  it("rejects empty-string and duplicate required entries", () => {
    const empty = validateInputSchemaStructure({ type: "object", required: [""] });
    expect(empty.some((d) => d.severity === "error" && d.path === "$.required")).toBe(true);
    const duplicated = validateInputSchemaStructure({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "a"],
    });
    expect(duplicated.some((d) => d.severity === "error" && d.message.includes("unique"))).toBe(
      true,
    );
  });

  it("rejects an empty-string property name", () => {
    const diagnostics = validateInputSchemaStructure({
      type: "object",
      properties: { "": { type: "string" } },
    });
    expect(diagnostics.some((d) => d.severity === "error" && d.path === "$.properties")).toBe(true);
  });

  it("allows exactly 16 nesting levels and rejects the 17th, matching Atlas's depth seed", () => {
    const nest = (levels: number): Record<string, unknown> => {
      let node: Record<string, unknown> = { type: "string" };
      // The innermost node is level `levels`; wrap upward until the root is level 1.
      for (let level = levels - 1; level >= 1; level -= 1) {
        node = { type: "object", properties: { a: node } };
      }
      return node;
    };
    expect(validateInputSchemaStructure(nest(16))).toEqual([]);
    expect(
      validateInputSchemaStructure(nest(17)).some(
        (d) => d.severity === "error" && d.message.includes("nesting"),
      ),
    ).toBe(true);
  });
});

describe("pathRepresentable / pathRequiredAndTyped — cross_check_against_graph parity", () => {
  it("finds every Permit prompt path representable", () => {
    const contract = permitContract();
    for (const path of contract.inputPaths) {
      expect(pathRepresentable(PERMIT_INPUT_SCHEMA, path.segments)).toBe(true);
    }
  });

  it("requires every intermediate segment on the start node's path to be required and object-typed", () => {
    // detail.floors: "detail" must be required + exactly object-typed at the root.
    expect(pathRequiredAndTyped(PERMIT_INPUT_SCHEMA, ["detail", "floors"])).toBe(true);
  });

  it("refuses requiredness through a nullable/mixed intermediate object", () => {
    const schema = {
      type: "object",
      required: ["detail"],
      properties: {
        detail: {
          type: ["object", "null"],
          required: ["floors"],
          properties: { floors: { type: "integer" } },
        },
      },
    };
    expect(pathRequiredAndTyped(schema, ["detail", "floors"])).toBe(false);
    // But the path is still representable — just not provably required.
    expect(pathRepresentable(schema, ["detail", "floors"])).toBe(true);
  });

  it("marks a path impossible under a closed schema that never declares it", () => {
    const closed = { type: "object", additionalProperties: false, properties: {} };
    expect(pathRepresentable(closed, ["nonexistent"])).toBe(false);
  });

  it("marks a path through a non-object subschema node impossible, matching Atlas's polarity", () => {
    // Atlas's `_path_representable` returns False for a non-dict schema node; the structural
    // validator independently rejects such a schema, but the drift check must agree on its own.
    const degenerate = { type: "object", properties: { a: true } };
    expect(pathRepresentable(degenerate, ["a", "b"])).toBe(false);
  });

  it("leaves an optional downstream-only path representable but not required", () => {
    // review_context is declared but not required — the canonical fixture's own design: the
    // downstream node may use it, but a start-node requiredness check must not demand it.
    expect(pathRepresentable(PERMIT_INPUT_SCHEMA, ["review_context"])).toBe(true);
    expect(pathRequiredAndTyped(PERMIT_INPUT_SCHEMA, ["review_context"])).toBe(false);
  });
});

describe("validateInstanceAgainstSchema — sample/business input diagnostics", () => {
  it("accepts the canonical Permit sample against its schema", () => {
    expect(validateInstanceAgainstSchema(PERMIT_INPUT_SCHEMA, PERMIT_SAMPLE_INPUT)).toEqual([]);
  });

  it("reports a missing required property", () => {
    const { attachments: _omit, ...withoutAttachments } = PERMIT_SAMPLE_INPUT;
    const diagnostics = validateInstanceAgainstSchema(PERMIT_INPUT_SCHEMA, withoutAttachments);
    expect(diagnostics.some((d) => d.message.includes("attachments"))).toBe(true);
  });

  it("rejects additionalProperties: false violations", () => {
    const diagnostics = validateInstanceAgainstSchema(PERMIT_INPUT_SCHEMA, {
      ...PERMIT_SAMPLE_INPUT,
      secret_override: "nope",
    });
    expect(diagnostics.some((d) => d.path.includes("secret_override"))).toBe(true);
  });

  it("does not accept a JSON boolean as an integer or number (bool !== 1)", () => {
    const diagnostics = validateInstanceAgainstSchema(PERMIT_INPUT_SCHEMA, {
      ...PERMIT_SAMPLE_INPUT,
      detail: { ...PERMIT_SAMPLE_INPUT.detail, floors: true },
    });
    expect(diagnostics.some((d) => d.path.includes("floors"))).toBe(true);
  });

  it("treats true and 1 as distinct for enum comparison", () => {
    const diagnostics = validateInstanceAgainstSchema(
      { type: "object", properties: { flag: { enum: [1] } }, required: ["flag"] },
      { flag: true },
    );
    expect(diagnostics.some((d) => d.path.endsWith(".flag"))).toBe(true);
  });
});

describe("businessProjection — reserved-field removal", () => {
  it("removes exactly _meta and _trigger_chain, never every underscore-prefixed key", () => {
    const projected = businessProjection({
      applicant_name: "x",
      _meta: { source: "web" },
      _trigger_chain: ["t1"],
      _custom_business_field: "keep me",
    });
    expect(projected).toEqual({ applicant_name: "x", _custom_business_field: "keep me" });
  });
});

describe("validateOutputs", () => {
  it("accepts the canonical Permit outputs", () => {
    expect(
      validateOutputs(
        [
          { key: "intake_review", kind: "text" },
          { key: "assessment_result", kind: "text" },
        ],
        "assessment_result",
      ),
    ).toEqual([]);
  });

  it("rejects a duplicate output key", () => {
    const diagnostics = validateOutputs(
      [
        { key: "a", kind: "text" },
        { key: "a", kind: "json" },
      ],
      undefined,
    );
    expect(diagnostics.some((d) => d.message.includes("duplicate"))).toBe(true);
  });

  it("rejects a primary_output that does not name a declared key", () => {
    const diagnostics = validateOutputs([{ key: "a", kind: "text" }], "missing");
    expect(diagnostics.some((d) => d.path === "$.primary_output")).toBe(true);
  });

  it("rejects an output key that does not match the pattern", () => {
    const diagnostics = validateOutputs([{ key: "1bad-key", kind: "text" }], undefined);
    expect(diagnostics.some((d) => d.path.endsWith(".key"))).toBe(true);
  });
});

describe("deriveInterfaceOutputCandidates — graph-derived output table", () => {
  it("marks a key produced by exactly one worker as unique and declarable", () => {
    const candidates = deriveInterfaceOutputCandidates(permitContract());
    expect(candidates).toEqual([
      { key: "assessment_result", kind: "text", nodeIds: ["assessment"], unique: true },
      { key: "intake_review", kind: "text", nodeIds: ["intake"], unique: true },
    ]);
  });

  it("marks a key produced by more than one worker as not unique", () => {
    const graph = parseWorkflowGraph({
      start: "a",
      nodes: [
        { id: "a", type: "worker", prompt: "x", outputs: ["shared"] },
        { id: "b", type: "worker", prompt: "y", outputs: ["shared"] },
      ],
      edges: [{ from: "a", to: "b", condition: { type: "always" } }],
    });
    if (!graph.ok) throw new Error("fixture does not parse");
    const contract = observeWorkflowContract(graph.value, {
      workflowId: "wfd",
      observedVersion: 1,
    });
    const candidates = deriveInterfaceOutputCandidates(contract);
    expect(candidates).toEqual([
      expect.objectContaining({ key: "shared", unique: false, nodeIds: ["a", "b"] }),
    ]);
  });
});

describe("estimateCanonicalBytes — advisory byte estimate", () => {
  it("is a non-negative finite number for a plain object", () => {
    const bytes = estimateCanonicalBytes(PERMIT_SAMPLE_INPUT);
    expect(Number.isFinite(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
  });

  it("does not depend on key order (sort_keys parity)", () => {
    const a = estimateCanonicalBytes({ z: 1, a: 2 });
    const b = estimateCanonicalBytes({ a: 2, z: 1 });
    expect(a).toBe(b);
  });

  it("charges extra bytes for non-ASCII content, matching ensure_ascii's cost", () => {
    const ascii = estimateCanonicalBytes({ v: "abc" });
    const thai = estimateCanonicalBytes({ v: "กขค" });
    expect(thai).toBeGreaterThan(ascii);
  });
});

describe("detectInterfaceGraphDrift — declared vs observed", () => {
  it("is silent when the declared interface matches the graph exactly", () => {
    const drift = detectInterfaceGraphDrift(
      {
        input_schema: PERMIT_INPUT_SCHEMA,
        outputs: [{ key: "intake_review" }, { key: "assessment_result" }],
      },
      permitContract(),
    );
    expect(drift).toEqual([]);
  });

  it("names the exact node/output when the graph produces a key the interface never declared", () => {
    const drift = detectInterfaceGraphDrift(
      { input_schema: PERMIT_INPUT_SCHEMA, outputs: [{ key: "intake_review" }] },
      permitContract(),
    );
    expect(drift).toEqual([
      expect.objectContaining({
        kind: "output_undeclared_in_interface",
        outputKey: "assessment_result",
      }),
    ]);
  });

  it("names the exact output when a declared key is no longer produced by the graph", () => {
    const drift = detectInterfaceGraphDrift(
      {
        input_schema: PERMIT_INPUT_SCHEMA,
        outputs: [{ key: "intake_review" }, { key: "assessment_result" }, { key: "stale_key" }],
      },
      permitContract(),
    );
    expect(drift).toEqual([
      expect.objectContaining({ kind: "declared_output_not_in_graph", outputKey: "stale_key" }),
    ]);
  });

  it("names the exact path when a start node renders a path the schema cannot represent", () => {
    const closedSchema = {
      type: "object",
      additionalProperties: false,
      properties: { applicant_name: { type: "string" } },
    };
    const drift = detectInterfaceGraphDrift(
      { input_schema: closedSchema, outputs: [] },
      permitContract(),
    );
    expect(
      drift.some(
        (d) => d.kind === "input_path_not_representable" && d.path === "input.permit_type",
      ),
    ).toBe(true);
  });

  it("does not mutate either the interface value or the contract while detecting drift", () => {
    const interfaceValue = {
      input_schema: PERMIT_INPUT_SCHEMA,
      outputs: [{ key: "intake_review" }],
    };
    const contract = permitContract();
    const before = JSON.stringify(interfaceValue);
    const contractBefore = JSON.stringify(contract);
    detectInterfaceGraphDrift(interfaceValue, contract);
    expect(JSON.stringify(interfaceValue)).toBe(before);
    expect(JSON.stringify(contract)).toBe(contractBefore);
  });
});

describe("authoritative snippet/document generation", () => {
  const ctx = {
    workflowId: "wfd_permit",
    workflowVersion: 7,
    interfaceValue: {
      schema_version: 1,
      input_schema: PERMIT_INPUT_SCHEMA,
      sample_input: PERMIT_SAMPLE_INPUT,
      outputs: [
        { key: "intake_review", kind: "text" as const },
        { key: "assessment_result", kind: "text" as const },
      ],
      primary_output: "assessment_result",
    },
  };

  it("cites the pinned minimum compatible Atlas commit", () => {
    expect(MIN_COMPATIBLE_ATLAS_COMMIT).toBe("15c4876aa4f86e109a3cc52d6a299f46791053a2");
  });

  it("includes expected_workflow_version in every generated backend snippet", () => {
    const snippets = authoritativeSnippets(ctx);
    expect(snippets.curl).toContain("expected_workflow_version");
    expect(snippets.typescript).toContain("expected_workflow_version: 7");
    expect(snippets.python).toContain('"expected_workflow_version": 7');
  });

  it("never includes an Atlas base URL or bearer literal in generated snippets", () => {
    const snippets = authoritativeSnippets(ctx);
    for (const code of Object.values(snippets)) {
      expect(code).not.toMatch(/https?:\/\/(?!example)/);
    }
  });

  it("generates a JSON document that is declared/enforced, not observed", () => {
    const json = JSON.parse(authoritativeContractJson(ctx));
    expect(json.declared).toBe(true);
    expect(json.enforced_by_atlas).toBe(true);
    expect(json.workflow_version).toBe(7);
    expect(json.min_compatible_atlas_commit).toBe(MIN_COMPATIBLE_ATLAS_COMMIT);
  });

  it("names the workflow version and the trigger version-pin limitation in the markdown guide", () => {
    const markdown = authoritativeContractMarkdown(ctx);
    expect(markdown).toContain("version 7");
    expect(markdown).toContain("does **not** accept a version pin");
  });
});

describe("toWorkflowEditableInterface — absent/null/v1/unknown-version boundary guard", () => {
  it("treats undefined and null identically as absent", () => {
    expect(toWorkflowEditableInterface(undefined)).toEqual({ kind: "absent" });
    expect(toWorkflowEditableInterface(null)).toEqual({ kind: "absent" });
  });

  it("parses a schema_version: 1 interface as editable", () => {
    const raw = { schema_version: 1, input_schema: PERMIT_INPUT_SCHEMA };
    expect(toWorkflowEditableInterface(raw)).toEqual({ kind: "v1", value: raw });
  });

  it("marks an unrecognised schema_version as unsupported, carrying the raw value untouched", () => {
    const raw = { schema_version: 2, input_schema: { type: "object" } };
    const result = toWorkflowEditableInterface(raw);
    expect(result).toEqual({ kind: "unsupported", schemaVersion: 2, raw });
  });
});

describe("historical run interface snapshot — snapshot, not live definition", () => {
  function detailWith(run: Partial<AtlasWorkflowRunDetail["run"]>): AtlasWorkflowRunDetail {
    return {
      run: {
        id: "wfr_1",
        workflow_definition_id: "wfd_permit",
        name: "test run",
        state: "succeeded",
        input: {},
        current_nodes: [],
        counters: {},
        error: null,
        created_at: "2026-01-01T00:00:00Z",
        started_at: "2026-01-01T00:00:01Z",
        finished_at: "2026-01-01T00:00:02Z",
        updated_at: "2026-01-01T00:00:02Z",
        graph_snapshot: null,
        policy_snapshot: null,
        ...run,
      },
      nodes: [],
      edges: [],
      approvals: [],
    };
  }

  it("reads interface_snapshot, never a value passed as the live definition", () => {
    const snapshotInterface = {
      schema_version: 1,
      input_schema: PERMIT_INPUT_SCHEMA,
      outputs: [{ key: "assessment_result", kind: "text" as const }],
      primary_output: "assessment_result",
    };
    const view = toRunDetailView(
      detailWith({ interface_snapshot: snapshotInterface, workflow_version_snapshot: 4 }),
    );
    expect(view.interfaceSnapshot).toEqual({
      kind: "present",
      value: snapshotInterface,
      workflowVersion: 4,
    });
  });

  it("reads absent for a legacy run with no snapshot, and for an Atlas that omits the field", () => {
    expect(
      toRunDetailView(detailWith({ interface_snapshot: null, workflow_version_snapshot: null }))
        .interfaceSnapshot,
    ).toEqual({ kind: "absent" });
    expect(toRunDetailView(detailWith({})).interfaceSnapshot).toEqual({ kind: "absent" });
  });

  it("preserves an unknown-version snapshot raw, but never interprets its outputs as declared", () => {
    const futureSnapshot = {
      schema_version: 99,
      input_schema: { type: "object" },
      // In a v99 format these field names may mean something else entirely — badging artifacts
      // off them under v1 semantics would be a guess presented as fact.
      outputs: [{ key: "assessment_result", kind: "text" as const }],
      primary_output: "assessment_result",
    };
    const view = toRunDetailView(
      detailWith({ interface_snapshot: futureSnapshot, workflow_version_snapshot: 9 }),
    );
    expect(view.interfaceSnapshot).toEqual({
      kind: "present",
      value: futureSnapshot,
      workflowVersion: 9,
    });
    expect(runDeclaredOutputs(view.interfaceSnapshot)).toBeNull();
  });

  it("derives declared badge outputs from a v1 snapshot, and none at all from an absent one", () => {
    const v1 = toRunDetailView(
      detailWith({
        interface_snapshot: {
          schema_version: 1,
          input_schema: PERMIT_INPUT_SCHEMA,
          outputs: [{ key: "assessment_result", kind: "text" as const }],
          primary_output: "assessment_result",
        },
        workflow_version_snapshot: 4,
      }),
    );
    expect(runDeclaredOutputs(v1.interfaceSnapshot)).toEqual({
      keys: new Set(["assessment_result"]),
      primary: "assessment_result",
    });
    expect(runDeclaredOutputs({ kind: "absent" })).toBeNull();
  });
});

describe("interface draft <-> wire payload round trip (dirty baseline, interface-only save)", () => {
  function editableV1(overrides: Partial<AtlasWorkflowDefinition["interface"]> = {}) {
    return {
      kind: "v1" as const,
      value: {
        schema_version: 1,
        input_schema: PERMIT_INPUT_SCHEMA,
        sample_input: PERMIT_SAMPLE_INPUT,
        outputs: [{ key: "intake_review", kind: "text" as const }],
        primary_output: "intake_review",
        ...overrides,
      },
    };
  }

  it("omits the interface key entirely when the draft is unchanged from load — never re-encodes", () => {
    // A graph-only save must not rewrite the stored interface: Atlas preserves an omitted key
    // verbatim, including any additive field a future Atlas ships inside schema_version 1.
    const draft = initialInterfaceDraftState(editableV1());
    const result = buildInterfacePayload(draft, true);
    expect(result).toEqual({ ok: true, interface: undefined });
  });

  it("re-encodes a stored v1 interface losslessly once the draft has actually changed", () => {
    const editable: WorkflowEditableInterface = editableV1();
    const draft = initialInterfaceDraftState(editable);
    const result = buildInterfacePayload(draft, false);
    expect(result).toEqual({ ok: true, interface: editable.value });
  });

  it("omits the interface key when nothing was ever stored and the panel was never touched", () => {
    const draft = initialInterfaceDraftState({ kind: "absent" });
    const result = buildInterfacePayload(draft, true);
    expect(result).toEqual({ ok: true, interface: undefined });
  });

  it("sends an explicit null clear whenever a changed draft is in none mode", () => {
    // The changed-vs-baseline comparison, not a mount-time flag, is what decides null vs omit:
    // an interface added and saved earlier in the same session must still clear on Atlas.
    const draft: InterfaceDraftState = {
      ...initialInterfaceDraftState(editableV1()),
      mode: "none",
    };
    const result = buildInterfacePayload(draft, false);
    expect(result).toEqual({ ok: true, interface: null });
  });

  it("never re-sends an unsupported-version interface — omitted even when marked changed", () => {
    const raw = { schema_version: 99, input_schema: { type: "object" } };
    const draft = initialInterfaceDraftState({ kind: "unsupported", schemaVersion: 99, raw });
    const result = buildInterfacePayload(draft, false);
    expect(result).toEqual({ ok: true, interface: undefined });
  });

  it("reports a parse failure rather than silently dropping the interface from a save", () => {
    const draft: InterfaceDraftState = {
      mode: "editing",
      inputSchemaText: "{not valid json",
      sampleInputText: "{}",
      outputs: {},
      primaryOutput: "",
    };
    const result = buildInterfacePayload(draft, false);
    expect(result.ok).toBe(false);
  });

  it("omits sample_input when the author leaves it as an empty object", () => {
    const draft: InterfaceDraftState = {
      mode: "editing",
      inputSchemaText: JSON.stringify(PERMIT_INPUT_SCHEMA),
      sampleInputText: "{}",
      outputs: {},
      primaryOutput: "",
    };
    const result = buildInterfacePayload(draft, false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.interface).not.toHaveProperty("sample_input");
  });

  it("drops primary_output if it no longer names an enabled declared output", () => {
    const draft: InterfaceDraftState = {
      mode: "editing",
      inputSchemaText: JSON.stringify(PERMIT_INPUT_SCHEMA),
      sampleInputText: "{}",
      outputs: { intake_review: { enabled: false, kind: "text", title: "", description: "" } },
      primaryOutput: "intake_review",
    };
    const result = buildInterfacePayload(draft, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.interface).not.toHaveProperty("primary_output");
      expect(result.interface).not.toHaveProperty("outputs");
    }
  });
});
