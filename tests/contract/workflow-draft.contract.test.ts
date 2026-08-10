import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const functionsSource = readFileSync(
  new URL("../../src/lib/atlas-mutations.functions.ts", import.meta.url),
  "utf8",
);
const clientSource = readFileSync(
  new URL("../../src/lib/atlas-api.server.ts", import.meta.url),
  "utf8",
);

describe("AI draft server-function contract", () => {
  it("keeps the draft call session-bound, fixed, and explicitly non-retrying", () => {
    expect(functionsSource).toContain("export const draftWorkflowFn");
    expect(functionsSource).toContain("requiredDraftPrompt(data)");
    expect(functionsSource).toContain("mutate(async (token)");
    expect(functionsSource).toContain("atlasDraftWorkflow(token, data.plainLanguagePrompt");
    expect(functionsSource).toContain("timeoutMs: DRAFT_WORKFLOW_TIMEOUT_MS");
    expect(clientSource).toContain('path: "/api/workflows/draft"');
    expect(clientSource).toContain("DRAFT_WORKFLOW_TIMEOUT_MS");
  });
});
