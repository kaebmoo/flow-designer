/** Copy for a login rate-limit response. Never claim a zero-second countdown. */
export function formatLoginRateLimitMessage(retrySeconds: number): string {
  if (Number.isInteger(retrySeconds) && retrySeconds > 0) {
    return `Atlas is rate limiting login attempts. Try again in ${retrySeconds} second${retrySeconds === 1 ? "" : "s"}.`;
  }
  return "Atlas is rate limiting login attempts. Wait a moment before trying again.";
}
