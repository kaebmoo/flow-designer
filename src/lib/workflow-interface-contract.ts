/**
 * Local, advisory mirror of Atlas's authoritative `workflow.interface` v1 profile.
 *
 * Pure and client-safe — no `*.server.ts` import, no React, no network. Everything here exists
 * for fast feedback while authoring: Atlas (`atlas/workflow_interface.py`, checkout
 * `15c4876aa4f86e109a3cc52d6a299f46791053a2`) is the only authority that actually enforces this
 * profile, and its `POST`/`PUT /api/workflows` response is what a save must obey. Nothing here
 * may silently pass something Atlas would reject, but this module is also not required to be
 * byte-identical to Atlas's Python canonical serialization — see {@link estimateCanonicalBytes}.
 *
 * ## Ground truth
 *
 *  - `atlas/workflow_interface.py` — the validator this mirrors: keyword allowlist, bounds,
 *    `_schema_types`/`_is_exactly_object`, `business_projection`, `cross_check_against_graph`.
 *  - `docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md` §5 — the product-level restatement of the
 *    same profile, including the canonical Permit Application fixture.
 */

import {
  extractPlaceholders,
  type ObservedContract,
  type ObservedInputPath,
} from "./workflow-run-contract";
import type { AtlasWorkflowInterface } from "./atlas-types";

// ---------------------------------------------------------------------------
// Constants — mirror atlas/workflow_interface.py exactly.
// ---------------------------------------------------------------------------

export const INTERFACE_SCHEMA_VERSION = 1;

export const INPUT_SCHEMA_URI =
  "https://atlas.local/schemas/workflow-interface-input-v1.schema.json";

export const INTERFACE_MAX_BYTES = 65_536;
export const SAMPLE_MAX_BYTES = 65_536;
export const EFFECTIVE_INPUT_MAX_BYTES = 1_048_576;
export const MAX_SCHEMA_DEPTH = 16;
export const MAX_PROPERTIES = 256;
export const MAX_LIST_ENTRIES = 256;
export const MAX_OUTPUTS = 256;
export const MAX_TRAVERSAL_NODES = 10_000;
export const MAX_TITLE_CODEPOINTS = 256;
export const MAX_DESCRIPTION_CODEPOINTS = 2_048;

export const RESERVED_INPUT_FIELDS = ["_meta", "_trigger_chain"] as const;

export const OUTPUT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const JSON_PRIMITIVE_TYPES = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
] as const;
export type JsonPrimitiveType = (typeof JSON_PRIMITIVE_TYPES)[number];

/** The exact keyword allowlist. Anything else, at any depth, is rejected. */
const SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "title",
  "description",
  "default",
  "examples",
  "$schema",
]);

// ---------------------------------------------------------------------------
// Shapes this module produces.
// ---------------------------------------------------------------------------

export interface InterfaceDiagnostic {
  /** A JSON-pointer-ish path for the offending node, e.g. `$.properties.detail.required`. */
  path: string;
  message: string;
  severity: "error" | "warning";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codepointLength(value: string): number {
  return [...value].length;
}

// ---------------------------------------------------------------------------
// `_schema_types` / `_is_exactly_object`
// ---------------------------------------------------------------------------

/** Mirrors `_schema_types`: normalises a `type` keyword to a tuple, or `[]` when absent. */
export function schemaTypes(schema: unknown): string[] {
  if (!isPlainObject(schema)) return [];
  const nodeType = schema.type;
  if (nodeType === undefined) return [];
  if (typeof nodeType === "string") return [nodeType];
  if (Array.isArray(nodeType) && nodeType.every((entry) => typeof entry === "string")) {
    return nodeType as string[];
  }
  return [];
}

/**
 * Mirrors `_is_exactly_object`: true for `type: "object"` and for the single-entry equivalent
 * `type: ["object"]`. False for anything else, including `["object", "null"]` — a nullable or
 * mixed union never satisfies an exact-object requirement.
 */
export function isExactlyObjectType(schema: unknown): boolean {
  const types = schemaTypes(schema);
  return types.length === 1 && types[0] === "object";
}

// ---------------------------------------------------------------------------
// Structural profile validator — `validate_input_schema`.
// ---------------------------------------------------------------------------

interface StructureBudget {
  propertiesSeen: number;
  nodesVisited: number;
}

function validateSchemaNode(
  schema: unknown,
  path: string,
  depth: number,
  isRoot: boolean,
  budget: StructureBudget,
  diagnostics: InterfaceDiagnostic[],
): void {
  budget.nodesVisited += 1;
  if (budget.nodesVisited > MAX_TRAVERSAL_NODES) {
    diagnostics.push({
      path,
      severity: "error",
      message: `${path}: schema exceeds the ${MAX_TRAVERSAL_NODES}-node traversal bound.`,
    });
    return;
  }

  if (!isPlainObject(schema)) {
    diagnostics.push({ path, severity: "error", message: `${path}: must be an object.` });
    return;
  }

  if (depth > MAX_SCHEMA_DEPTH) {
    diagnostics.push({
      path,
      severity: "error",
      message: `${path}: schema nesting exceeds ${MAX_SCHEMA_DEPTH} levels.`,
    });
    return;
  }

  const unsupported = Object.keys(schema).filter((key) => !SCHEMA_KEYWORDS.has(key));
  if (unsupported.length > 0) {
    diagnostics.push({
      path,
      severity: "error",
      message: `${path}: unsupported schema keyword(s): ${unsupported.join(", ")}.`,
    });
  }

  if ("$schema" in schema) {
    if (!isRoot) {
      diagnostics.push({
        path: `${path}.$schema`,
        severity: "error",
        message: `${path}.$schema: only allowed at the schema root.`,
      });
    } else if (schema.$schema !== INPUT_SCHEMA_URI) {
      diagnostics.push({
        path: `${path}.$schema`,
        severity: "error",
        message: `${path}.$schema: must be exactly "${INPUT_SCHEMA_URI}" when present.`,
      });
    }
  }

  const types = "type" in schema ? schemaTypes(schema) : undefined;
  if ("type" in schema) {
    const raw = schema.type;
    const rawList = Array.isArray(raw) ? raw : [raw];
    const invalid = rawList.some(
      (entry) =>
        typeof entry !== "string" || !(JSON_PRIMITIVE_TYPES as readonly string[]).includes(entry),
    );
    const duplicated = Array.isArray(raw) && new Set(raw).size !== raw.length;
    if (invalid || duplicated || rawList.length === 0) {
      diagnostics.push({
        path: `${path}.type`,
        severity: "error",
        message: `${path}.type: must be one JSON primitive type name or a unique array of them.`,
      });
    }
  }

  if (isRoot && !isExactlyObjectType(schema)) {
    diagnostics.push({
      path,
      severity: "error",
      message: `${path}: root input_schema must declare exactly type "object" (or the single-entry equivalent ["object"]) — a nullable or mixed union such as ["object","null"] is not accepted.`,
    });
  }

  if ("title" in schema) {
    if (typeof schema.title !== "string" || codepointLength(schema.title) > MAX_TITLE_CODEPOINTS) {
      diagnostics.push({
        path: `${path}.title`,
        severity: "error",
        message: `${path}.title: must be a string of at most ${MAX_TITLE_CODEPOINTS} code points.`,
      });
    }
  }
  if ("description" in schema) {
    if (
      typeof schema.description !== "string" ||
      codepointLength(schema.description) > MAX_DESCRIPTION_CODEPOINTS
    ) {
      diagnostics.push({
        path: `${path}.description`,
        severity: "error",
        message: `${path}.description: must be a string of at most ${MAX_DESCRIPTION_CODEPOINTS} code points.`,
      });
    }
  }

  if ("additionalProperties" in schema && typeof schema.additionalProperties !== "boolean") {
    diagnostics.push({
      path: `${path}.additionalProperties`,
      severity: "error",
      message: `${path}.additionalProperties: must be a boolean.`,
    });
  }

  if ("enum" in schema) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length < 1 ||
      schema.enum.length > MAX_LIST_ENTRIES
    ) {
      diagnostics.push({
        path: `${path}.enum`,
        severity: "error",
        message: `${path}.enum: must be an array of 1–${MAX_LIST_ENTRIES} entries.`,
      });
    }
  }

  if ("examples" in schema && !Array.isArray(schema.examples)) {
    diagnostics.push({
      path: `${path}.examples`,
      severity: "error",
      message: `${path}.examples: must be an array.`,
    });
  }

  // Known advisory divergence: after JSON.parse, `2.0` is indistinguishable from `2`, so
  // `Number.isInteger` accepts it here while Python's `isinstance(2.0, int)` on Atlas rejects
  // it. Atlas's own 400 remains the boundary for whole-valued floats.
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (key in schema) {
      const value = schema[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        diagnostics.push({
          path: `${path}.${key}`,
          severity: "error",
          message: `${path}.${key}: must be a non-negative integer.`,
        });
      }
    }
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (key in schema) {
      const value = schema[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        diagnostics.push({
          path: `${path}.${key}`,
          severity: "error",
          message: `${path}.${key}: must be a finite number.`,
        });
      }
    }
  }

  const propertyTypeAllowsObject = types === undefined || types.includes("object");
  if ("properties" in schema) {
    if (!isPlainObject(schema.properties)) {
      diagnostics.push({
        path: `${path}.properties`,
        severity: "error",
        message: `${path}.properties: must be an object.`,
      });
    } else {
      const keys = Object.keys(schema.properties);
      budget.propertiesSeen += keys.length;
      if (budget.propertiesSeen > MAX_PROPERTIES) {
        diagnostics.push({
          path: `${path}.properties`,
          severity: "error",
          message: `Total declared properties exceed ${MAX_PROPERTIES}.`,
        });
      }
      if (!propertyTypeAllowsObject) {
        diagnostics.push({
          path: `${path}.properties`,
          severity: "warning",
          message: `${path}.properties is declared but type does not include "object"; it can never apply.`,
        });
      }
      for (const key of keys) {
        if (key === "") {
          diagnostics.push({
            path: `${path}.properties`,
            severity: "error",
            message: `${path}.properties: property names must be non-empty strings.`,
          });
          continue;
        }
        validateSchemaNode(
          schema.properties[key],
          `${path}.properties.${key}`,
          depth + 1,
          false,
          budget,
          diagnostics,
        );
      }
    }
  }

  if ("required" in schema) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.length > MAX_LIST_ENTRIES ||
      !schema.required.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      diagnostics.push({
        path: `${path}.required`,
        severity: "error",
        message: `${path}.required: must be an array of at most ${MAX_LIST_ENTRIES} non-empty property-name strings.`,
      });
    } else if (new Set(schema.required).size !== schema.required.length) {
      diagnostics.push({
        path: `${path}.required`,
        severity: "error",
        message: `${path}.required: entries must be unique.`,
      });
    } else if (isPlainObject(schema.properties)) {
      const declared = new Set(Object.keys(schema.properties));
      const missing = schema.required.filter((name) => !declared.has(name as string));
      if (missing.length > 0) {
        // Atlas accepts this (the mismatch only bites when an instance is validated), so it is a
        // warning here, not a mirror of an Atlas rejection.
        diagnostics.push({
          path: `${path}.required`,
          severity: "warning",
          message: `${path}.required names propert${missing.length === 1 ? "y" : "ies"} not declared in properties: ${missing.join(", ")}.`,
        });
      }
    }
  }

  if ("items" in schema) {
    const typeAllowsArray = types === undefined || types.includes("array");
    if (!typeAllowsArray) {
      diagnostics.push({
        path: `${path}.items`,
        severity: "warning",
        message: `${path}.items is declared but type does not include "array"; it can never apply.`,
      });
    }
    validateSchemaNode(schema.items, `${path}.items`, depth + 1, false, budget, diagnostics);
  }
}

/**
 * Structural profile check only — the client-side counterpart of Atlas's `validate_input_schema`.
 *
 * `isRoot` fixes whether the exact-object rule applies at this node; callers validating a
 * standalone (non-root) schema fragment — for example a start-path intermediate segment reused
 * elsewhere — pass `false`.
 */
export function validateInputSchemaStructure(
  schema: unknown,
  options: { isRoot?: boolean } = {},
): InterfaceDiagnostic[] {
  const diagnostics: InterfaceDiagnostic[] = [];
  // Depth seeds at 1, exactly like Atlas's `validate_input_schema` — the root node itself is
  // level 1, so the deepest accepted chain is MAX_SCHEMA_DEPTH nodes.
  validateSchemaNode(
    schema,
    "$",
    1,
    options.isRoot ?? true,
    { propertiesSeen: 0, nodesVisited: 0 },
    diagnostics,
  );
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Instance-vs-schema check — `validate_business_input`, advisory subset.
// ---------------------------------------------------------------------------

/** Atlas's own JSON-type fidelity rule: `bool` is never `integer`/`number`, and `true !== 1`. */
function instanceMatchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "integer":
      // Known advisory divergence: JSON `2.0` parses to the same JS number as `2`, so it passes
      // here while Atlas's `isinstance(2.0, int)` rejects it. Atlas's 400 is the boundary.
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return false;
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => jsonEqual(entry, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key, index) => key === bKeys[index] && jsonEqual(a[key], b[key]))
    );
  }
  return false;
}

function validateInstance(
  schema: unknown,
  instance: unknown,
  path: string,
  budget: { count: number },
  diagnostics: InterfaceDiagnostic[],
): void {
  budget.count += 1;
  if (budget.count > MAX_TRAVERSAL_NODES) {
    diagnostics.push({
      path,
      severity: "error",
      message: `${path}: input exceeds the ${MAX_TRAVERSAL_NODES}-node validation traversal bound.`,
    });
    return;
  }
  if (!isPlainObject(schema)) return;

  const types = schemaTypes(schema);
  if (types.length > 0 && !types.some((type) => instanceMatchesType(type, instance))) {
    diagnostics.push({
      path,
      severity: "error",
      message: `${path}: expected ${types.join(" or ")}.`,
    });
    return;
  }

  if ("enum" in schema && Array.isArray(schema.enum)) {
    if (!schema.enum.some((candidate) => jsonEqual(candidate, instance))) {
      diagnostics.push({ path, severity: "error", message: `${path}: value is not in enum.` });
    }
  }
  if ("const" in schema && !jsonEqual(schema.const, instance)) {
    diagnostics.push({ path, severity: "error", message: `${path}: value does not equal const.` });
  }

  if (typeof instance === "string") {
    if (typeof schema.minLength === "number" && codepointLength(instance) < schema.minLength) {
      diagnostics.push({ path, severity: "error", message: `${path}: shorter than minLength.` });
    }
    if (typeof schema.maxLength === "number" && codepointLength(instance) > schema.maxLength) {
      diagnostics.push({ path, severity: "error", message: `${path}: longer than maxLength.` });
    }
  }

  if (typeof instance === "number" && Number.isFinite(instance)) {
    if (typeof schema.minimum === "number" && instance < schema.minimum) {
      diagnostics.push({ path, severity: "error", message: `${path}: below minimum.` });
    }
    if (typeof schema.maximum === "number" && instance > schema.maximum) {
      diagnostics.push({ path, severity: "error", message: `${path}: above maximum.` });
    }
  }

  if (isPlainObject(instance)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required: string[] = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(instance, key)) {
        diagnostics.push({
          path,
          severity: "error",
          message: `${path}: missing required property '${key}'.`,
        });
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(instance)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          diagnostics.push({
            path: `${path}.${key}`,
            severity: "error",
            message: `${path}.${key}: not declared, and additionalProperties is false.`,
          });
        }
      }
    }
    for (const key of Object.keys(instance)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateInstance(properties[key], instance[key], `${path}.${key}`, budget, diagnostics);
      }
    }
  }

  if (Array.isArray(instance)) {
    if (typeof schema.minItems === "number" && instance.length < schema.minItems) {
      diagnostics.push({ path, severity: "error", message: `${path}: fewer than minItems.` });
    }
    if (typeof schema.maxItems === "number" && instance.length > schema.maxItems) {
      diagnostics.push({ path, severity: "error", message: `${path}: more than maxItems.` });
    }
    if ("items" in schema) {
      instance.forEach((entry, index) =>
        validateInstance(schema.items, entry, `${path}[${index}]`, budget, diagnostics),
      );
    }
  }
}

/** Advisory instance check, used for `sample_input` (and, at run time, entered test input). */
export function validateInstanceAgainstSchema(
  schema: unknown,
  instance: unknown,
): InterfaceDiagnostic[] {
  const diagnostics: InterfaceDiagnostic[] = [];
  validateInstance(schema, instance, "$", { count: 0 }, diagnostics);
  return diagnostics;
}

/** Removes exactly the two reserved top-level fields, never every underscore-prefixed key. */
export function businessProjection(input: Record<string, unknown>): Record<string, unknown> {
  const projected = { ...input };
  for (const field of RESERVED_INPUT_FIELDS) delete projected[field];
  return projected;
}

// ---------------------------------------------------------------------------
// Output entries — `_OUTPUT_ENTRY_KEYS`, output key regex, `kind` vocabulary.
// ---------------------------------------------------------------------------

export function validateOutputs(outputs: unknown, primaryOutput: unknown): InterfaceDiagnostic[] {
  const diagnostics: InterfaceDiagnostic[] = [];
  if (outputs === undefined) return diagnostics;
  if (!Array.isArray(outputs)) {
    diagnostics.push({
      path: "$.outputs",
      severity: "error",
      message: "outputs must be an array.",
    });
    return diagnostics;
  }
  if (outputs.length > MAX_OUTPUTS) {
    diagnostics.push({
      path: "$.outputs",
      severity: "error",
      message: `outputs must have at most ${MAX_OUTPUTS} entries.`,
    });
  }
  const seenKeys = new Set<string>();
  outputs.forEach((entry, index) => {
    const path = `$.outputs[${index}]`;
    if (!isPlainObject(entry)) {
      diagnostics.push({ path, severity: "error", message: `${path}: must be an object.` });
      return;
    }
    const unsupported = Object.keys(entry).filter(
      (key) => !["key", "kind", "title", "description"].includes(key),
    );
    if (unsupported.length > 0) {
      diagnostics.push({
        path,
        severity: "error",
        message: `${path}: unsupported field(s): ${unsupported.join(", ")}.`,
      });
    }
    if (typeof entry.key !== "string" || !OUTPUT_KEY_PATTERN.test(entry.key)) {
      diagnostics.push({
        path: `${path}.key`,
        severity: "error",
        message: `${path}.key: must match ${OUTPUT_KEY_PATTERN.source}.`,
      });
    } else if (seenKeys.has(entry.key)) {
      diagnostics.push({
        path: `${path}.key`,
        severity: "error",
        message: `${path}.key: duplicate output key "${entry.key}".`,
      });
    } else {
      seenKeys.add(entry.key);
    }
    if (entry.kind !== "text" && entry.kind !== "json") {
      diagnostics.push({
        path: `${path}.kind`,
        severity: "error",
        message: `${path}.kind: must be "text" or "json".`,
      });
    }
    if (
      entry.title !== undefined &&
      (typeof entry.title !== "string" || codepointLength(entry.title) > MAX_TITLE_CODEPOINTS)
    ) {
      diagnostics.push({
        path: `${path}.title`,
        severity: "error",
        message: `${path}.title: must be a string of at most ${MAX_TITLE_CODEPOINTS} code points.`,
      });
    }
    if (
      entry.description !== undefined &&
      (typeof entry.description !== "string" ||
        codepointLength(entry.description) > MAX_DESCRIPTION_CODEPOINTS)
    ) {
      diagnostics.push({
        path: `${path}.description`,
        severity: "error",
        message: `${path}.description: must be a string of at most ${MAX_DESCRIPTION_CODEPOINTS} code points.`,
      });
    }
  });
  if (
    typeof primaryOutput === "string" &&
    primaryOutput.length > 0 &&
    !seenKeys.has(primaryOutput)
  ) {
    diagnostics.push({
      path: "$.primary_output",
      severity: "error",
      message: `primary_output "${primaryOutput}" must name a declared output.`,
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Byte-size estimates — advisory only.
// ---------------------------------------------------------------------------

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * Advisory byte estimate for what Atlas's canonical serialization would measure
 * (`json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))`).
 *
 * This is deliberately **not** claimed to be byte-identical: JavaScript's `JSON.stringify` and
 * Python's `json.dumps` do not agree on every escape, and this module has no access to Python's
 * actual serializer. It sorts keys the same way and approximates `ensure_ascii` by charging 6
 * bytes for every UTF-16 code unit above ASCII (Python's `\uXXXX` escape width, including for
 * surrogate-pair halves of an astral character, which is how CPython encodes them too). Byte
 * caps shown from this function are a fast local warning; Atlas's own count is authoritative and
 * a save can still be rejected at a size this function reported as under the limit.
 */
export function estimateCanonicalBytes(value: unknown): number {
  const json = JSON.stringify(sortDeep(value) ?? null) ?? "null";
  let bytes = 0;
  for (let index = 0; index < json.length; index += 1) {
    bytes += json.charCodeAt(index) > 0x7f ? 6 : 1;
  }
  return bytes;
}

export function estimateEffectiveInputBytes(input: Record<string, unknown>): number {
  return estimateCanonicalBytes(input);
}

// ---------------------------------------------------------------------------
// Graph-derived output candidates — for the authoring panel's output table.
// ---------------------------------------------------------------------------

export interface InterfaceOutputCandidate {
  key: string;
  /** The observed kind, when every producing node agrees; `"text"` when they disagree. */
  kind: "text" | "json";
  nodeIds: string[];
  /** False when more than one worker node produces this key — Atlas requires exactly one. */
  unique: boolean;
}

/** Every worker output key in the graph, annotated with whether Atlas would accept it. */
export function deriveInterfaceOutputCandidates(
  observed: Pick<ObservedContract, "outputs">,
): InterfaceOutputCandidate[] {
  const byKey = new Map<string, { kinds: Set<"text" | "json">; nodeIds: string[] }>();
  for (const output of observed.outputs) {
    const entry = byKey.get(output.key) ?? { kinds: new Set(), nodeIds: [] };
    entry.kinds.add(output.kind);
    if (!entry.nodeIds.includes(output.nodeId)) entry.nodeIds.push(output.nodeId);
    byKey.set(output.key, entry);
  }
  return [...byKey.entries()]
    .map(([key, { kinds, nodeIds }]) => ({
      key,
      kind: kinds.size === 1 ? [...kinds][0]! : ("text" as const),
      nodeIds,
      unique: nodeIds.length === 1,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Prompt/schema representability — mirrors `cross_check_against_graph`'s per-path rule.
// ---------------------------------------------------------------------------

/**
 * Whether at least one value accepted by `schema` could supply `segments` — mirrors
 * `_path_representable`. A closed (`additionalProperties: false`) ancestor that does not declare
 * a segment makes the path impossible, and — like Atlas — a non-object subschema node is treated
 * as unable to represent anything (the structural validator independently rejects such a node
 * anyway); an open ancestor never rules a path out.
 */
export function pathRepresentable(schema: unknown, segments: string[]): boolean {
  let node: unknown = schema;
  for (const segment of segments) {
    if (!isPlainObject(node)) return false; // Atlas: a non-dict schema node represents nothing
    const types = schemaTypes(node);
    if (types.length > 0 && !types.includes("object")) return false;
    const properties = isPlainObject(node.properties) ? node.properties : {};
    if (Object.prototype.hasOwnProperty.call(properties, segment)) {
      node = properties[segment];
      continue;
    }
    if (node.additionalProperties === false) return false;
    return true; // open schema: the segment could exist even though it is not declared
  }
  return true;
}

/**
 * Whether every value accepted by `schema` is provably required at `segments` — mirrors
 * `_path_required_and_typed`. Every intermediate container must be required, declared, and
 * exactly object-typed; the final segment need not be.
 */
export function pathRequiredAndTyped(schema: unknown, segments: string[]): boolean {
  let node: unknown = schema;
  for (const segment of segments) {
    if (!isPlainObject(node) || !isExactlyObjectType(node)) return false;
    const required: string[] = Array.isArray(node.required) ? (node.required as string[]) : [];
    const properties = isPlainObject(node.properties) ? node.properties : {};
    if (!required.includes(segment) || !Object.prototype.hasOwnProperty.call(properties, segment)) {
      return false;
    }
    node = properties[segment];
  }
  return true;
}

// ---------------------------------------------------------------------------
// Declared-vs-observed drift.
// ---------------------------------------------------------------------------

export type DriftFindingKind =
  | "input_path_not_representable"
  | "start_input_path_not_required"
  | "output_undeclared_in_interface"
  | "declared_output_not_in_graph";

export interface DriftFinding {
  kind: DriftFindingKind;
  message: string;
  path?: string;
  nodeIds?: string[];
  outputKey?: string;
}

/**
 * Client-side echo of Atlas's `cross_check_against_graph`, run against the interface *as drafted*
 * and the graph *as observed* — advisory, for the editor to warn with before a save round-trips
 * to Atlas. Never mutates either source; naming the exact path/node/output is the whole point.
 */
export function detectInterfaceGraphDrift(
  interfaceValue: { input_schema: unknown; outputs?: readonly { key: string }[] },
  observed: Pick<ObservedContract, "inputPaths" | "outputs" | "startNodeId">,
): DriftFinding[] {
  const findings: DriftFinding[] = [];

  for (const observedPath of observed.inputPaths as ObservedInputPath[]) {
    if (!pathRepresentable(interfaceValue.input_schema, observedPath.segments)) {
      findings.push({
        kind: "input_path_not_representable",
        path: observedPath.path,
        nodeIds: observedPath.nodeIds,
        message: `{${observedPath.path}} is referenced by ${observedPath.nodeIds.join(", ")}, but the declared input_schema cannot represent this path.`,
      });
      continue;
    }
    if (
      observedPath.referencedByStartNode &&
      !pathRequiredAndTyped(interfaceValue.input_schema, observedPath.segments)
    ) {
      findings.push({
        kind: "start_input_path_not_required",
        path: observedPath.path,
        nodeIds: observedPath.nodeIds,
        message: `The start node ${observed.startNodeId} renders {${observedPath.path}} before any branch is chosen, but input_schema does not prove it is always present.`,
      });
    }
  }

  const declaredKeys = new Set((interfaceValue.outputs ?? []).map((entry) => entry.key));
  const graphKeys = new Set(observed.outputs.map((entry) => entry.key));
  for (const key of graphKeys) {
    if (!declaredKeys.has(key)) {
      findings.push({
        kind: "output_undeclared_in_interface",
        outputKey: key,
        message: `Worker output "${key}" exists in the graph but is not declared in the interface's outputs.`,
      });
    }
  }
  for (const key of declaredKeys) {
    if (!graphKeys.has(key)) {
      findings.push({
        kind: "declared_output_not_in_graph",
        outputKey: key,
        message: `Declared output "${key}" is no longer produced by any worker node in this graph.`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Authoritative integration documents and snippets — the "Declared · enforced by Atlas" analog
// of `workflow-run-contract.ts`'s observed snippet builders.
// ---------------------------------------------------------------------------

/**
 * The Atlas commit this client was built and requalified against for `workflow.interface` v1.
 * Cited in the generated integration guide as the minimum compatible Atlas checkout: an older
 * Atlas has no `interface` support at all (the field is entirely absent from its responses),
 * and this client's authoritative path never activates against one.
 */
export const MIN_COMPATIBLE_ATLAS_COMMIT = "15c4876aa4f86e109a3cc52d6a299f46791053a2";

export const SNIPPET_BASE_URL = "$ATLAS_BASE_URL";
export const SNIPPET_TOKEN = "$ATLAS_TOKEN";

export interface AuthoritativeSnippetContext {
  workflowId: string;
  workflowVersion: number;
  interfaceValue: AtlasWorkflowInterface;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sampleOrEmpty(ctx: AuthoritativeSnippetContext): Record<string, unknown> {
  return ctx.interfaceValue.sample_input ?? {};
}

/** The authoritative contract as JSON — `declared: true`, `enforced_by_atlas: true` lead. */
export function authoritativeContractJson(ctx: AuthoritativeSnippetContext): string {
  return stableJson({
    declared: true,
    enforced_by_atlas: true,
    note: "Persisted on the workflow definition and validated by Atlas on every start. Atlas's own 400/409 response is authoritative — this document is a convenience copy.",
    workflow_definition_id: ctx.workflowId,
    workflow_version: ctx.workflowVersion,
    schema_version: ctx.interfaceValue.schema_version,
    input_schema: ctx.interfaceValue.input_schema,
    sample_input: ctx.interfaceValue.sample_input ?? null,
    outputs: ctx.interfaceValue.outputs ?? [],
    primary_output: ctx.interfaceValue.primary_output ?? null,
    min_compatible_atlas_commit: MIN_COMPATIBLE_ATLAS_COMMIT,
  });
}

export interface AuthoritativeSnippets {
  curl: string;
  typescript: string;
  python: string;
  approval: string;
  webhook: string;
}

function authoritativeCurlSnippet(ctx: AuthoritativeSnippetContext): string {
  const body = JSON.stringify(
    {
      workflow_definition_id: ctx.workflowId,
      input: sampleOrEmpty(ctx),
      expected_workflow_version: ctx.workflowVersion,
    },
    null,
    2,
  );
  return [
    `# Declared interface, enforced by Atlas. A 400 names the failing field/path; a 409 means`,
    `# workflow version ${ctx.workflowVersion} is stale — reload the definition and retry`,
    `# deliberately, never automatically. Neither response creates a run.`,
    `RUN_ID=$(curl -sS --fail-with-body -X POST "${SNIPPET_BASE_URL}/api/workflow-runs" \\`,
    `  -H "Authorization: Bearer ${SNIPPET_TOKEN}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body.replaceAll("'", `'\\''`)}' \\`,
    `  | jq -r '.run.id')`,
    ``,
    `curl -sS --fail-with-body "${SNIPPET_BASE_URL}/api/workflow-runs/$RUN_ID" \\`,
    `  -H "Authorization: Bearer ${SNIPPET_TOKEN}" | jq -r '.run.state'`,
    ``,
    `curl -sS --fail-with-body "${SNIPPET_BASE_URL}/api/workflow-runs/$RUN_ID/artifacts" \\`,
    `  -H "Authorization: Bearer ${SNIPPET_TOKEN}" | jq '.artifacts'`,
    ``,
  ].join("\n");
}

function authoritativeTypescriptSnippet(ctx: AuthoritativeSnippetContext): string {
  return [
    `// Server-side only — the Atlas bearer must never reach browser JavaScript.`,
    `const base = process.env.ATLAS_BASE_URL!;`,
    `const headers = {`,
    `  authorization: \`Bearer \${process.env.ATLAS_TOKEN!}\`,`,
    `  "content-type": "application/json",`,
    `};`,
    ``,
    `async function call<T>(path: string, init?: RequestInit): Promise<T> {`,
    `  const response = await fetch(\`\${base}\${path}\`, { ...init, headers });`,
    `  if (!response.ok) {`,
    `    // 400: business input failed input_schema, or an oversized effective input.`,
    `    // 409: expected_workflow_version is stale. Neither creates a run. Do not retry`,
    `    // automatically — decide, then resubmit deliberately.`,
    `    throw new Error(\`Atlas \${response.status} on \${path}: \${await response.text()}\`);`,
    `  }`,
    `  return (await response.json()) as T;`,
    `}`,
    ``,
    `const { run } = await call<{ run: { id: string; state: string } }>("/api/workflow-runs", {`,
    `  method: "POST",`,
    `  body: JSON.stringify({`,
    `    workflow_definition_id: ${JSON.stringify(ctx.workflowId)},`,
    `    input: ${JSON.stringify(sampleOrEmpty(ctx), null, 4).replaceAll("\n", "\n    ")},`,
    `    // Pins this start to the workflow version this guide was generated from. Atlas compares`,
    `    // it against the same definition row it loads to start the run — no separate read.`,
    `    expected_workflow_version: ${ctx.workflowVersion},`,
    `  }),`,
    `});`,
    ``,
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
    `// Declared outputs are possible, not guaranteed: a branch can skip a producing node.`,
    ``,
  ].join("\n");
}

function authoritativePythonSnippet(ctx: AuthoritativeSnippetContext): string {
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
    `        # 400 (business input failed input_schema / oversized) or 409 (stale`,
    `        # expected_workflow_version) — neither creates a run. Surface it; do not retry`,
    `        # automatically.`,
    `        raise SystemExit(f"Atlas {error.code} on {path}: {error.read().decode()}") from error`,
    ``,
    ``,
    `run = call(`,
    `    "/api/workflow-runs",`,
    `    {`,
    `        "workflow_definition_id": ${JSON.stringify(ctx.workflowId)},`,
    `        "input": ${JSON.stringify(sampleOrEmpty(ctx), null, 4).replaceAll("\n", "\n        ")},`,
    `        "expected_workflow_version": ${ctx.workflowVersion},`,
    `    },`,
    `)["run"]`,
    ``,
    `TERMINAL = {"succeeded", "failed", "cancelled"}`,
    `while run["state"] not in TERMINAL:`,
    `    time.sleep(2)`,
    `    run = call(f"/api/workflow-runs/{run['id']}")["run"]`,
    `    # "waiting_for_human" is not terminal: approve via POST /api/approvals/{id}/approve.`,
    ``,
    `artifacts = call(f"/api/workflow-runs/{run['id']}/artifacts")["artifacts"]`,
    ``,
  ].join("\n");
}

function authoritativeApprovalSnippet(): string {
  return [
    `curl -sS --fail-with-body "${SNIPPET_BASE_URL}/api/workflow-runs/$RUN_ID" \\`,
    `  -H "Authorization: Bearer ${SNIPPET_TOKEN}" | jq '.approvals'`,
    ``,
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

function authoritativeWebhookSnippet(): string {
  return [
    `// Express, server-side. The signing key is ATLAS_SECRET_KEY — treat it like a bearer.`,
    `import { createHmac, timingSafeEqual } from "node:crypto";`,
    `import express from "express";`,
    ``,
    `const app = express();`,
    ``,
    `app.post("/hook", express.raw({ type: "application/json" }), (request, response) => {`,
    `  const expected =`,
    `    "sha256=" +`,
    `    createHmac("sha256", process.env.ATLAS_SECRET_KEY!).update(request.body).digest("hex");`,
    `  const received = String(request.get("X-Atlas-Signature") ?? "");`,
    `  const a = Buffer.from(expected);`,
    `  const b = Buffer.from(received);`,
    `  if (a.length !== b.length || !timingSafeEqual(a, b)) {`,
    `    return response.status(401).send("bad signature");`,
    `  }`,
    `  const delivery = JSON.parse(request.body.toString("utf8"));`,
    `  response.status(204).end();`,
    `  void handle(delivery);`,
    `});`,
    ``,
    `// input._meta.reply = { mode: "webhook", callback_url: "$YOUR_CALLBACK_URL" } per run.`,
    `// The URL must be on Atlas's outbound allowlist and must not embed credentials.`,
    ``,
  ].join("\n");
}

export function authoritativeSnippets(ctx: AuthoritativeSnippetContext): AuthoritativeSnippets {
  return {
    curl: authoritativeCurlSnippet(ctx),
    typescript: authoritativeTypescriptSnippet(ctx),
    python: authoritativePythonSnippet(ctx),
    approval: authoritativeApprovalSnippet(),
    webhook: authoritativeWebhookSnippet(),
  };
}

export function authoritativeContractMarkdown(ctx: AuthoritativeSnippetContext): string {
  const outputs = ctx.interfaceValue.outputs ?? [];
  const lines: string[] = [
    `# Authoritative integration contract`,
    ``,
    `> **Declared, enforced by Atlas.** This \`interface\` is persisted on the workflow definition`,
    `> and validated by Atlas on every direct start. Atlas's 400/409 response is authoritative;`,
    `> this document is a convenience copy generated from the same stored value.`,
    ``,
    `- Workflow: \`${ctx.workflowId}\`, version ${ctx.workflowVersion}`,
    `- Minimum compatible Atlas commit: \`${MIN_COMPATIBLE_ATLAS_COMMIT}\``,
    ``,
    `## Request`,
    ``,
    "```json",
    JSON.stringify(
      {
        workflow_definition_id: ctx.workflowId,
        input: sampleOrEmpty(ctx),
        expected_workflow_version: ctx.workflowVersion,
      },
      null,
      2,
    ),
    "```",
    ``,
    `\`expected_workflow_version\` pins the start to this exact definition version. A stale value`,
    `answers 409 and creates no run; there is no automatic retry — decide, then resubmit.`,
    ``,
    `## input_schema`,
    ``,
    "```json",
    JSON.stringify(ctx.interfaceValue.input_schema, null, 2),
    "```",
    ``,
    `## Possible outputs`,
    ``,
  ];
  if (outputs.length === 0) {
    lines.push(`No public output is declared.`, ``);
  } else {
    lines.push(`| Key | Kind | Primary |`, `| --- | --- | --- |`);
    for (const output of outputs) {
      lines.push(
        `| \`${output.key}\` | ${output.kind} | ${output.key === ctx.interfaceValue.primary_output ? "yes" : ""} |`,
      );
    }
    lines.push(
      ``,
      `Every row is **possible**, never guaranteed: a graph can branch, so an omitted output does`,
      `not fail an otherwise successful run.`,
      ``,
    );
  }
  lines.push(
    `## Lifecycle facts (unchanged by this feature)`,
    ``,
    `| | |`,
    `| --- | --- |`,
    `| Response | \`202\` with the real run row |`,
    `| Progress | Poll \`GET /api/workflow-runs/{id}\`; no run-level event stream |`,
    `| Outputs | \`GET /api/workflow-runs/{id}/artifacts\` |`,
    `| Approvals | \`POST /api/approvals/{id}/approve\`, \`/reject\`, or \`/choose\` |`,
    `| Reply webhook | Optional, via \`input._meta.reply\`; Atlas signs the callback |`,
    `| Invalid business input | 400, field/path named in the error, no run created |`,
    `| Stale \`expected_workflow_version\` | 409, no run created, no automatic retry |`,
    ``,
    `## Trigger limitation`,
    ``,
    `\`POST /api/workflow-triggers/{id}/fire\` does **not** accept a version pin in this Atlas`,
    `version — a fixed-payload trigger (schedule, or an internal event) that cannot satisfy this`,
    `interface records a failed trigger event and starts no run, without wedging its schedule slot.`,
    ``,
  );
  return lines.join("\n");
}
