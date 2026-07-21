import type { RunEventPageView, RunEventView } from "./atlas-mappers";

/** Keep the DOM and client-side history bounded while allowing cursor pagination to continue. */
export const RUN_EVENT_HISTORY_CAP = 500;

export interface RunEventHistory {
  events: RunEventView[];
  dropped: number;
}

export const EMPTY_RUN_EVENT_HISTORY: RunEventHistory = { events: [], dropped: 0 };

/**
 * Adds one Atlas cursor page, preserving sequence order and removing replayed rows.
 *
 * Atlas's `after` cursor is exclusive, but dedupe remains deliberate: refetches, retries, and
 * a page boundary raced by a live write must never duplicate a row in the operator's history.
 */
export function appendRunEventPage(
  history: RunEventHistory,
  page: RunEventPageView,
): RunEventHistory {
  const byId = new Map<string, RunEventView>();
  for (const event of history.events) byId.set(event.id, event);
  for (const event of page.events) byId.set(event.id, event);

  const events = [...byId.values()].sort((left, right) => left.seq - right.seq);
  const overflow = Math.max(0, events.length - RUN_EVENT_HISTORY_CAP);
  return {
    events: overflow > 0 ? events.slice(overflow) : events,
    dropped: history.dropped + overflow,
  };
}
