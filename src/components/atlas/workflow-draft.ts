import { isAtlasWorkflowDefaultReply } from "@/lib/atlas-types";

import type { WorkflowDefaultReply } from "./workflow-inspector";

/** Semantic-only draft persisted per browser tab; credentials and canvas layout never enter it. */
export interface SemanticWorkflowDraft {
  version: number;
  name: string;
  description: string;
  graph: Record<string, unknown>;
  policy: Record<string, unknown>;
  defaultReply: WorkflowDefaultReply;
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
      (candidate.defaultReply !== undefined && !isAtlasWorkflowDefaultReply(candidate.defaultReply))
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
