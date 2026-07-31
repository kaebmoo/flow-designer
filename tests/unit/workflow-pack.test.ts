import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { describeAtlasError, toClientAtlasError } from "@/lib/atlas-mappers";
import {
  MAX_PACK_BYTES,
  packFilenameForWorkflow,
  parsePackPreview,
  slugifyWorkflowName,
} from "@/lib/workflow-pack";

const validBundle = {
  schema_version: 1,
  name: "Permit pack",
  version: "1.0.0",
  description: "A portable workflow.",
  roles: [],
  sample_input: {},
  docs: "",
  workflows: [
    { name: "Permit intake", description: "", version: 1, status: "active", graph: {}, policy: {} },
    { name: "Permit review", description: "", version: 1, status: "active", graph: {}, policy: {} },
  ],
  triggers: [{ workflow: 0, name: "Inbound", type: "webhook", config: {}, enabled: true }],
};

describe("workflow pack preview", () => {
  it("maps the supported bundle summary", () => {
    expect(parsePackPreview(validBundle)).toEqual({
      ok: true,
      preview: {
        name: "Permit pack",
        version: "1.0.0",
        workflowNames: ["Permit intake", "Permit review"],
        triggerCount: 1,
        signed: false,
        schemaVersion: 1,
        schemaVersionSupported: true,
      },
    });
  });

  it("distinguishes signed packs", () => {
    const result = parsePackPreview({ ...validBundle, signature: { algorithm: "HMAC-SHA256" } });
    expect(result.ok && result.preview.signed).toBe(true);
  });

  it("keeps an unsupported schema advisory and does not rewrite it", () => {
    const result = parsePackPreview({ ...validBundle, schema_version: 2 });
    expect(result).toMatchObject({
      ok: true,
      preview: { schemaVersion: 2, schemaVersionSupported: false },
    });
  });

  it("previews incomplete object fields without inventing a valid bundle", () => {
    const result = parsePackPreview({ workflows: [{ name: "Only name" }] });
    expect(result).toMatchObject({
      ok: true,
      preview: {
        name: "Unnamed pack",
        version: "Missing",
        workflowNames: ["Only name"],
        triggerCount: 0,
        schemaVersionSupported: false,
      },
    });
  });

  it("rejects non-objects and oversized input before import", () => {
    expect(parsePackPreview([])).toEqual({ ok: false, message: "A pack must be a JSON object." });
    expect(parsePackPreview(validBundle, MAX_PACK_BYTES + 1)).toEqual({
      ok: false,
      message: "This pack is larger than the 5 MiB client upload limit.",
    });
    expect(parsePackPreview(validBundle, MAX_PACK_BYTES)).toMatchObject({ ok: true });
  });
});

describe("workflow pack filenames", () => {
  it.each([
    ["Quarterly Review", "quarterly-review"],
    ["ไทย workflow", "workflow"],
    ["a/b\\c", "a-b-c"],
    ["v1.2.3", "v1-2-3"],
    ["---", "workflow"],
  ])("sanitizes %j", (name, expected) => {
    expect(slugifyWorkflowName(name)).toBe(expected);
    expect(slugifyWorkflowName(name)).toMatch(/^[a-z0-9-]+$/);
    expect(packFilenameForWorkflow(name)).toBe(`${expected}.pack.json`);
  });
});

describe("pack action error mapping", () => {
  it("preserves Atlas validation text and forbidden meaning", () => {
    const validation = toClientAtlasError({
      kind: "validation",
      message: "pack schema_version must be 1",
    });
    const forbidden = toClientAtlasError({ kind: "forbidden", message: "permission required" });
    expect(describeAtlasError(validation).description).toBe("pack schema_version must be 1");
    expect(describeAtlasError(forbidden).description).toBe("permission required");
    expect(describeAtlasError(forbidden).title).toBe("Not allowed");
  });
});

describe("pack server boundary", () => {
  it("keeps import behind the shared session-validating mutation wrapper", () => {
    const source = readFileSync("src/lib/atlas-mutations.functions.ts", "utf8");
    const start = source.indexOf("export const importPackFn");
    const end = source.indexOf("export const validateWorkflowFn", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain(
      "mutate(async (token) => atlasImportPack(token, data))",
    );
  });
});
