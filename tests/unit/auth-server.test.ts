import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Session behaviour is exercised against a fake `useSession` that records the config it was
 * given. That config *is* the security contract — httpOnly, the disabled session header, the
 * Secure flag, the lifetime — so asserting on it is asserting on the cookie the browser gets.
 */
const sessionState: { data: Record<string, unknown>; configs: Array<Record<string, unknown>> } = {
  data: {},
  configs: [],
};

vi.mock("@tanstack/react-start/server", () => ({
  useSession: vi.fn(async (config: Record<string, unknown>) => {
    sessionState.configs.push(config);
    return {
      get data() {
        return sessionState.data;
      },
      update: vi.fn(async (patch: Record<string, unknown>) => {
        sessionState.data = { ...sessionState.data, ...patch };
      }),
      clear: vi.fn(async () => {
        sessionState.data = {};
      }),
    };
  }),
}));

import { AtlasError } from "@/lib/atlas-api.server";
import {
  SESSION_COOKIE_NAME,
  clearSession,
  currentIdentity,
  loginWithAtlas,
  logoutFromAtlas,
  readSession,
  requireAtlasToken,
} from "@/lib/auth.server";
import { resetServerEnvCache } from "@/lib/env.server";

const ADMIN_USER = { id: "usr_1", username: "admin", role: "admin", status: "active" };
const TOKEN = "atlas-bearer-token";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setEnv(overrides: Record<string, string> = {}) {
  process.env.ATLAS_API_ORIGIN = "http://127.0.0.1:8787";
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "s".repeat(32);
  process.env.NODE_ENV = "test";
  delete process.env.SESSION_MAX_AGE;
  Object.assign(process.env, overrides);
  resetServerEnvCache();
}

beforeEach(() => {
  sessionState.data = {};
  sessionState.configs = [];
  setEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetServerEnvCache();
});

describe("sealed session configuration", () => {
  it("seals the cookie httpOnly, host-only, SameSite=Lax, with the confirmed lifetime", async () => {
    await readSession();

    const config = sessionState.configs.at(-1)!;
    expect(config.name).toBe(SESSION_COOKIE_NAME);
    expect(config.password).toBe("s".repeat(32));
    expect(config.maxAge).toBe(28_800);

    const cookie = config.cookie as Record<string, unknown>;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
    expect(cookie.path).toBe("/");
    // Host-only: setting a Domain would widen the cookie across sibling subdomains.
    expect(cookie).not.toHaveProperty("domain");
  });

  /**
   * Regression guard for a real vulnerability in the default configuration: `useSession`
   * otherwise reads a sealed session from an `x-<name>-session` request header *before* the
   * cookie, letting a caller supply a session out-of-band.
   */
  it("disables header-supplied sessions so the httpOnly cookie is the only carrier", async () => {
    await readSession();
    expect(sessionState.configs.at(-1)!.sessionHeader).toBe(false);
  });

  it("omits Secure on local HTTP but sets it for production HTTPS", async () => {
    await readSession();
    expect((sessionState.configs.at(-1)!.cookie as Record<string, unknown>).secure).toBe(false);

    setEnv({ NODE_ENV: "production", PUBLIC_ORIGIN: "https://atlas.example.com" });
    await readSession();
    expect((sessionState.configs.at(-1)!.cookie as Record<string, unknown>).secure).toBe(true);
  });

  it("honours a configured session lifetime", async () => {
    setEnv({ SESSION_MAX_AGE: "3600" });
    await readSession();
    expect(sessionState.configs.at(-1)!.maxAge).toBe(3600);
  });
});

describe("readSession", () => {
  it("returns null when there is no session", async () => {
    await expect(readSession()).resolves.toBeNull();
  });

  it("returns null when the sealed session carries no usable bearer", async () => {
    sessionState.data = { atlasToken: "" };
    await expect(readSession()).resolves.toBeNull();

    sessionState.data = { username: "admin" };
    await expect(readSession()).resolves.toBeNull();
  });
});

describe("requireAtlasToken", () => {
  /**
   * The core of the "no security by route guard" rule: this runs on every private server
   * function, and it must reject on its own without any help from a `beforeLoad`.
   */
  it("throws unauthorized when called with no session at all", async () => {
    const error = await requireAtlasToken().catch((e) => e);
    expect(error).toBeInstanceOf(AtlasError);
    expect(error.kind).toBe("unauthorized");
  });

  it("returns the bearer when the session is valid", async () => {
    sessionState.data = { atlasToken: TOKEN, username: "admin", role: "admin", userId: "usr_1" };
    await expect(requireAtlasToken()).resolves.toBe(TOKEN);
  });
});

describe("loginWithAtlas", () => {
  it("seals the bearer plus a minimal identity into the session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ token: TOKEN, user: ADMIN_USER })),
    );

    await expect(loginWithAtlas({ username: "admin", password: "pw" })).resolves.toMatchObject({
      username: "admin",
    });

    expect(sessionState.data.atlasToken).toBe(TOKEN);
    expect(sessionState.data.username).toBe("admin");
    expect(sessionState.data.role).toBe("admin");
    // The password must not survive anywhere in the session.
    expect(JSON.stringify(sessionState.data)).not.toContain("pw");
  });

  /**
   * Merely reading a session mints one, so an anonymous visitor to `/auth` already holds a
   * sealed session before submitting. Authenticating must rotate it rather than merge into
   * it, or a pre-login session (and its lifetime) would survive sign-in.
   */
  it("rotates the session on login instead of inheriting the pre-login one", async () => {
    sessionState.data = { anonymousMarker: "from-before-login", atlasToken: "" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ token: TOKEN, user: ADMIN_USER })),
    );

    await loginWithAtlas({ username: "admin", password: "pw" });

    expect(sessionState.data).not.toHaveProperty("anonymousMarker");
    expect(sessionState.data.atlasToken).toBe(TOKEN);
  });

  it("propagates bad credentials as unauthorized and stores no session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401)));

    const error = await loginWithAtlas({ username: "admin", password: "wrong" }).catch((e) => e);
    expect(error.kind).toBe("unauthorized");
    expect(sessionState.data).toEqual({});
  });
});

describe("currentIdentity", () => {
  it("returns null without calling Atlas when there is no session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(currentIdentity()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The cookie's cached role is never the answer. Asking Atlas every time is what makes a
   * role change or a revocation take effect on the next request.
   */
  it("asks Atlas rather than trusting the identity cached in the cookie", async () => {
    sessionState.data = { atlasToken: TOKEN, username: "admin", role: "admin", userId: "usr_1" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ user: { ...ADMIN_USER, role: "viewer" } })),
    );

    await expect(currentIdentity()).resolves.toMatchObject({ role: "viewer" });
  });

  it("clears the session when Atlas reports the token expired or revoked", async () => {
    sessionState.data = { atlasToken: TOKEN, username: "admin", role: "admin", userId: "usr_1" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401)));

    await expect(currentIdentity()).resolves.toBeNull();
    expect(sessionState.data).toEqual({});
  });

  /**
   * An outage must not masquerade as a sign-out: clearing the session on a timeout would log
   * the operator out every time Atlas hiccups, and hide the real problem.
   */
  it.each([
    ["a 403", jsonResponse({ error: "forbidden" }, 403), "forbidden"],
    ["a 500", jsonResponse({ error: "boom" }, 500), "server"],
  ])("keeps the session and rethrows on %s", async (_label, response, kind) => {
    sessionState.data = { atlasToken: TOKEN, username: "admin", role: "admin", userId: "usr_1" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await currentIdentity().catch((e) => e);
    expect(error).toBeInstanceOf(AtlasError);
    expect(error.kind).toBe(kind);
    expect(sessionState.data.atlasToken).toBe(TOKEN);
  });

  it("keeps the session and rethrows when Atlas is unreachable", async () => {
    sessionState.data = { atlasToken: TOKEN, username: "admin", role: "admin", userId: "usr_1" };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const error = await currentIdentity().catch((e) => e);
    expect(error.kind).toBe("network");
    expect(sessionState.data.atlasToken).toBe(TOKEN);
  });
});

describe("logoutFromAtlas", () => {
  it("revokes the Atlas token and clears the local session", async () => {
    sessionState.data = { atlasToken: TOKEN, username: "admin", role: "admin", userId: "usr_1" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ logged_out: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(logoutFromAtlas()).resolves.toEqual({ atlasRevoked: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/api/auth/logout");
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sessionState.data).toEqual({});
  });

  /**
   * The important half: if Atlas cannot be reached we must still not leave a usable bearer
   * sealed in the user's cookie.
   */
  it.each([
    ["Atlas is unreachable", () => vi.fn().mockRejectedValue(new TypeError("fetch failed"))],
    ["Atlas returns 500", () => vi.fn().mockResolvedValue(jsonResponse({ error: "x" }, 500))],
    [
      "the token is already invalid",
      () => vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401)),
    ],
  ])("still clears the local session when %s", async (_label, makeFetch) => {
    sessionState.data = { atlasToken: TOKEN, username: "admin", role: "admin", userId: "usr_1" };
    vi.stubGlobal("fetch", makeFetch());

    await expect(logoutFromAtlas()).resolves.toEqual({ atlasRevoked: false });
    expect(sessionState.data).toEqual({});
  });

  it("is a safe no-op when there is no session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(logoutFromAtlas()).resolves.toEqual({ atlasRevoked: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("clearSession", () => {
  it("empties the sealed session", async () => {
    sessionState.data = { atlasToken: TOKEN };
    await clearSession();
    expect(sessionState.data).toEqual({});
  });
});
