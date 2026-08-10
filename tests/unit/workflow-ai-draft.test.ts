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

  it("maps setup and permission failures while preserving Atlas text", () => {
    expect(describeWorkflowDraftError(new Error("No workflow_builder worker configured"))).toEqual({
      message: "No workflow_builder worker configured",
      forbidden: false,
      needsBuilderSetup: true,
    });
    expect(
      describeWorkflowDraftError(new Error("role does not allow this operation")),
    ).toMatchObject({
      message: "role does not allow this operation",
      forbidden: true,
    });
  });
});
