import { describe, expect, it } from "vitest";

import { AtlasError } from "@/lib/atlas-api.server";
import {
  describeAtlasError,
  isClientAtlasError,
  toClientAtlasError,
  toIdentityView,
} from "@/lib/atlas-mappers";
import { ATLAS_ROLES, isAtlasRole, isAtlasUser, readAtlasErrorMessage } from "@/lib/atlas-types";

describe("toIdentityView", () => {
  it("maps an Atlas user to the view model", () => {
    expect(
      toIdentityView({ id: "usr_1", username: "operator", role: "operator", status: "active" }),
    ).toEqual({
      id: "usr_1",
      username: "operator",
      role: "operator",
      roleLabel: "Operator",
      initials: "OP",
    });
  });

  it("survives the null-id identity Atlas returns for loopback and legacy tokens", () => {
    expect(toIdentityView({ id: null, username: "local", role: "admin" })).toMatchObject({
      id: null,
      username: "local",
    });
  });

  it("labels every role Atlas can return", () => {
    for (const role of ATLAS_ROLES) {
      const view = toIdentityView({ id: "x", username: "u", role });
      expect(view.roleLabel).toBeTruthy();
      expect(view.role).toBe(role);
    }
  });
});

describe("atlas type guards", () => {
  it("accepts the four Atlas roles and rejects anything else", () => {
    expect(ATLAS_ROLES).toEqual(["admin", "operator", "viewer", "auditor"]);
    for (const role of ATLAS_ROLES) expect(isAtlasRole(role)).toBe(true);
    expect(isAtlasRole("superuser")).toBe(false);
    expect(isAtlasRole(undefined)).toBe(false);
  });

  it("requires username and a known role, and tolerates a null id", () => {
    expect(isAtlasUser({ id: null, username: "local", role: "admin" })).toBe(true);
    expect(isAtlasUser({ id: "1", username: "a", role: "viewer" })).toBe(true);
    expect(isAtlasUser({ id: 1, username: "a", role: "viewer" })).toBe(false);
    expect(isAtlasUser({ id: "1", role: "viewer" })).toBe(false);
    expect(isAtlasUser({ id: "1", username: "a", role: "nope" })).toBe(false);
    expect(isAtlasUser(null)).toBe(false);
  });

  it("reads Atlas's single-key error envelope", () => {
    expect(readAtlasErrorMessage({ error: "forbidden" })).toBe("forbidden");
    expect(readAtlasErrorMessage({ message: "forbidden" })).toBeUndefined();
    expect(readAtlasErrorMessage(null)).toBeUndefined();
  });
});

describe("toClientAtlasError", () => {
  /**
   * The redaction point. An `AtlasError` carries a `cause` that can name the private Atlas
   * origin or embed a socket error; only `kind` and `message` may cross to the browser.
   */
  it("copies only kind and message, dropping cause, status, and the private origin", () => {
    const error = new AtlasError("network", "Atlas is unreachable.", {
      status: 500,
      cause: new Error("connect ECONNREFUSED http://atlas-internal:8787"),
    });

    const client = toClientAtlasError(error);
    expect(client).toEqual({ kind: "network", message: "Atlas is unreachable." });
    expect(Object.keys(client)).toEqual(["kind", "message"]);
    expect(JSON.stringify(client)).not.toContain("atlas-internal");
    expect(JSON.stringify(client)).not.toContain("ECONNREFUSED");
  });

  it("recognises a serialised AtlasError, since instanceof does not survive RPC", () => {
    const serialised = JSON.parse(
      JSON.stringify({ name: "AtlasError", kind: "forbidden", message: "forbidden" }),
    );
    expect(isClientAtlasError(serialised)).toBe(true);
    expect(toClientAtlasError(serialised)).toEqual({ kind: "forbidden", message: "forbidden" });
  });

  it("falls back to a generic server error for anything unrecognised", () => {
    expect(toClientAtlasError(new Error("kaboom secret detail"))).toEqual({
      kind: "server",
      message: "Something went wrong talking to Atlas.",
    });
    expect(toClientAtlasError(undefined).kind).toBe("server");
  });
});

describe("describeAtlasError", () => {
  it("gives every kind distinct, non-empty copy", () => {
    const kinds = [
      "validation",
      "unauthorized",
      "forbidden",
      "not_found",
      "conflict",
      "rate_limited",
      "server",
      "timeout",
      "network",
      "protocol",
    ] as const;

    const titles = new Set<string>();
    for (const kind of kinds) {
      const presentation = describeAtlasError({ kind, message: "detail" });
      expect(presentation.title).toBeTruthy();
      expect(presentation.description).toBeTruthy();
      titles.add(presentation.title);
    }
    // Forbidden must never share presentation with not-found or signed-out.
    expect(titles.size).toBeGreaterThanOrEqual(8);
  });

  it("marks transient failures retryable and permission failures not", () => {
    expect(describeAtlasError({ kind: "timeout", message: "" }).retryable).toBe(true);
    expect(describeAtlasError({ kind: "network", message: "" }).retryable).toBe(true);
    expect(describeAtlasError({ kind: "forbidden", message: "" }).retryable).toBe(false);
    expect(describeAtlasError({ kind: "unauthorized", message: "" }).retryable).toBe(false);
  });

  it("keeps forbidden, unauthorized, and not_found visibly different", () => {
    const forbidden = describeAtlasError({ kind: "forbidden", message: "" });
    const unauthorized = describeAtlasError({ kind: "unauthorized", message: "" });
    const notFound = describeAtlasError({ kind: "not_found", message: "" });

    expect(forbidden.title).not.toBe(unauthorized.title);
    expect(forbidden.title).not.toBe(notFound.title);
    expect(unauthorized.title).not.toBe(notFound.title);
  });
});
