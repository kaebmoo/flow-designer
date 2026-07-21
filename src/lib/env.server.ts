/**
 * Server-only environment validation.
 *
 * Fail-fast: an invalid or missing variable throws before any request is served, and the
 * thrown message names only the *variable* and the *rule it broke* — never the value, so a
 * bad `SESSION_SECRET` can never be echoed into a log, an error page, or a stack trace.
 *
 * This module must never be imported by client code. `process.env` is read at request time
 * (via the memoised `getServerEnv()`), not at module evaluation, so the bundler never has a
 * chance to inline a secret.
 */

export const SESSION_SECRET_MIN_LENGTH = 32;
export const DEFAULT_SESSION_MAX_AGE_SECONDS = 28_800; // 8 hours, confirmed for Phase 1.
export const EXAMPLE_SESSION_SECRET = "replace-me-with-at-least-32-random-characters";

export type NodeEnv = "development" | "production" | "test";

export interface ServerEnv {
  /** Private Atlas base origin. Server-to-server only; never reaches the browser. */
  atlasApiOrigin: string;
  /** Seals the session cookie. Never logged, never serialised, never sent to the client. */
  sessionSecret: string;
  /** This app's own public origin, used for the CSRF origin check. */
  publicOrigin: string;
  nodeEnv: NodeEnv;
  sessionMaxAgeSeconds: number;
  isProduction: boolean;
  /** `Secure` cookie flag: production HTTPS only, so local HTTP dev still works. */
  cookieSecure: boolean;
}

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    // Only variable names and rule descriptions reach this message — never a value.
    super(`Invalid server environment:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

type EnvSource = Record<string, string | undefined>;

/** Parses an absolute http(s) origin and rejects anything carrying a path, query, or hash. */
function readOrigin(source: EnvSource, name: string, issues: string[]): string | undefined {
  const raw = source[name]?.trim();
  if (!raw) {
    issues.push(`${name} is required`);
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issues.push(`${name} must be an absolute URL (for example http://127.0.0.1:8787)`);
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    issues.push(`${name} must use http or https`);
    return undefined;
  }
  // A trailing slash is the only path we tolerate; anything else means someone put a route
  // in an origin variable, which would silently corrupt every URL we build from it.
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    issues.push(`${name} must be an origin only, without a path, query, or fragment`);
    return undefined;
  }

  return url.origin;
}

export function parseServerEnv(source: EnvSource): ServerEnv {
  const issues: string[] = [];

  const atlasApiOrigin = readOrigin(source, "ATLAS_API_ORIGIN", issues);
  const publicOrigin = readOrigin(source, "PUBLIC_ORIGIN", issues);

  const sessionSecret = source.SESSION_SECRET;
  if (!sessionSecret) {
    issues.push("SESSION_SECRET is required");
  } else if (sessionSecret.length < SESSION_SECRET_MIN_LENGTH) {
    issues.push(`SESSION_SECRET must be at least ${SESSION_SECRET_MIN_LENGTH} characters`);
  }

  const rawNodeEnv = source.NODE_ENV?.trim() || "development";
  if (rawNodeEnv !== "development" && rawNodeEnv !== "production" && rawNodeEnv !== "test") {
    issues.push("NODE_ENV must be one of development, production, test");
  }
  const nodeEnv = rawNodeEnv as NodeEnv;

  let sessionMaxAgeSeconds = DEFAULT_SESSION_MAX_AGE_SECONDS;
  const rawMaxAge = source.SESSION_MAX_AGE?.trim();
  if (rawMaxAge) {
    const parsed = Number(rawMaxAge);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      issues.push("SESSION_MAX_AGE must be a positive whole number of seconds");
    } else {
      sessionMaxAgeSeconds = parsed;
    }
  }

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  const isProduction = nodeEnv === "production";

  /**
   * Production invariants belong in startup validation, not only in a deployment checklist.
   * A production process on HTTP cannot set the required Secure session cookie, and the
   * committed example secret is intentionally public. Refuse both before serving a request.
   */
  if (isProduction && publicOrigin && !publicOrigin.startsWith("https://")) {
    issues.push("PUBLIC_ORIGIN must use https when NODE_ENV is production");
  }
  if (isProduction && sessionSecret === EXAMPLE_SESSION_SECRET) {
    issues.push("SESSION_SECRET must be replaced with a generated production secret");
  }

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  return {
    atlasApiOrigin: atlasApiOrigin!,
    sessionSecret: sessionSecret!,
    publicOrigin: publicOrigin!,
    nodeEnv,
    sessionMaxAgeSeconds,
    isProduction,
    /**
     * Driven by the deployed scheme alone, deliberately *not* by `NODE_ENV`.
     *
     * `NODE_ENV` silently defaults to "development" when unset, and some runtimes (Cloudflare
     * Workers, for one) do not populate it unless a var is declared. Gating on it would drop
     * `Secure` from the cookie carrying the Atlas bearer on a real HTTPS deployment — failing
     * open on the one flag that keeps it off cleartext. The origin is already validated above,
     * so its scheme is the honest signal: https gets `Secure`, local http dev does not.
     */
    cookieSecure: publicOrigin!.startsWith("https://"),
  };
}

let cached: ServerEnv | undefined;

/** Memoised per process. Reads `process.env` at call time, never at module load. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env as EnvSource);
  return cached;
}

/** Test-only escape hatch so a suite can re-parse a different environment. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
