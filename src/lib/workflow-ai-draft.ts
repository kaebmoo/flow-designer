import type { AtlasWorkflowDraft } from "@/lib/atlas-types";
import { isClientAtlasError } from "@/lib/atlas-mappers";
import { MAX_DRAFT_PROMPT_LENGTH } from "@/lib/atlas-limits";

export { MAX_DRAFT_PROMPT_LENGTH } from "@/lib/atlas-limits";

export interface WorkflowDraftSummary {
  nodeCount: number;
  edgeCount: number;
  nodeTypes: string[];
  policyKeys: string[];
}

export function summarizeWorkflowDraft(draft: AtlasWorkflowDraft): WorkflowDraftSummary {
  const nodes = Array.isArray(draft.graph.nodes) ? draft.graph.nodes : [];
  const edges = Array.isArray(draft.graph.edges) ? draft.graph.edges : [];
  const nodeTypes = [
    ...new Set(
      nodes.flatMap((node) => {
        if (node === null || typeof node !== "object") return [];
        const type = (node as Record<string, unknown>).type;
        return typeof type === "string" && type.length > 0 ? [type] : [];
      }),
    ),
  ].sort();

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodeTypes,
    policyKeys: Object.keys(draft.policy).sort(),
  };
}

export function canSubmitWorkflowDraft(prompt: string): boolean {
  return prompt.trim().length > 0 && prompt.length <= MAX_DRAFT_PROMPT_LENGTH;
}

export function describeWorkflowDraftError(error: unknown): {
  message: string;
  forbidden: boolean;
  needsBuilderSetup: boolean;
} {
  const atlasError = isClientAtlasError(error) ? error : undefined;
  const candidate =
    atlasError?.message ??
    (error instanceof Error ? error.message : "The draft could not be generated.");
  return {
    message: candidate,
    forbidden: atlasError?.kind === "forbidden",
    needsBuilderSetup: /No workflow_builder worker configured/i.test(candidate),
  };
}
