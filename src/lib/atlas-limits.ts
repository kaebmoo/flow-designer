/**
 * Atlas's list-window bounds.
 *
 * Client-safe on purpose: both the server client and the URL-search parsers in the browser
 * must clamp to the *same* range, or the UI would believe it asked for a window Atlas never
 * applied. Atlas clamps `?limit` to 1..10000 and silently substitutes its default for any
 * non-integer rather than rejecting it (`atlas/app.py:76-87`).
 */

export const ATLAS_LIMIT_MIN = 1;
export const ATLAS_LIMIT_MAX = 10_000;
export const ATLAS_DEFAULT_LIMIT = 100;

export function clampAtlasLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return ATLAS_DEFAULT_LIMIT;
  return Math.max(ATLAS_LIMIT_MIN, Math.min(Math.trunc(limit), ATLAS_LIMIT_MAX));
}
