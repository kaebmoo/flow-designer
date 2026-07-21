import { describe, expect, it } from "vitest";

import {
  appendRunEventPage,
  EMPTY_RUN_EVENT_HISTORY,
  RUN_EVENT_HISTORY_CAP,
} from "@/lib/run-event-history";
import type { RunEventPageView } from "@/lib/atlas-mappers";

function page(after: number, seqs: number[], hasMore = false): RunEventPageView {
  return {
    after,
    nextAfter: seqs.at(-1) ?? after,
    hasMore,
    events: seqs.map((seq) => ({
      id: `run:${seq}`,
      seq,
      type: "state",
      nodeKey: null,
      detail: null,
      createdAt: `2026-07-21T00:00:${String(seq).padStart(2, "0")}Z`,
    })),
  };
}

describe("appendRunEventPage", () => {
  it("deduplicates cursor replays and keeps sequence order", () => {
    let history = appendRunEventPage(EMPTY_RUN_EVENT_HISTORY, page(0, [1, 2], true));
    history = appendRunEventPage(history, page(2, [2, 3]));
    expect(history.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(history.dropped).toBe(0);
  });

  it("bounds retained history while recording evicted rows", () => {
    const seqs = Array.from({ length: RUN_EVENT_HISTORY_CAP + 3 }, (_, index) => index + 1);
    const history = appendRunEventPage(EMPTY_RUN_EVENT_HISTORY, page(0, seqs));
    expect(history.events).toHaveLength(RUN_EVENT_HISTORY_CAP);
    expect(history.events[0]?.seq).toBe(4);
    expect(history.dropped).toBe(3);
  });
});
