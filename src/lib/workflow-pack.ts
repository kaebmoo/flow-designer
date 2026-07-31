/** Atlas's pack upload cap, mirrored by the browser and the import RPC validator. */
export const MAX_PACK_BYTES = 5 * 1024 * 1024;

/** A pack is intentionally opaque to the client after parsing. Atlas owns its full schema. */
export type { AtlasPackBundle } from "./atlas-types";

export interface PackPreview {
  name: string;
  version: string;
  workflowNames: string[];
  triggerCount: number;
  signed: boolean;
  schemaVersion: number | undefined;
  schemaVersionSupported: boolean;
}

export type PackPreviewResult = { ok: true; preview: PackPreview } | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Maps only the safe summary the preview needs. Missing fields stay visible as advisory values;
 * Atlas remains the authority when the user submits the unchanged bundle.
 */
export function parsePackPreview(value: unknown, byteLength?: number): PackPreviewResult {
  if (byteLength !== undefined && byteLength > MAX_PACK_BYTES) {
    return {
      ok: false,
      message: "This pack is larger than the 5 MiB client upload limit.",
    };
  }
  if (!isPlainObject(value)) {
    return { ok: false, message: "A pack must be a JSON object." };
  }

  const schemaVersion =
    typeof value.schema_version === "number" && Number.isInteger(value.schema_version)
      ? value.schema_version
      : undefined;
  const workflows = Array.isArray(value.workflows) ? value.workflows : [];
  const workflowNames = workflows.map((workflow, index) => {
    if (!isPlainObject(workflow) || typeof workflow.name !== "string" || !workflow.name.trim()) {
      return `Workflow ${index + 1}`;
    }
    return workflow.name;
  });

  return {
    ok: true,
    preview: {
      name: typeof value.name === "string" && value.name.trim() ? value.name : "Unnamed pack",
      version:
        typeof value.version === "string" && value.version.trim() ? value.version : "Missing",
      workflowNames,
      triggerCount: Array.isArray(value.triggers) ? value.triggers.length : 0,
      signed: Object.prototype.hasOwnProperty.call(value, "signature"),
      schemaVersion,
      schemaVersionSupported: schemaVersion === 1,
    },
  };
}

/** Converts a workflow name into a safe, deterministic download slug. */
export function slugifyWorkflowName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "workflow";
}

export function packFilenameForWorkflow(name: string): string {
  return `${slugifyWorkflowName(name)}.pack.json`;
}
