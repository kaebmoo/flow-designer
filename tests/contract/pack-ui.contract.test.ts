/**
 * Milestone D pack contract against a real isolated Atlas.
 *
 * Atlas is only read from. Each test run gets a fresh database and secret key, so the assertions
 * cover the actual pack validator, atomic import, signature policy, and default-reply gap.
 */

import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AtlasError,
  atlasCreateWorkflow,
  atlasCreateWorkflowTrigger,
  atlasExportPack,
  atlasGetWorkflow,
  atlasImportPack,
  atlasListWorkflowTriggers,
  atlasListWorkflows,
  atlasLogin,
} from "@/lib/atlas-api.server";
import type { AtlasPackBundle, AtlasWorkflowInterface } from "@/lib/atlas-types";
import { resetServerEnvCache } from "@/lib/env.server";
import {
  ADMIN_CREDENTIALS,
  atlasAvailable,
  startIsolatedAtlas,
  type AtlasInstance,
} from "./atlas-instance";

const available = atlasAvailable();
let atlas: AtlasInstance | undefined;
let adminToken = "";

beforeAll(async () => {
  if (!available) return;
  atlas = await startIsolatedAtlas();
  process.env.ATLAS_API_ORIGIN = atlas.origin;
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "e".repeat(32);
  process.env.NODE_ENV = "test";
  resetServerEnvCache();
  adminToken = (await atlasLogin(ADMIN_CREDENTIALS)).token;
}, 60_000);

afterAll(() => {
  const output = atlas?.logs() ?? "";
  if (output.trim()) console.log(`--- Atlas server output ---\n${output}`);
  atlas?.stop();
  resetServerEnvCache();
});

let uniqueCounter = 0;
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix} ${uniqueCounter}`;
}

const PACK_GRAPH = {
  start: "intake",
  nodes: [
    {
      id: "intake",
      type: "worker",
      prompt: "applicant: {input.applicant_name}",
      outputs: ["intake_review"],
    },
    {
      id: "assessment",
      type: "worker",
      prompt: "review {artifact.intake_review}",
      outputs: ["assessment_result"],
    },
  ],
  edges: [{ from: "intake", to: "assessment", condition: { type: "always" } }],
};

const PACK_INTERFACE: AtlasWorkflowInterface = {
  schema_version: 1,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["applicant_name"],
    properties: { applicant_name: { type: "string", minLength: 1 } },
  },
  sample_input: { applicant_name: "Test Applicant" },
  outputs: [{ key: "intake_review", kind: "text" }],
  primary_output: "intake_review",
};

async function createPackWorkflow(
  overrides: {
    default_reply?: Record<string, unknown>;
    interface?: AtlasWorkflowInterface | null;
  } = {},
) {
  return atlasCreateWorkflow(adminToken, {
    name: uniqueName("Pack workflow"),
    description: "Pack contract fixture.",
    graph: PACK_GRAPH,
    policy: { max_jobs: 2 },
    interface: "interface" in overrides ? overrides.interface : PACK_INTERFACE,
    ...(overrides.default_reply === undefined ? {} : { default_reply: overrides.default_reply }),
  });
}

function atlasErrorFrom(error: unknown): AtlasError {
  if (!(error instanceof AtlasError)) throw new Error(`expected AtlasError, got ${String(error)}`);
  return error;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => key !== "signature")
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function signedBundle(bundle: AtlasPackBundle): AtlasPackBundle {
  const value = createHmac("sha256", "contract-test-secret-key")
    .update(canonicalJson(bundle), "utf8")
    .digest("hex");
  return { ...bundle, signature: { algorithm: "HMAC-SHA256", value } };
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) => /token|secret/i.test(key) || containsSensitiveKey(nested),
  );
}

describe.skipIf(!available)("Atlas pack UI contract", () => {
  it("exports the interface and trigger shape without token or secret fields", async () => {
    const workflow = await createPackWorkflow();
    await atlasCreateWorkflowTrigger(adminToken, {
      workflowDefinitionId: workflow.id,
      name: "Inbound webhook",
      type: "webhook",
      enabled: true,
      config: { path: "/pack/inbound" },
    });

    const bundle = await atlasExportPack(adminToken, workflow.id);
    expect(bundle.schema_version).toBe(1);
    expect(bundle.workflows).toHaveLength(1);
    expect(bundle.workflows[0]).toMatchObject({
      name: workflow.name,
      graph: PACK_GRAPH,
      policy: { max_jobs: 2 },
    });
    expect(bundle.workflows[0]?.interface).toEqual(PACK_INTERFACE);
    expect(bundle.triggers).toEqual([
      {
        workflow: 0,
        name: "Inbound webhook",
        type: "webhook",
        config: { path: "/pack/inbound" },
        enabled: true,
      },
    ]);
    expect(containsSensitiveKey(bundle)).toBe(false);
  });

  it("returns Atlas's actual 400 for an unknown export id", async () => {
    const error = atlasErrorFrom(
      await atlasExportPack(adminToken, "wfd_missing").catch((value) => value),
    );
    expect(error.status).toBe(400);
    expect(error.kind).toBe("validation");
  });

  it("imports with fresh ids and importing again creates another copy", async () => {
    const original = await createPackWorkflow();
    await atlasCreateWorkflowTrigger(adminToken, {
      workflowDefinitionId: original.id,
      name: "Copy trigger",
      type: "webhook",
      enabled: true,
      config: { path: "/pack/copy" },
    });
    const bundle = await atlasExportPack(adminToken, original.id);

    const first = await atlasImportPack(adminToken, bundle);
    const second = await atlasImportPack(adminToken, bundle);
    expect(first.workflows).toHaveLength(1);
    expect(second.workflows).toHaveLength(1);
    expect(first.workflows[0]!.id).not.toBe(original.id);
    expect(second.workflows[0]!.id).not.toBe(first.workflows[0]!.id);

    const imported = await atlasGetWorkflow(adminToken, first.workflows[0]!.id);
    expect(imported.graph).toEqual(original.graph);
    expect(imported.policy).toEqual(original.policy);
    expect(imported.interface).toEqual(original.interface);
    const triggers = await atlasListWorkflowTriggers(adminToken, {
      limit: 100,
      workflowDefinitionId: imported.id,
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      workflow_definition_id: imported.id,
      name: "Copy trigger",
    });
  });

  it("rolls back every workflow when a later workflow is invalid", async () => {
    const source = await createPackWorkflow();
    const bundle = await atlasExportPack(adminToken, source.id);
    const before = (await atlasListWorkflows(adminToken, { limit: 500 })).length;
    const invalid = {
      ...bundle,
      workflows: [
        bundle.workflows[0],
        {
          ...bundle.workflows[0],
          name: uniqueName("Invalid pack workflow"),
          graph: { start: "missing", nodes: [], edges: [] },
        },
      ],
    } as unknown as AtlasPackBundle;

    const error = atlasErrorFrom(
      await atlasImportPack(adminToken, invalid).catch((value) => value),
    );
    expect(error.status).toBe(400);
    expect((await atlasListWorkflows(adminToken, { limit: 500 })).length).toBe(before);
  });

  it("enforces the same interface profile inside a pack", async () => {
    const source = await createPackWorkflow();
    const bundle = await atlasExportPack(adminToken, source.id);
    const before = (await atlasListWorkflows(adminToken, { limit: 500 })).length;
    const invalid = {
      ...bundle,
      workflows: [
        {
          ...bundle.workflows[0],
          interface: {
            ...PACK_INTERFACE,
            input_schema: { type: ["object", "null"] },
          } as unknown as Record<string, unknown>,
        },
      ],
    } as unknown as AtlasPackBundle;

    const error = atlasErrorFrom(
      await atlasImportPack(adminToken, invalid).catch((value) => value),
    );
    expect(error.status).toBe(400);
    expect((await atlasListWorkflows(adminToken, { limit: 500 })).length).toBe(before);
  });

  it("accepts a valid signature, rejects tampering, and accepts unsigned packs", async () => {
    const source = await createPackWorkflow();
    const bundle = await atlasExportPack(adminToken, source.id);
    await atlasImportPack(adminToken, signedBundle(bundle));

    const tampered = { ...signedBundle(bundle), description: "tampered" } as AtlasPackBundle;
    const signatureError = atlasErrorFrom(
      await atlasImportPack(adminToken, tampered).catch((value) => value),
    );
    expect(signatureError.status).toBe(400);
    expect(signatureError.message).toMatch(/signature/i);
    await atlasImportPack(adminToken, bundle);
  });

  it("leaves schema_version 2 to Atlas, which rejects it verbatim", async () => {
    const source = await createPackWorkflow();
    const bundle = {
      ...(await atlasExportPack(adminToken, source.id)),
      schema_version: 2,
    } as AtlasPackBundle;
    const error = atlasErrorFrom(await atlasImportPack(adminToken, bundle).catch((value) => value));
    expect(error.status).toBe(400);
    expect(error.message).toBe("pack schema_version must be 1");
  });

  it("documents that export omits default_reply and import restores none", async () => {
    const source = await createPackWorkflow({ default_reply: { mode: "none" } });
    expect(source.default_reply).toEqual({ mode: "none" });
    const bundle = await atlasExportPack(adminToken, source.id);
    expect(bundle.workflows[0]).not.toHaveProperty("default_reply");

    const imported = await atlasImportPack(adminToken, bundle);
    const copy = await atlasGetWorkflow(adminToken, imported.workflows[0]!.id);
    expect(copy.default_reply == null || Object.keys(copy.default_reply).length === 0).toBe(true);
  });
});
