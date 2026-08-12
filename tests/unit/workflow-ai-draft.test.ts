import { describe, expect, it } from "vitest";

import type { AtlasWorkflowDraft } from "@/lib/atlas-types";
import {
  canSubmitWorkflowDraft,
  describeWorkflowDraftError,
  MAX_DRAFT_PROMPT_LENGTH,
  summarizeWorkflowDraft,
} from "@/lib/workflow-ai-draft";

const draft: AtlasWorkflowDraft = {
  name: "Complaint handler",
  description: "Routes customer complaints.",
  graph: {
    start: "classify",
    nodes: [
      { id: "classify", type: "worker" },
      { id: "decision", type: "manager" },
      { id: "gate", type: "human_gate" },
    ],
    edges: [],
  },
  policy: { max_iterations: 3 },
  triggers: [{ type: "manual" }],
  explanation: "Classify, decide, then escalate.",
  warnings: ["Review the worker assignments."],
};

describe("AI workflow draft helpers", () => {
  it("summarizes proposal shape without inventing graph details", () => {
    expect(summarizeWorkflowDraft(draft)).toEqual({
      nodeCount: 3,
      edgeCount: 0,
      nodeTypes: ["human_gate", "manager", "worker"],
      policyKeys: ["max_iterations"],
    });
  });

  it("bounds blank and overlong prompts", () => {
    expect(canSubmitWorkflowDraft("  ")).toBe(false);
    expect(canSubmitWorkflowDraft("describe it")).toBe(true);
    expect(canSubmitWorkflowDraft("x".repeat(MAX_DRAFT_PROMPT_LENGTH + 1))).toBe(false);
  });

  it("maps setup failures while preserving Atlas text", () => {
    expect(describeWorkflowDraftError(new Error("No workflow_builder worker configured"))).toEqual({
      message: "No workflow_builder worker configured",
      forbidden: false,
      needsBuilderSetup: true,
    });
  });

  it("uses the structured Atlas error kind for forbidden state", () => {
    expect(describeWorkflowDraftError({ kind: "forbidden", message: "Access denied" })).toEqual({
      message: "Access denied",
      forbidden: true,
      needsBuilderSetup: false,
    });
  });

  it("demotes validator jargon to a technical detail behind a plain-language headline", () => {
    const result = describeWorkflowDraftError({
      kind: "validation",
      message: "workflow draft trigger at index 0 must be an object",
    });
    expect(result.message).toContain("could not turn this description into a valid workflow");
    expect(result.detail).toBe("workflow draft trigger at index 0 must be an object");
    expect(result.forbidden).toBe(false);
    expect(result.needsBuilderSetup).toBe(false);
  });

  it("classifies on the error kind, not a message prefix", () => {
    // `duplicate node id` is a real Atlas validation string with no `workflow ` prefix; a prefix
    // regex would have leaked it raw. This case is why the rule keys off `kind`.
    const result = describeWorkflowDraftError({
      kind: "validation",
      message: "duplicate node id: gate",
    });
    expect(result.message).toContain("could not turn this description into a valid workflow");
    expect(result.detail).toBe("duplicate node id: gate");
  });

  it("does not tell the user to simplify wording when the builder job itself failed", () => {
    const result = describeWorkflowDraftError({
      kind: "validation",
      message: "workflow_builder job failed: builder worker exploded",
    });
    expect(result.message).toContain("builder worker could not finish");
    expect(result.message).not.toContain("simplifying");
    expect(result.detail).toBe("workflow_builder job failed: builder worker exploded");
    expect(result.needsBuilderSetup).toBe(false);
  });

  it("keeps the builder-setup case verbatim with no disclosure", () => {
    expect(
      describeWorkflowDraftError({
        kind: "validation",
        message: "No workflow_builder worker configured",
      }),
    ).toEqual({
      message: "No workflow_builder worker configured",
      forbidden: false,
      needsBuilderSetup: true,
    });
  });

  it("leaves non-validation kinds exactly as they were", () => {
    expect(
      describeWorkflowDraftError({
        kind: "server",
        message: "Atlas failed to process the request.",
      }),
    ).toEqual({
      message: "Atlas failed to process the request.",
      forbidden: false,
      needsBuilderSetup: false,
    });
  });

  it("gives the save phase different advice than the draft phase", () => {
    const error = { kind: "validation", message: "duplicate node id: gate" };
    const drafting = describeWorkflowDraftError(error, "draft");
    const saving = describeWorkflowDraftError(error, "create");
    expect(saving.message).not.toBe(drafting.message);
    expect(saving.message).toContain("Discard it and draft again");
    expect(saving.detail).toBe("duplicate node id: gate");
  });
});
