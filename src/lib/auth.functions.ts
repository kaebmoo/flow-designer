/**
 * Authentication RPC boundary.
 *
 * `createServerFn` bodies are replaced by a network call in the browser bundle, so routes and
 * components may import this module directly — the server-only code it calls never ships.
 * Import these statically; a dynamic import would defeat that transform.
 *
 * Every function here re-validates the session on its own. These endpoints are reachable
 * directly over HTTP, so a route `beforeLoad` guarantees nothing about the caller.
 */

import { createServerFn } from "@tanstack/react-start";

import { currentIdentity, loginWithAtlas, logoutFromAtlas } from "./auth.server";
import {
  toClientAtlasError,
  toIdentityView,
  type ClientAtlasError,
  type IdentityView,
} from "./atlas-mappers";

/** Bounds on credential input, applied before anything reaches Atlas. */
const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1024;

export interface LoginInput {
  username: string;
  password: string;
}

export type LoginResult =
  | { ok: true; identity: IdentityView }
  | { ok: false; error: ClientAtlasError };

/**
 * Every distinct state the UI must render, made explicit rather than collapsed into
 * "identity or nothing" — an Atlas outage must not be indistinguishable from a sign-out.
 */
export type IdentityResult =
  | { status: "authenticated"; identity: IdentityView }
  | { status: "unauthenticated" }
  | { status: "error"; error: ClientAtlasError };

/**
 * Validates untrusted client input at the trust boundary.
 *
 * Throws a message that describes the *rule*, never the submitted value, so a password can
 * never appear in an error, a log line, or a serialised response.
 */
function validateLoginInput(data: unknown): LoginInput {
  if (data === null || typeof data !== "object") {
    throw new Error("Expected a username and password.");
  }
  const { username, password } = data as Record<string, unknown>;

  if (typeof username !== "string" || username.trim().length === 0) {
    throw new Error("Username is required.");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password is required.");
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    throw new Error("Username is too long.");
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Password is too long.");
  }

  return { username: username.trim(), password };
}

/**
 * Signs in against Atlas and seals the resulting bearer into the session cookie.
 *
 * Returns a result object rather than throwing on bad credentials: a 401 here is ordinary
 * form feedback, not an expired session, and must not trigger a redirect. The response
 * carries an identity view only — the bearer stays server-side.
 */
export const loginFn = createServerFn({ method: "POST" })
  .validator(validateLoginInput)
  .handler(async ({ data }): Promise<LoginResult> => {
    try {
      const user = await loginWithAtlas(data);
      return { ok: true, identity: toIdentityView(user) };
    } catch (error) {
      return { ok: false, error: toClientAtlasError(error) };
    }
  });

/**
 * Resolves the live Atlas identity for the current session.
 *
 * Validates the session itself, then asks Atlas — the cookie's cached role is never trusted
 * as an answer. An expired or revoked bearer yields `unauthenticated` and a cleared session.
 */
export const getIdentityFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<IdentityResult> => {
    try {
      const user = await currentIdentity();
      if (!user) return { status: "unauthenticated" };
      return { status: "authenticated", identity: toIdentityView(user) };
    } catch (error) {
      // Forbidden stays forbidden, a timeout stays a timeout. Never relabelled as signed-out.
      return { status: "error", error: toClientAtlasError(error) };
    }
  },
);

/** Revokes the Atlas token where possible and always clears the local session. */
export const logoutFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ atlasRevoked: boolean }> => logoutFromAtlas(),
);
