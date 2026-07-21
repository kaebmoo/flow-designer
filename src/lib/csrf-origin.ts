/**
 * The CSRF `origin` matcher, extracted pure so the normalisation rule is unit-testable.
 *
 * Client-safe by construction: no secrets, no environment reads — the configured value is
 * passed in by the caller (`src/start.ts` reads `PUBLIC_ORIGIN` per request).
 */

/**
 * True when `value` (a browser `Origin` header) names the same origin as `configured`
 * (`PUBLIC_ORIGIN`).
 *
 * Both sides are normalised through `URL` before comparing. A browser `Origin` header is
 * always a bare, lowercased origin, whereas `PUBLIC_ORIGIN` may be written with a trailing
 * slash, mixed case, or an explicit default port. Comparing the raw strings would reject
 * every server function on an otherwise correct deployment. An unset or unparsable
 * configured value denies rather than accepting any origin.
 */
export function matchesConfiguredOrigin(value: string, configured: string | undefined): boolean {
  const trimmed = configured?.trim();
  if (!trimmed) return false;
  try {
    return new URL(value).origin === new URL(trimmed).origin;
  } catch {
    return false;
  }
}
