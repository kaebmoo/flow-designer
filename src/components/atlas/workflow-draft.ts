import { isAtlasWorkflowDefaultReply } from "@/lib/atlas-types";

import type { WorkflowDefaultReply } from "./workflow-inspector";
import type { InterfaceDraftState } from "./workflow-interface-panel";

/**
 * Semantic-only draft persisted per browser tab; credentials and canvas layout never enter it.
 *
 * `interfaceDraft` is optional so a draft written before Milestone C still reads back — an older
 * entry simply recovers with no interface edit, rather than being dropped as corrupt.
 * `sample_input` inside it is exactly the value the author typed for `interface.sample_input`,
 * which is meant to be persisted to Atlas and possibly exported in a pack — recovering it here is
 * not the "never persist entered Test Run input" rule; that rule is about a *run's* business
 * input, a different and stricter case (see `workflow-test-run-dialog.tsx`).
 */
export interface SemanticWorkflowDraft {
  version: number;
  name: string;
  description: string;
  graph: Record<string, unknown>;
  policy: Record<string, unknown>;
  defaultReply: WorkflowDefaultReply;
  interfaceDraft?: InterfaceDraftState;
}

function isInterfaceDraftState(value: unknown): value is InterfaceDraftState {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<InterfaceDraftState>;
  return (
    (candidate.mode === "none" ||
      candidate.mode === "editing" ||
      candidate.mode === "unsupported") &&
    typeof candidate.inputSchemaText === "string" &&
    typeof candidate.sampleInputText === "string" &&
    candidate.outputs !== null &&
    typeof candidate.outputs === "object" &&
    !Array.isArray(candidate.outputs) &&
    typeof candidate.primaryOutput === "string"
  );
}

export function workflowDraftStorageKey(workflowId: string, version: number): string {
  return `flow-designer:draft:${workflowId}:v${version}`;
}

export function readSemanticWorkflowDraft(
  workflowId: string,
  version: number,
): SemanticWorkflowDraft | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(workflowDraftStorageKey(workflowId, version));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const candidate = parsed as Partial<SemanticWorkflowDraft>;
    if (
      candidate.version !== version ||
      typeof candidate.name !== "string" ||
      typeof candidate.description !== "string" ||
      candidate.graph === null ||
      typeof candidate.graph !== "object" ||
      Array.isArray(candidate.graph) ||
      candidate.policy === null ||
      typeof candidate.policy !== "object" ||
      Array.isArray(candidate.policy) ||
      // Absent means "inherit nothing" and is valid; anything present must be a shape the
      // editor could actually have written, or restoring it would feed a doomed payload
      // straight into the next save.
      (candidate.defaultReply !== undefined &&
        !isAtlasWorkflowDefaultReply(candidate.defaultReply)) ||
      (candidate.interfaceDraft !== undefined && !isInterfaceDraftState(candidate.interfaceDraft))
    ) {
      // sessionStorage is shared with anything else running in this tab and survives app
      // upgrades within it; a draft that fails validation is corrupt or stale, so drop it
      // rather than re-parsing the same garbage on every mount.
      clearSemanticWorkflowDraft(workflowId, version);
      return undefined;
    }
    return candidate as SemanticWorkflowDraft;
  } catch {
    return undefined;
  }
}

export function writeSemanticWorkflowDraft(workflowId: string, draft: SemanticWorkflowDraft): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      workflowDraftStorageKey(workflowId, draft.version),
      JSON.stringify(draft),
    );
  } catch {
    // Draft recovery is a convenience; a blocked/full sessionStorage must not block editing.
  }
}

export function clearSemanticWorkflowDraft(workflowId: string, version: number): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(workflowDraftStorageKey(workflowId, version));
  } catch {
    // Same reasoning as writeSemanticWorkflowDraft.
  }
}
