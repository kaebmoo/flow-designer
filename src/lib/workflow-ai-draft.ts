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

export type WorkflowDraftPhase = "draft" | "create";

const DRAFT_PHASE_HEADLINE: Record<WorkflowDraftPhase, string> = {
  draft:
    "Atlas could not turn this description into a valid workflow. Try simplifying it, or splitting it into smaller workflows.",
  create: "Atlas rejected this proposal when saving it. Discard it and draft again.",
};

const BUILDER_JOB_HEADLINE =
  "The builder worker could not finish this request. Check the worker, then try again.";

/**
 * Splits an Atlas failure into a plain-language `message` and the verbatim Atlas text as
 * `detail`. A user who typed a paragraph of business process was shown
 * `workflow draft trigger at index 0 must be an object` as the headline — precise for someone
 * reading atlas/app.py, useless for them, and it names an internal field, data model, and index
 * that appear nowhere in the product. The raw string still has to reach them (it is the only
 * thing they can paste to an operator), so it is demoted to `detail`, not replaced.
 *
 * Classification keys off the structured error KIND, never the message text. A `^workflow `
 * prefix regex was written first and rejected: real validation strings such as
 * `duplicate node id: …` and `unsupported workflow condition: …` do not carry that prefix,
 * while `workflow job timed out: …` does and is not a validation error. `kind === "validation"`
 * covers every Atlas 400/422, 5xx text is already redacted upstream, and timeouts have their
 * own kind — so this stays correct when Atlas's validator wording changes.
 */
export function describeWorkflowDraftError(
  error: unknown,
  phase: WorkflowDraftPhase = "draft",
): {
  message: string;
  detail?: string;
  forbidden: boolean;
  needsBuilderSetup: boolean;
} {
  const atlasError = isClientAtlasError(error) ? error : undefined;
  const candidate =
    atlasError?.message ??
    (error instanceof Error ? error.message : "The draft could not be generated.");
  const needsBuilderSetup = /No workflow_builder worker configured/i.test(candidate);

  if (atlasError?.kind === "validation" && !needsBuilderSetup) {
    // An operational failure the user's wording cannot fix must not get "simplify your
    // description" advice.
    const headline = /^workflow_builder job failed/i.test(candidate)
      ? BUILDER_JOB_HEADLINE
      : DRAFT_PHASE_HEADLINE[phase];
    return { message: headline, detail: candidate, forbidden: false, needsBuilderSetup: false };
  }

  return {
    message: candidate,
    forbidden: atlasError?.kind === "forbidden",
    needsBuilderSetup,
  };
}
