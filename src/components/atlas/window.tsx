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

import { counted } from "@/lib/plural";

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
  pluralNoun,
}: {
  count: number;
  limit: number;
  mayHaveMore: boolean;
  /** Singular — the sentence pluralizes it against `count`. */
  noun: string;
  /** Only when the plural is irregular; regular nouns take an `s`. */
  pluralNoun?: string;
}) {
  return (
    <p className="mt-4 text-xs text-muted-foreground">
      {/*
        Singular in, pluralized here. The prop used to be the plural form and was interpolated
        verbatim, so a list holding exactly one row read "Showing the 1 newest workflows" — on
        every list page in the product, in the sentence whose whole job is being precise about
        what the operator is looking at.
      */}
      Showing the {counted(count, `newest ${noun}`, `newest ${pluralNoun ?? `${noun}s`}`)} Atlas
      returned (window of {limit}).{" "}
      {mayHaveMore
        ? "The window is full, so older entries may exist — Atlas reports no total and offers no cursor."
        : "Atlas reports no total, so this is a window rather than a confirmed complete list."}
    </p>
  );
}
