/**
 * A safe upper bound for the delta-seconds value Atlas may expose from `Retry-After`.
 *
 * This is client-safe because both the server HTTP boundary and the browser-side error mapper
 * must enforce the same limit before a countdown is rendered.
 */
export const MAX_RETRY_AFTER_SECONDS = 3_600;
