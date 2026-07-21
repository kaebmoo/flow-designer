import { describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_MAX_AGE_SECONDS,
  EXAMPLE_SESSION_SECRET,
  EnvValidationError,
  parseServerEnv,
} from "@/lib/env.server";

const SECRET = "s".repeat(32);

const valid = {
  ATLAS_API_ORIGIN: "http://127.0.0.1:8787",
  PUBLIC_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: SECRET,
  NODE_ENV: "development",
};

describe("parseServerEnv", () => {
  it("accepts a valid environment and defaults the session lifetime to 8 hours", () => {
    const env = parseServerEnv(valid);
    expect(env.atlasApiOrigin).toBe("http://127.0.0.1:8787");
    expect(env.publicOrigin).toBe("http://localhost:3000");
    expect(env.sessionMaxAgeSeconds).toBe(DEFAULT_SESSION_MAX_AGE_SECONDS);
    expect(env.sessionMaxAgeSeconds).toBe(28_800);
  });

  it("fails fast when a required variable is missing", () => {
    expect(() => parseServerEnv({ ...valid, ATLAS_API_ORIGIN: undefined })).toThrow(
      EnvValidationError,
    );
    expect(() => parseServerEnv({ ...valid, SESSION_SECRET: undefined })).toThrow(
      EnvValidationError,
    );
    expect(() => parseServerEnv({ ...valid, PUBLIC_ORIGIN: undefined })).toThrow(
      EnvValidationError,
    );
  });

  it("reports every problem at once instead of one per restart", () => {
    try {
      parseServerEnv({});
      expect.unreachable("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues).toHaveLength(3);
    }
  });

  it("rejects a session secret shorter than the sealing minimum", () => {
    expect(() => parseServerEnv({ ...valid, SESSION_SECRET: "short" })).toThrow(
      /at least 32 characters/,
    );
  });

  // The whole point of the hand-rolled messages: a bad secret must never be quoted back.
  it("never includes a secret value in the error message", () => {
    const secret = "hunter2-correct-horse"; // too short, so validation must reject it
    try {
      parseServerEnv({ ...valid, SESSION_SECRET: secret });
      expect.unreachable("expected validation to fail");
    } catch (error) {
      const rendered = `${(error as Error).message}${(error as Error).stack ?? ""}`;
      expect(rendered).not.toContain(secret);
      expect(rendered).toContain("SESSION_SECRET");
    }
  });

  it("rejects an origin that carries a path, query, or fragment", () => {
    expect(() => parseServerEnv({ ...valid, ATLAS_API_ORIGIN: "http://a.test/api" })).toThrow(
      /origin only/,
    );
    expect(() => parseServerEnv({ ...valid, ATLAS_API_ORIGIN: "http://a.test/?x=1" })).toThrow(
      /origin only/,
    );
    expect(() => parseServerEnv({ ...valid, PUBLIC_ORIGIN: "http://a.test/#x" })).toThrow(
      /origin only/,
    );
  });

  it("rejects a non-http scheme and an unparseable origin", () => {
    expect(() => parseServerEnv({ ...valid, ATLAS_API_ORIGIN: "ftp://a.test" })).toThrow(
      /http or https/,
    );
    expect(() => parseServerEnv({ ...valid, ATLAS_API_ORIGIN: "not-a-url" })).toThrow(
      /absolute URL/,
    );
  });

  it("normalises a trailing slash away so built URLs never double up", () => {
    expect(parseServerEnv({ ...valid, ATLAS_API_ORIGIN: "http://a.test/" }).atlasApiOrigin).toBe(
      "http://a.test",
    );
  });

  describe("cookie Secure flag", () => {
    it("is off for local HTTP development", () => {
      expect(parseServerEnv(valid).cookieSecure).toBe(false);
    });

    it("is on for production HTTPS", () => {
      const env = parseServerEnv({
        ...valid,
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "https://atlas.example.com",
      });
      expect(env.cookieSecure).toBe(true);
      expect(env.isProduction).toBe(true);
    });

    it("refuses production over plain HTTP instead of issuing an insecure session", () => {
      expect(() =>
        parseServerEnv({
          ...valid,
          NODE_ENV: "production",
          PUBLIC_ORIGIN: "http://atlas.test",
        }),
      ).toThrow(/PUBLIC_ORIGIN must use https/);
    });

    /**
     * Regression guard against failing open. NODE_ENV silently defaults to "development" and
     * some runtimes never populate it, so gating Secure on it would ship the cookie carrying
     * the Atlas bearer over an HTTPS deployment without the flag.
     */
    it("is on for an HTTPS origin even when NODE_ENV is unset or not production", () => {
      expect(
        parseServerEnv({
          ...valid,
          NODE_ENV: undefined,
          PUBLIC_ORIGIN: "https://atlas.example.com",
        }).cookieSecure,
      ).toBe(true);

      expect(
        parseServerEnv({
          ...valid,
          NODE_ENV: "development",
          PUBLIC_ORIGIN: "https://atlas.example.com",
        }).cookieSecure,
      ).toBe(true);
    });
  });

  it("refuses the committed example session secret in production", () => {
    expect(() =>
      parseServerEnv({
        ...valid,
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "https://atlas.example.com",
        SESSION_SECRET: EXAMPLE_SESSION_SECRET,
      }),
    ).toThrow(/generated production secret/);
  });

  it("rejects a non-positive or non-integer session lifetime", () => {
    expect(() => parseServerEnv({ ...valid, SESSION_MAX_AGE: "0" })).toThrow(/positive whole/);
    expect(() => parseServerEnv({ ...valid, SESSION_MAX_AGE: "-1" })).toThrow(/positive whole/);
    expect(() => parseServerEnv({ ...valid, SESSION_MAX_AGE: "abc" })).toThrow(/positive whole/);
    expect(parseServerEnv({ ...valid, SESSION_MAX_AGE: "3600" }).sessionMaxAgeSeconds).toBe(3600);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => parseServerEnv({ ...valid, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});
