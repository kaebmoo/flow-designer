import { describe, expect, it } from "vitest";

import { validateWorkflow } from "@/lib/workflow-graph";
import { WORKFLOW_EXAMPLES } from "@/lib/workflow-examples";

describe("starter workflows", () => {
  it("contains the four design examples", () => {
    expect(WORKFLOW_EXAMPLES.map((example) => example.name)).toEqual([
      "Daily News Brief",
      "Customer Complaint Handler",
      "Weekly Sales Report",
      "Blog Post Pipeline",
    ]);
  });

  it.each(WORKFLOW_EXAMPLES.map((example) => [example.name, example] as const))(
    "%s is valid under the local Atlas graph rules",
    (_name, example) => {
      expect(validateWorkflow(example.graph, example.policy)).toEqual([]);
    },
  );

  it("uses a human-selected edge for every complaint response choice", () => {
    const example = WORKFLOW_EXAMPLES.find(
      (candidate) => candidate.id === "customer-complaint-handler",
    );
    expect(example).toBeDefined();
    expect(
      example!.graph.edges
        .filter((edge) => edge.from === "choose_response")
        .map((edge) => edge.condition),
    ).toEqual([
      { type: "human_selected", choice: "refund" },
      { type: "human_selected", choice: "escalate" },
      { type: "human_selected", choice: "more_info" },
    ]);
  });
});
