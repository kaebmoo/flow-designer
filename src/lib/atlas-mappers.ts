/**
 * Adapters between raw Atlas shapes and UI view models.
 *
 * Client-safe: this module imports no `*.server.ts` and holds no secrets. It exists so that
 * components never see a raw Atlas response, and so an Atlas field rename is absorbed here
 * instead of across every component.
 *
 * Phase 1 covers identity and error presentation. Workflow graph serialization lands with
 * the editor work in Phase 3.
 */

import type { AtlasErrorKind, AtlasRole, AtlasUser } from "./atlas-types";

/**
 * An Atlas failure after it has crossed the server-function boundary.
 *
 * A thrown `AtlasError` is *serialised* on its way to the browser, so it arrives as plain
 * data and `instanceof` no longer holds. Everything the UI needs must therefore live in
 * these two fields — and nothing else may, because whatever is here reaches the browser.
 */
export interface ClientAtlasError {
  kind: AtlasErrorKind;
  message: string;
}

/** Identity for UI rendering. */
export interface IdentityView {
  id: string | null;
  username: string;
  /**
   * UX ONLY. Use this to hide or disable controls, never to authorise an action. Atlas is
   * the sole authorization authority and re-checks the real role on every call; a role
   * cached here can be stale the moment an admin changes it.
   */
  role: AtlasRole;
  roleLabel: string;
  initials: string;
}

const ROLE_LABELS: Record<AtlasRole, string> = {
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
  auditor: "Auditor",
};

export function roleLabel(role: AtlasRole): string {
  return ROLE_LABELS[role];
}

export function toIdentityView(user: AtlasUser): IdentityView {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    roleLabel: roleLabel(user.role),
    initials: user.username.slice(0, 2).toUpperCase(),
  };
}

/**
 * Recognises an Atlas failure both as a live `AtlasError` instance on the server and as its
 * serialised twin on the client, hence the structural check rather than `instanceof`.
 */
export function isClientAtlasError(value: unknown): value is ClientAtlasError {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.name === "AtlasError" || typeof candidate.kind === "string") &&
    typeof candidate.kind === "string" &&
    typeof candidate.message === "string"
  );
}

/**
 * Narrows any thrown value to the two fields that are safe to send to a browser.
 *
 * This is the redaction point. An `AtlasError` carries a `cause` that can name the private
 * Atlas origin or embed a socket error; copying only `kind` and `message` guarantees none of
 * that, and no credential, leaves the server.
 */
export function toClientAtlasError(value: unknown): ClientAtlasError {
  if (isClientAtlasError(value)) {
    return { kind: value.kind, message: value.message };
  }
  return { kind: "server", message: "Something went wrong talking to Atlas." };
}

export interface ErrorPresentation {
  title: string;
  description: string;
  /** Whether a retry could plausibly succeed without the user changing something. */
  retryable: boolean;
}

/** Single source of UI copy for every failure kind, so states stay explicit and consistent. */
export function describeAtlasError(error: ClientAtlasError): ErrorPresentation {
  switch (error.kind) {
    case "unauthorized":
      return {
        title: "Signed out",
        description: "Your Atlas session is no longer valid. Sign in again to continue.",
        retryable: false,
      };
    case "forbidden":
      return {
        title: "Not allowed",
        description:
          error.message ||
          "Your Atlas role does not permit this action. Ask an administrator if you need access.",
        retryable: false,
      };
    case "not_found":
      return {
        title: "Not found",
        description: "Atlas has no record of the thing you asked for.",
        retryable: false,
      };
    case "validation":
      return { title: "Rejected", description: error.message, retryable: false };
    case "conflict":
      return {
        title: "Conflict",
        description: `${error.message} Reload to see the current state before retrying.`,
        retryable: false,
      };
    case "rate_limited":
      return {
        title: "Slow down",
        description: "Atlas is rate limiting this client. Wait a moment and try again.",
        retryable: true,
      };
    case "timeout":
      return {
        title: "Atlas timed out",
        description: "Atlas did not respond in time. It may be busy or restarting.",
        retryable: true,
      };
    case "network":
      return {
        title: "Atlas unreachable",
        description: "The server could not reach Atlas. Check that Atlas is running.",
        retryable: true,
      };
    case "protocol":
      return {
        title: "Unexpected response",
        description: "Atlas replied with something this UI does not understand.",
        retryable: true,
      };
    case "server":
      return {
        title: "Atlas error",
        description: "Atlas failed to process the request.",
        retryable: true,
      };
  }
}
