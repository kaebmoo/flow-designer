import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSemanticWorkflowDraft,
  readSemanticWorkflowDraft,
  writeSemanticWorkflowDraft,
} from "@/components/atlas/workflow-draft";

describe("semantic workflow draft recovery", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
  });

  it("round-trips semantic fields and never needs layout or credentials", () => {
    writeSemanticWorkflowDraft("wfd_1", {
      version: 3,
      name: "local",
      description: "draft",
      graph: { start: "worker_1" },
      policy: {},
      defaultReply: { mode: "webhook", x_ext: "preserve" },
    });
    expect(readSemanticWorkflowDraft("wfd_1", 3)).toEqual({
      version: 3,
      name: "local",
      description: "draft",
      graph: { start: "worker_1" },
      policy: {},
      defaultReply: { mode: "webhook", x_ext: "preserve" },
    });
    expect(JSON.stringify([...store.values()])).not.toMatch(/token|bearer|password|layout/i);
  });

  it("rejects a draft saved against another server version and clears explicitly", () => {
    writeSemanticWorkflowDraft("wfd_1", {
      version: 3,
      name: "local",
      description: "",
      graph: {},
      policy: {},
      defaultReply: undefined,
    });
    expect(readSemanticWorkflowDraft("wfd_1", 4)).toBeUndefined();
    clearSemanticWorkflowDraft("wfd_1", 3);
    expect(readSemanticWorkflowDraft("wfd_1", 3)).toBeUndefined();
  });
});
