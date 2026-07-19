import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AtlasError,
  atlasErrorKindForStatus,
  atlasGetMe,
  atlasLogin,
  atlasLogout,
} from "@/lib/atlas-api.server";
import { resetServerEnvCache } from "@/lib/env.server";

const ATLAS_ORIGIN = "http://127.0.0.1:8787";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ADMIN_USER = { id: "usr_1", username: "admin", role: "admin", status: "active" };

beforeEach(() => {
  process.env.ATLAS_API_ORIGIN = ATLAS_ORIGIN;
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "s".repeat(32);
  process.env.NODE_ENV = "test";
  resetServerEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetServerEnvCache();
});

describe("atlasErrorKindForStatus", () => {
  it.each([
    [400, "validation"],
    [422, "validation"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [500, "server"],
    [503, "server"],
    [418, "validation"],
  ])("maps %i to %s", (status, kind) => {
    expect(atlasErrorKindForStatus(status)).toBe(kind);
  });
});

describe("request construction", () => {
  it("sends the bearer in the Authorization header and never in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ user: ADMIN_USER }));
    vi.stubGlobal("fetch", fetchMock);

    await atlasGetMe("secret-token-value");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ATLAS_ORIGIN}/api/me`);
    expect(String(url)).not.toContain("secret-token-value");
    expect(init.headers.authorization).toBe("Bearer secret-token-value");
    expect(init.method).toBe("GET");
  });

  it("does not attach an Authorization header to login", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token: "tok", user: ADMIN_USER }));
    vi.stubGlobal("fetch", fetchMock);

    await atlasLogin({ username: "admin", password: "pw" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ username: "admin", password: "pw" });
  });

  // Atlas reads request bodies by Content-Length; a POST with no body desyncs its parser.
  it("always sends a JSON body on POST, even when there is nothing to send", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ logged_out: true }));
    vi.stubGlobal("fetch", fetchMock);

    await atlasLogout("tok");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.body).toBe("{}");
    expect(init.headers["content-type"]).toBe("application/json");
  });

  /**
   * Guards the workaround for Atlas's keep-alive desync: it rejects a POST with 401/403
   * before draining the body, poisoning the pooled connection for a later request.
   */
  it("closes the connection after a POST but reuses it for GET", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ logged_out: true }));
    vi.stubGlobal("fetch", fetchMock);
    await atlasLogout("tok");
    expect(fetchMock.mock.calls[0]![1].headers.connection).toBe("close");

    const getMock = vi.fn().mockResolvedValue(jsonResponse({ user: ADMIN_USER }));
    vi.stubGlobal("fetch", getMock);
    await atlasGetMe("tok");
    // A GET carries no body, so it can never desync and need not pay for a new connection.
    expect(getMock.mock.calls[0]![1].headers.connection).toBeUndefined();
  });

  it("refuses to follow redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ user: ADMIN_USER }));
    vi.stubGlobal("fetch", fetchMock);

    await atlasGetMe("tok");

    expect(fetchMock.mock.calls[0]![1].redirect).toBe("error");
  });
});

describe("error normalisation", () => {
  it.each([
    [400, "validation"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [500, "server"],
  ])("turns HTTP %i into kind %s and keeps Atlas's message", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, status)));

    const error = await atlasGetMe("tok").catch((e) => e);
    expect(error).toBeInstanceOf(AtlasError);
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.message).toBe("boom");
    expect(error.fromAtlas).toBe(true);
  });

  it("falls back to its own copy when Atlas sends no usable error text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ nope: 1 }, 403)));

    const error = await atlasGetMe("tok").catch((e) => e);
    expect(error.kind).toBe("forbidden");
    expect(error.fromAtlas).toBe(false);
    expect(error.message).toMatch(/role does not allow/i);
  });

  // 403 must stay 403. Collapsing it into 401 or 404 hides a real permission problem.
  it("keeps forbidden distinct from unauthorized and not_found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "forbidden" }, 403)));
    const forbidden = await atlasGetMe("tok").catch((e) => e);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401)));
    const unauthorized = await atlasGetMe("tok").catch((e) => e);

    expect(forbidden.kind).toBe("forbidden");
    expect(unauthorized.kind).toBe("unauthorized");
    expect(forbidden.kind).not.toBe(unauthorized.kind);
  });

  it("classifies a DNS/TCP failure as network, not as a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const error = await atlasGetMe("tok").catch((e) => e);
    expect(error).toBeInstanceOf(AtlasError);
    expect(error.kind).toBe("network");
    expect(error.status).toBeUndefined();
  });

  it("classifies an elapsed deadline as timeout", async () => {
    // Never settles on its own; only the internal AbortSignal.timeout ends it.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason));
          }),
      ),
    );

    // A tiny deadline keeps the test fast without faking timers.
    const error = await atlasLogin({ username: "a", password: "b" }, { timeoutMs: 20 }).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(AtlasError);
    expect(error.kind).toBe("timeout");
  });

  it("propagates a caller-initiated abort untouched rather than reporting a failure", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason));
          }),
      ),
    );

    const pending = atlasGetMe("tok", { signal: controller.signal }).catch((e) => e);
    controller.abort(new Error("navigated away"));

    const error = await pending;
    expect(error).not.toBeInstanceOf(AtlasError);
    expect(error.message).toBe("navigated away");
  });

  it("rejects a non-JSON body as a protocol error instead of parsing it", async () => {
    // Atlas answers an undefined HTTP method with a 501 HTML page from the stdlib handler.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>Unsupported method</html>", {
          status: 501,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const error = await atlasGetMe("tok").catch((e) => e);
    expect(error).toBeInstanceOf(AtlasError);
    expect(error.kind).toBe("server");
    expect(error.message).not.toContain("<html>");
  });

  it("rejects malformed JSON on a 200 as a protocol error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const error = await atlasGetMe("tok").catch((e) => e);
    expect(error.kind).toBe("protocol");
  });

  it("tolerates a charset parameter on the content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ user: ADMIN_USER }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      ),
    );

    await expect(atlasGetMe("tok")).resolves.toMatchObject({ username: "admin" });
  });
});

describe("response contract enforcement", () => {
  it("rejects a 200 login that carries no token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ user: ADMIN_USER })));
    const error = await atlasLogin({ username: "a", password: "b" }).catch((e) => e);
    expect(error.kind).toBe("protocol");
  });

  it("rejects a 200 /api/me whose user has an unknown role", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ user: { ...ADMIN_USER, role: "superuser" } })),
    );
    const error = await atlasGetMe("tok").catch((e) => e);
    expect(error.kind).toBe("protocol");
  });

  // Atlas's loopback and legacy shared-token identities both return id: null.
  it("accepts the null-id identity Atlas returns for loopback and legacy tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ user: { id: null, username: "local", role: "admin" } })),
    );

    await expect(atlasGetMe("tok")).resolves.toEqual({
      id: null,
      username: "local",
      role: "admin",
    });
  });

  it("returns the token and user from a well-formed login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ token: "raw-bearer", user: ADMIN_USER })),
    );

    await expect(atlasLogin({ username: "admin", password: "pw" })).resolves.toEqual({
      token: "raw-bearer",
      user: ADMIN_USER,
    });
  });
});
