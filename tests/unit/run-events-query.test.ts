import { describe, expect, it } from "vitest";

import { runEventsQuery } from "@/lib/atlas-queries";

/**
 * `runEventsQuery`'s `placeholderData` must only bridge between pages of the *same* run and
 * window — a cursor advance ("Load more"). For any other key change (a different run, or a
 * different window-size selection) it must return `undefined` so the query falls through to a
 * real pending state, instead of quietly re-showing the previous run/window's rows as if they
 * were the new page.
 */
describe("runEventsQuery placeholderData", () => {
  const placeholderData = runEventsQuery("run_a", { limit: 25, after: 25 }).placeholderData as (
    previousData: unknown,
    previousQuery: unknown,
  ) => unknown;

  function fakeQuery(runId: string, limit: number, after: number) {
    return { queryKey: ["atlas", "runs", "events", runId, { limit, after }] } as never;
  }

  it("reuses the previous page when only the cursor advanced for the same run and window", () => {
    const previousData = { events: [{ seq: 1 }], nextAfter: 25, hasMore: true };
    expect(placeholderData(previousData, fakeQuery("run_a", 25, 0))).toBe(previousData);
  });

  it("does not reuse data across a different run", () => {
    const previousData = { events: [{ seq: 1 }], nextAfter: 25, hasMore: true };
    expect(placeholderData(previousData, fakeQuery("run_b", 25, 0))).toBeUndefined();
  });

  it("does not reuse data across a different window size", () => {
    const previousData = { events: [{ seq: 1 }], nextAfter: 25, hasMore: true };
    expect(placeholderData(previousData, fakeQuery("run_a", 100, 0))).toBeUndefined();
  });

  it("does not reuse data when there is no previous query", () => {
    const previousData = { events: [{ seq: 1 }], nextAfter: 25, hasMore: true };
    expect(placeholderData(previousData, undefined)).toBeUndefined();
  });
});
