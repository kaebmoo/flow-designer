/**
 * Phase 6 security units: the shared transport error boundary, the CSRF origin matcher, and
 * the safe server log — the three places a server-internal detail could otherwise reach a
 * browser or a log line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AtlasError } from "@/lib/atlas-api.server";
import { matchesConfiguredOrigin } from "@/lib/csrf-origin";
import { resetServerEnvCache } from "@/lib/env.server";
import { logServerError } from "@/lib/safe-error-log";
import { transportBadRequest, transportErrorResponse } from "@/lib/transport-error.server";

beforeEach(() => {
  process.env.ATLAS_API_ORIGIN = "http://127.0.0.1:8787";
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "s".repeat(32);
  process.env.NODE_ENV = "test";
  resetServerEnvCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetServerEnvCache();
});

/** The exact leak shape Atlas produces: `str(exc)` from an unfiltered `except` clause. */
const PYTHON_5XX_TEXT =
  "sqlite3.OperationalError: unable to open database file /var/lib/atlas/atlas.sqlite";

describe("transportErrorResponse", () => {
  it("substitutes generic copy for an Atlas 5xx message instead of relaying it", async () => {
    const response = transportErrorResponse(
      new AtlasError("server", PYTHON_5XX_TEXT, { status: 500, fromAtlas: true }),
      "The download could not be completed.",
    );

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain("sqlite3");
    expect(body).not.toContain("/var/lib");
    expect(body).toBe("Atlas failed to process the request.");
  });

  it.each([
    ["validation", 400, "workflow graph must declare a start node"],
    ["forbidden", 403, "forbidden"],
    ["not_found", 404, "artifact not found"],
    ["conflict", 409, "workflow was modified"],
  ] as const)(
    "passes through Atlas's caller-facing %s message as %i",
    async (kind, status, message) => {
      const response = transportErrorResponse(
        new AtlasError(kind, message, { status, fromAtlas: true }),
        "fallback",
      );
      expect(response.status).toBe(status);
      await expect(response.text()).resolves.toBe(message);
    },
  );

  it.each([
    ["timeout", 504],
    ["network", 502],
    ["protocol", 502],
    ["rate_limited", 429],
    ["unauthorized", 401],
  ] as const)("maps %s to status %i", (kind, status) => {
    expect(transportErrorResponse(new AtlasError(kind, "x"), "fallback").status).toBe(status);
  });

  it("answers a non-Atlas throw with the route's own fallback, never the raw message", async () => {
    const internal = new TypeError(
      "Cannot read properties of undefined (reading 'body') at /app/src/lib/atlas-api.server.ts",
    );
    const response = transportErrorResponse(internal, "The export could not be completed.");
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe("The export could not be completed.");
    expect(body).not.toContain("atlas-api.server");
  });

  it("marks every failure response uncacheable plain text", () => {
    const response = transportErrorResponse(new AtlasError("forbidden", "no"), "fallback");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("transportBadRequest carries the rule text with a 400", async () => {
    const response = transportBadRequest("after must be a non-negative integer.");
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("after must be a non-negative integer.");
  });
});

describe("matchesConfiguredOrigin", () => {
  it.each([
    ["exact match", "http://localhost:3000", "http://localhost:3000", true],
    [
      "trailing slash on the configured value",
      "http://localhost:3000",
      "http://localhost:3000/",
      true,
    ],
    ["mixed case in the configured value", "http://localhost:3000", "HTTP://LocalHost:3000", true],
    [
      "explicit default port 443",
      "https://atlas.example.com",
      "https://atlas.example.com:443",
      true,
    ],
    ["explicit default port 80", "http://atlas.example.com", "http://atlas.example.com:80", true],
    ["different host", "http://evil.example", "http://localhost:3000", false],
    ["different port", "http://localhost:3001", "http://localhost:3000", false],
    ["different scheme", "http://atlas.example.com", "https://atlas.example.com", false],
    ["subdomain is not the origin", "http://sub.localhost:3000", "http://localhost:3000", false],
  ] as const)("%s → %s", (_name, value, configured, expected) => {
    expect(matchesConfiguredOrigin(value, configured)).toBe(expected);
  });

  it("denies when PUBLIC_ORIGIN is unset, empty, or garbage — never allows any origin", () => {
    expect(matchesConfiguredOrigin("http://localhost:3000", undefined)).toBe(false);
    expect(matchesConfiguredOrigin("http://localhost:3000", "")).toBe(false);
    expect(matchesConfiguredOrigin("http://localhost:3000", "   ")).toBe(false);
    expect(matchesConfiguredOrigin("http://localhost:3000", "not a url")).toBe(false);
  });

  it("denies an unparsable Origin header value", () => {
    expect(matchesConfiguredOrigin("null", "http://localhost:3000")).toBe(false);
    expect(matchesConfiguredOrigin("", "http://localhost:3000")).toBe(false);
  });
});

describe("logServerError", () => {
  function loggedLine(error: unknown): string {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logServerError("test", error);
    expect(spy).toHaveBeenCalledTimes(1);
    return String(spy.mock.calls[0]![0]);
  }

  it("logs kind and status for an Atlas 5xx but never its raw exception text", () => {
    const line = loggedLine(
      new AtlasError("server", PYTHON_5XX_TEXT, { status: 500, fromAtlas: true }),
    );
    expect(line).toContain("kind=server");
    expect(line).toContain("status=500");
    expect(line).not.toContain("sqlite3");
    expect(line).not.toContain("/var/lib");
  });

  it("never logs the cause chain, which can name the private Atlas origin", () => {
    const cause = new Error("connect ECONNREFUSED 10.0.0.7:8787");
    const line = loggedLine(new AtlasError("network", "Atlas is unreachable.", { cause }));
    expect(line).toContain("kind=network");
    expect(line).not.toContain("10.0.0.7");
    expect(line).not.toContain("ECONNREFUSED");
  });

  it("keeps Atlas's caller-facing validation text, which is safe by construction", () => {
    const line = loggedLine(
      new AtlasError("validation", "edge condition type is unknown", {
        status: 400,
        fromAtlas: true,
      }),
    );
    expect(line).toContain("kind=validation");
    expect(line).toContain("edge condition type is unknown");
  });

  it("logs a plain Error's stack without the cause chain", () => {
    const error = new Error("boom", { cause: new Error("secret-internal-origin") });
    const line = loggedLine(error);
    expect(line).toContain("boom");
    expect(line).not.toContain("secret-internal-origin");
  });

  it("classifies a non-Error throw without serialising it", () => {
    const line = loggedLine({ token: "sk-should-never-print" });
    expect(line).not.toContain("sk-should-never-print");
    expect(line).toContain("non-Error throw");
  });
});
