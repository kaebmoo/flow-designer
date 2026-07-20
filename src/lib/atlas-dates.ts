/**
 * Validation for Atlas's audit/usage date-range boundaries.
 *
 * Client-safe and pure. Atlas accepts an inclusive ISO-8601 **date** (`YYYY-MM-DD`) or
 * **timestamp** on `from`/`to` (`atlas/usage.py:201-213`), and remains the authority — it
 * re-validates and 400s anything it dislikes (including `from > to`). This helper only
 * bounds and sanity-checks untrusted input at the trust boundary so a garbage value is
 * rejected with a clear message instead of being forwarded.
 */

const MAX_BOUNDARY_LENGTH = 40;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalises one optional boundary value.
 *
 * Returns `undefined` for absent/empty, the trimmed string when it looks like an ISO date or
 * a parseable timestamp, and throws otherwise. The error names the rule, never the value.
 */
export function parseDateBoundary(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be an ISO-8601 date or timestamp.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_BOUNDARY_LENGTH) {
    throw new Error(`${field} is too long.`);
  }
  if (ISO_DATE.test(trimmed)) return trimmed;
  if (!Number.isNaN(Date.parse(trimmed))) return trimmed;
  throw new Error(`${field} must be an ISO-8601 date or timestamp.`);
}
