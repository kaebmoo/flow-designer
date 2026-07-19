/**
 * API-facing Atlas types.
 *
 * These mirror what Atlas actually returns (verified against the Atlas checkout at
 * 595ef62), not what would be convenient for the UI. Components consume the view models in
 * `atlas-mappers.ts` instead of these shapes, so an Atlas response change is absorbed in one
 * place. This module is import-safe from client code: it contains types and pure guards only.
 *
 * Phase 1 covers authentication only. Domain entities arrive in Phase 2.
 */

/** The four roles Atlas recognises. Atlas is the only authority that enforces them. */
export const ATLAS_ROLES = ["admin", "operator", "viewer", "auditor"] as const;
export type AtlasRole = (typeof ATLAS_ROLES)[number];

export const ATLAS_USER_STATUSES = ["active", "disabled"] as const;
export type AtlasUserStatus = (typeof ATLAS_USER_STATUSES)[number];

/**
 * A user as returned by `POST /api/auth/login` and `GET /api/me`.
 *
 * `id` is nullable on purpose: Atlas's loopback bypass (`ATLAS_LOOPBACK_NO_AUTH`) and its
 * legacy shared-token identity both return `{"id": null, "role": "admin"}` with username
 * `local` / `legacy`. Treating `id` as a guaranteed string would crash the BFF against a
 * loopback-configured Atlas. `created_at`/`updated_at` are present on login but *absent*
 * from `/api/me`, so both are optional.
 */
export interface AtlasUser {
  id: string | null;
  username: string;
  role: AtlasRole;
  status?: AtlasUserStatus;
  created_at?: string;
  updated_at?: string;
}

/** `POST /api/auth/login` — 200. `token` is the raw bearer, shown exactly once. */
export interface AtlasLoginResponse {
  token: string;
  user: AtlasUser;
}

/** `GET /api/me` — 200. */
export interface AtlasMeResponse {
  user: AtlasUser;
}

/** `POST /api/auth/logout` — 200. */
export interface AtlasLogoutResponse {
  logged_out: boolean;
}

/**
 * Every Atlas error body is this single-key envelope (`atlas/app.py` `_json` error paths,
 * normative as `schemas.Error` in the Atlas OpenAPI document).
 */
export interface AtlasErrorBody {
  error: string;
}

/**
 * Normalised failure kinds. Every Atlas call funnels into exactly one of these so callers
 * branch on a closed union instead of re-deriving meaning from status codes.
 *
 * `conflict` and `rate_limited` are carried because the integration contract requires them,
 * but note: the Atlas build at 595ef62 never emits 409 or 429 — a duplicate username, for
 * example, surfaces as 400. They are kept so a future Atlas can adopt them without a client
 * change, not because they fire today.
 */
export type AtlasErrorKind =
  | "validation" // 400/422 — request rejected
  | "unauthorized" // 401 — no session, or the bearer is expired/revoked
  | "forbidden" // 403 — authenticated but the role lacks the permission
  | "not_found" // 404
  | "conflict" // 409
  | "rate_limited" // 429
  | "server" // 5xx
  | "timeout" // the request deadline elapsed
  | "network" // DNS/TCP/TLS failure — Atlas was never reached
  | "protocol"; // reached Atlas, but the response was not the JSON we require

export function isAtlasRole(value: unknown): value is AtlasRole {
  return typeof value === "string" && (ATLAS_ROLES as readonly string[]).includes(value);
}

/**
 * Structural guard for an Atlas user. Deliberately permissive about unknown extra fields
 * (Atlas may add some) and strict about the ones we actually depend on.
 */
export function isAtlasUser(value: unknown): value is AtlasUser {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const idOk = candidate.id === null || typeof candidate.id === "string";
  return idOk && typeof candidate.username === "string" && isAtlasRole(candidate.role);
}

/** Extracts Atlas's `{"error": "..."}` message, or undefined if the body is not that shape. */
export function readAtlasErrorMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>).error;
  return typeof candidate === "string" ? candidate : undefined;
}
