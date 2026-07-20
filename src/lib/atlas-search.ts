/**
 * URL search-parameter parsing for Atlas list windows.
 *
 * Pure functions, kept out of the component file so a fast-refresh boundary stays clean. They
 * run against untrusted URL input — a hand-edited, truncated, or stale link — so nothing here
 * throws: an unusable value falls back to the default rather than breaking the page, which is
 * also what Atlas itself does with a bad `?limit` (`atlas/app.py:79-87`).
 */

import { ATLAS_DEFAULT_LIMIT, clampAtlasLimit } from "./atlas-limits";

/** Window sizes offered in the UI. Every one is inside Atlas's own 1..10000 clamp. */
export const ATLAS_LIMIT_OPTIONS = [25, 100, 500] as const;

export function parseLimitSearch(value: unknown): number {
  if (value === undefined || value === null || value === "") return ATLAS_DEFAULT_LIMIT;
  const parsed = typeof value === "number" ? value : Number(value);
  return clampAtlasLimit(Number.isFinite(parsed) ? parsed : undefined);
}

/** Normalises an optional string search param; absent and empty both become undefined. */
export function parseStringSearch(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
