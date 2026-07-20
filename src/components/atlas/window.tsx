/**
 * Truthful framing for Atlas's bounded list windows.
 *
 * Atlas list routes accept `?limit` and nothing else — no offset, no cursor, no total, and no
 * has-more flag (`docs/BACKEND_INTEGRATION.md`, `docs/ATLAS_LIMITATIONS.md`). A UI that showed
 * "42 workflows" would be asserting a total Atlas never sent. This exists so a list reads as
 * "the newest N Atlas returned" instead.
 *
 * The search-parameter parsers live in `@/lib/atlas-search`.
 */

/**
 * States what the list is and, when the window came back full, that it may not be everything.
 *
 * A full window is the only truncation signal Atlas provides, and it is ambiguous — exactly
 * `limit` rows existing looks identical to more having been dropped. The copy says "may", because
 * that is all that can honestly be claimed.
 */
export function WindowNotice({
  count,
  limit,
  mayHaveMore,
  noun,
}: {
  count: number;
  limit: number;
  mayHaveMore: boolean;
  noun: string;
}) {
  return (
    <p className="mt-4 text-xs text-muted-foreground">
      Showing the {count} newest {noun} Atlas returned (window of {limit}).{" "}
      {mayHaveMore
        ? "The window is full, so older entries may exist — Atlas reports no total and offers no cursor."
        : "Atlas reports no total, so this is a window rather than a confirmed complete list."}
    </p>
  );
}
