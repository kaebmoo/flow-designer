/**
 * Contract tests against a REAL Atlas instance.
 *
 * These are the tests that mock-based suites cannot replace: they prove our typed client
 * matches Atlas's actual wire behaviour, including the 401/403 distinction and the fact that
 * logout genuinely revokes a bearer.
 *
 * The instance is isolated — temp database, ephemeral port, own secret key. No developer or
 * production Atlas data is touched, and the Atlas checkout is only read.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AtlasError, atlasGetMe, atlasLogin, atlasLogout } from "@/lib/atlas-api.server";
import { resetServerEnvCache } from "@/lib/env.server";
import {
  ADMIN_CREDENTIALS,
  VIEWER_CREDENTIALS,
  atlasAvailable,
  startIsolatedAtlas,
  type AtlasInstance,
} from "./atlas-instance";

const available = atlasAvailable();
let atlas: AtlasInstance | undefined;

beforeAll(async () => {
  if (!available) return;
  atlas = await startIsolatedAtlas();

  process.env.ATLAS_API_ORIGIN = atlas.origin;
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "c".repeat(32);
  process.env.NODE_ENV = "test";
  resetServerEnvCache();
}, 60_000);

afterAll(() => {
  const output = atlas?.logs() ?? "";
  if (output.trim()) {
    console.log(`--- Atlas server output ---\n${output}`);
  }
  atlas?.stop();
  resetServerEnvCache();
});

describe.skipIf(!available)("Atlas auth contract", () => {
  it("logs in with valid credentials and returns a bearer plus the user", async () => {
    const result = await atlasLogin(ADMIN_CREDENTIALS);

    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.user.username).toBe("admin");
    expect(result.user.role).toBe("admin");
  });

  it("rejects a wrong password as unauthorized, not as a validation error", async () => {
    const error = await atlasLogin({
      username: ADMIN_CREDENTIALS.username,
      password: "definitely-wrong",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AtlasError);
    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(401);
  });

  it("rejects an unknown user as unauthorized", async () => {
    const error = await atlasLogin({ username: "nobody", password: "x" }).catch((e) => e);
    expect(error.kind).toBe("unauthorized");
  });

  it("resolves the current identity for a live bearer", async () => {
    const { token } = await atlasLogin(ADMIN_CREDENTIALS);
    const user = await atlasGetMe(token);

    expect(user.username).toBe("admin");
    expect(user.role).toBe("admin");
  });

  it("rejects a missing or garbage bearer with 401", async () => {
    const error = await atlasGetMe("not-a-real-token").catch((e) => e);
    expect(error).toBeInstanceOf(AtlasError);
    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(401);
  });

  /** The behaviour logout depends on: the bearer must be dead afterwards, not merely forgotten. */
  it("revokes the bearer on logout so it can no longer be used", async () => {
    const { token } = await atlasLogin(ADMIN_CREDENTIALS);
    await expect(atlasGetMe(token)).resolves.toMatchObject({ username: "admin" });

    await expect(atlasLogout(token)).resolves.toBeTruthy();

    const error = await atlasGetMe(token).catch((e) => e);
    expect(error.kind).toBe("unauthorized");
  });

  it("treats an already-revoked bearer as unauthorized on a second logout", async () => {
    const { token } = await atlasLogin(ADMIN_CREDENTIALS);
    await atlasLogout(token);

    const error = await atlasLogout(token).catch((e) => e);
    expect(error.kind).toBe("unauthorized");
  });

  it("issues independent bearers per login, so one logout does not end another session", async () => {
    const first = await atlasLogin(ADMIN_CREDENTIALS);
    const second = await atlasLogin(ADMIN_CREDENTIALS);
    expect(first.token).not.toBe(second.token);

    await atlasLogout(first.token);

    await expect(atlasGetMe(second.token)).resolves.toMatchObject({ username: "admin" });
  });

  it("authenticates a viewer and reports the viewer role", async () => {
    const { token, user } = await atlasLogin(VIEWER_CREDENTIALS);
    expect(user.role).toBe("viewer");
    await expect(atlasGetMe(token)).resolves.toMatchObject({ role: "viewer" });
  });

  /**
   * 403 must stay distinct from 401 end to end. A viewer is authenticated but lacks the
   * admin permission, and Atlas says so with a status our client maps to `forbidden`.
   */
  it("distinguishes forbidden from unauthorized against the real server", async () => {
    const { token } = await atlasLogin(VIEWER_CREDENTIALS);

    const response = await fetch(`${atlas!.origin}/api/users`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);

    const anonymous = await fetch(`${atlas!.origin}/api/users`);
    expect(anonymous.status).toBe(401);
  });

  /**
   * Atlas restricts `?token=` to SSE event streams precisely so bearers never end up in
   * ordinary URLs, access logs, or referrers. Verified here so a future change is caught.
   */
  it("refuses a bearer supplied in the query string on a normal endpoint", async () => {
    const { token } = await atlasLogin(ADMIN_CREDENTIALS);

    const response = await fetch(`${atlas!.origin}/api/me?token=${encodeURIComponent(token)}`);
    expect(response.status).toBe(401);
  });

  /**
   * Regression guard for Atlas `82207f7`'s unread-body rejection fix: the client no longer sends
   * `Connection: close`, and repeated rejected POSTs must not corrupt a later login request.
   */
  it("survives repeated rejected POSTs without corrupting a later request", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const rejected = await atlasLogout("bogus-bearer").catch((e) => e);
      expect(rejected).toBeInstanceOf(AtlasError);
      expect(rejected.kind).toBe("unauthorized");

      // The next call must be unaffected by the one Atlas just rejected.
      const result = await atlasLogin(ADMIN_CREDENTIALS);
      expect(result.user.username).toBe("admin");
    }
  });

  it("returns Atlas's single-key error envelope", async () => {
    const response = await fetch(`${atlas!.origin}/api/me`);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });
});

describe.skipIf(available)("Atlas auth contract (skipped)", () => {
  it("reports that no Atlas checkout was available", () => {
    expect(available).toBe(false);
  });
});
