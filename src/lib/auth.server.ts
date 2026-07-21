/**
 * Server-only session and authentication logic.
 *
 * SERVER ONLY — never import from client code.
 *
 * The session is owned entirely by flow-designer: Atlas is bearer-token only and issues no
 * cookie of its own. We seal the Atlas bearer plus a minimal identity into an httpOnly
 * cookie using TanStack Start's `useSession`, so the token exists in exactly two places —
 * this process's memory during a request, and the sealed cookie. It is never in
 * `localStorage`, never in client state, and never in a URL.
 */

import { useSession } from "@tanstack/react-start/server";

import { AtlasError, atlasGetMeResponse, atlasLogin, atlasLogout } from "./atlas-api.server";
import type { AtlasRole, AtlasSession, AtlasUser } from "./atlas-types";
import { getServerEnv } from "./env.server";

/** Host-only cookie name. Distinct from Start's default `start` so its purpose is legible. */
export const SESSION_COOKIE_NAME = "fd_session";

/**
 * What we persist in the sealed cookie.
 *
 * Deliberately minimal: the bearer, and just enough identity to render a header without a
 * round trip. `role` here is a UX hint that may be stale — it is never an authorization
 * decision, because Atlas re-checks the real role on every call.
 */
export interface FlowDesignerSessionData {
  atlasToken: string;
  userId: string | null;
  username: string;
  role: AtlasRole;
  sessionTokenId?: string;
  sessionExpiresAt?: string;
  [key: string]: unknown;
}

function sessionConfig() {
  const env = getServerEnv();
  return {
    password: env.sessionSecret,
    name: SESSION_COOKIE_NAME,
    maxAge: env.sessionMaxAgeSeconds,
    /**
     * SECURITY: `useSession` otherwise reads a sealed session from the `x-fd_session-session`
     * request header *in preference to* the cookie. That would let a caller present a session
     * out-of-band and bypass the cookie entirely, so header-based sessions are disabled and
     * the httpOnly cookie is the only accepted carrier.
     */
    sessionHeader: false as const,
    cookie: {
      httpOnly: true,
      // Local HTTP development would drop a Secure cookie, so this tracks production HTTPS.
      secure: env.cookieSecure,
      sameSite: "lax" as const,
      path: "/",
      // No `domain`: host-only keeps the cookie off sibling subdomains.
    },
  };
}

function getSession() {
  return useSession<FlowDesignerSessionData>(sessionConfig());
}

/** The sealed session's contents, or null when there is no usable session. */
export async function readSession(): Promise<FlowDesignerSessionData | null> {
  const session = await getSession();
  const data = session.data;
  if (!data || typeof data.atlasToken !== "string" || data.atlasToken.length === 0) {
    return null;
  }
  return data as FlowDesignerSessionData;
}

export async function clearSession(): Promise<void> {
  const session = await getSession();
  await session.clear();
}

export type AuthIdentity = AtlasUser & { session?: AtlasSession };

function toSessionData(
  token: string,
  user: AtlasUser,
  session?: AtlasSession,
): FlowDesignerSessionData {
  return {
    atlasToken: token,
    userId: user.id,
    username: user.username,
    role: user.role,
    ...(session ? { sessionTokenId: session.token_id, sessionExpiresAt: session.expires_at } : {}),
  };
}

/**
 * Returns the session's Atlas bearer, or throws `unauthorized`.
 *
 * Every private server function calls this itself. A route `beforeLoad` is a navigation
 * affordance, not a security boundary — the RPC endpoint is reachable directly over HTTP by
 * anyone, so a function that trusted the UI guard would be unauthenticated in practice.
 */
export async function requireAtlasToken(): Promise<string> {
  const session = await readSession();
  if (!session) {
    throw new AtlasError("unauthorized", "You are not signed in.");
  }
  return session.atlasToken;
}

/**
 * Exchanges credentials for an Atlas bearer and seals it into the session.
 *
 * A 401 here means *bad credentials*, not an expired session — the caller renders it inline
 * on the login form rather than treating it as a sign-out.
 */
export async function loginWithAtlas(credentials: {
  username: string;
  password: string;
}): Promise<AuthIdentity> {
  const { token, user, session: atlasSession } = await atlasLogin(credentials);
  const session = await getSession();

  /**
   * Clear before update, so authenticating rotates the session rather than inheriting one.
   *
   * Merely reading a session mints and seals one, so an anonymous visitor to `/auth` already
   * holds a session id and a `createdAt` before submitting the form. Without this clear,
   * `update()` would merge into that pre-login session: the id an attacker could have fixed
   * beforehand survives authentication, and the 8-hour lifetime stays anchored to the first
   * anonymous page load instead of to sign-in.
   */
  await session.clear();
  await session.update(toSessionData(token, user, atlasSession));
  return { ...user, ...(atlasSession ? { session: atlasSession } : {}) };
}

/**
 * Resolves the live Atlas identity for the current session.
 *
 * Always asks Atlas rather than trusting the cookie's cached identity, so a role change or a
 * revoked token takes effect on the next request. A 401 means the bearer is gone (expired,
 * revoked, or logged out elsewhere), so the local session is cleared to match.
 */
export async function currentIdentity(): Promise<AuthIdentity | null> {
  const session = await readSession();
  if (!session) return null;

  try {
    const response = await atlasGetMeResponse(session.atlasToken);
    return { ...response.user, ...(response.session ? { session: response.session } : {}) };
  } catch (error) {
    if (error instanceof AtlasError && error.kind === "unauthorized") {
      await clearSession();
      return null;
    }
    // Anything else — forbidden, timeout, Atlas down — is a real condition the UI must show
    // truthfully. Swallowing it here would disguise an outage as a signed-out state.
    throw error;
  }
}

/**
 * Signs out.
 *
 * Best-effort revocation followed by an unconditional local clear: if Atlas is unreachable we
 * still must not leave a usable bearer sealed in the user's cookie. The residual risk — an
 * un-revoked Atlas token surviving until Atlas expires it — is the token-lifecycle gap
 * tracked as a production blocker in docs/ATLAS_LIMITATIONS.md.
 */
export async function logoutFromAtlas(): Promise<{ atlasRevoked: boolean }> {
  const session = await readSession();
  let atlasRevoked = false;

  if (session) {
    try {
      await atlasLogout(session.atlasToken);
      atlasRevoked = true;
    } catch {
      // Intentionally swallowed: logout must never fail in a way that keeps the user signed
      // in locally. Not logged, because the failure context can carry the bearer.
      atlasRevoked = false;
    }
  }

  await clearSession();
  return { atlasRevoked };
}
