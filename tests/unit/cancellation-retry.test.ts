/**
 * Phase 6 resilience units.
 *
 * The cancellation tests run against a real local HTTP server rather than a stubbed `fetch`,
 * so what is proven is socket behaviour: an abort tears the connection down (which is what
 * Atlas observes), and a timeout stays classified as a timeout even when a live caller
 * signal is present. The fixture-server cases cover the statuses a real Atlas cannot be made
 * to produce (429, 5xx with exception text) through the production fetch path.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AtlasError, atlasGetMetrics } from "@/lib/atlas-api.server";
import { resetServerEnvCache } from "@/lib/env.server";
import { metricsQuery, readRetryDelayMs, retryRead, runsQuery } from "@/lib/atlas-queries";

let server: Server | undefined;

async function listen(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  process.env.ATLAS_API_ORIGIN = origin;
  resetServerEnvCache();
  return origin;
}

beforeEach(() => {
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "s".repeat(32);
  process.env.NODE_ENV = "test";
  resetServerEnvCache();
});

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
  vi.restoreAllMocks();
  resetServerEnvCache();
});

describe("cancellation propagates to the Atlas socket", () => {
  it("an aborted read closes the upstream request before Atlas answers", async () => {
    let sawRequest: (() => void) | undefined;
    const requestSeen = new Promise<void>((resolve) => (sawRequest = resolve));
    let upstreamClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));

    await listen((req, res) => {
      sawRequest?.();
      // Never respond; the only way this request ends is the client tearing it down.
      req.on("close", () => upstreamClosed?.());
      res.on("close", () => upstreamClosed?.());
    });

    const controller = new AbortController();
    const pending = atlasGetMetrics("test-token", { signal: controller.signal });
    await requestSeen;
    controller.abort();

    // The caller's abort propagates untouched — not relabelled as an Atlas failure.
    const error = await pending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(AtlasError);
    expect((error as Error).name).toMatch(/AbortError|TimeoutError/);
    expect((error as Error).name).toBe("AbortError");

    // And the socket Atlas would be holding a handler thread for is actually closed.
    await closed;
  });

  it("a deadline elapsing is a timeout even while a live caller signal is attached", async () => {
    await listen(() => {
      // Hold the request open past the deadline.
    });

    const controller = new AbortController();
    const error = await atlasGetMetrics("test-token", {
      signal: controller.signal,
      timeoutMs: 100,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AtlasError);
    expect((error as AtlasError).kind).toBe("timeout");
  });
});

describe("Atlas HTTP boundary fixtures for statuses a real Atlas cannot be made to emit", () => {
  it("maps a 429 to rate_limited through the production fetch path", async () => {
    await listen((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "too many requests" }));
    });

    const error = await atlasGetMetrics("test-token").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlasError);
    expect((error as AtlasError).kind).toBe("rate_limited");
  });

  it("maps a 5xx to server with fromAtlas set, so the redaction layer knows to drop its text", async () => {
    await listen((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "KeyError: 'graph' in /srv/atlas/workflows.py" }));
    });

    const error = await atlasGetMetrics("test-token").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlasError);
    expect((error as AtlasError).kind).toBe("server");
    expect((error as AtlasError).fromAtlas).toBe(true);
  });

  it("classifies a proxy HTML error page by its status and never parses its body as the contract", async () => {
    await listen((_req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html>Bad Gateway</html>");
    });

    const error = await atlasGetMetrics("test-token").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlasError);
    expect((error as AtlasError).kind).toBe("server");
  });
});

describe("read retry policy", () => {
  it.each([
    ["unauthorized", false],
    ["forbidden", false],
    ["not_found", false],
    ["validation", false],
    ["conflict", false],
    ["rate_limited", true],
    ["timeout", true],
    ["network", true],
    ["server", true],
    ["protocol", true],
  ] as const)("kind %s → first retry allowed: %s", (kind, allowed) => {
    expect(retryRead(1, { kind, message: "x" })).toBe(allowed);
  });

  it("stops after two retries even for retryable kinds — no unbounded loop", () => {
    const retryable = { kind: "timeout", message: "x" };
    expect(retryRead(1, retryable)).toBe(true);
    expect(retryRead(2, retryable)).toBe(false);
    expect(retryRead(5, retryable)).toBe(false);
  });

  it("caps the exponential backoff at 30 seconds", () => {
    expect(readRetryDelayMs(0)).toBe(1_000);
    expect(readRetryDelayMs(1)).toBe(2_000);
    expect(readRetryDelayMs(2)).toBe(4_000);
    expect(readRetryDelayMs(10)).toBe(30_000);
    expect(readRetryDelayMs(100)).toBe(30_000);
  });

  it("is the retry policy every read query actually carries", () => {
    expect(metricsQuery().retry).toBe(retryRead);
    expect(metricsQuery().retryDelay).toBe(readRetryDelayMs);
    expect(runsQuery({ limit: 100 }).retry).toBe(retryRead);
    expect(runsQuery({ limit: 100 }).retryDelay).toBe(readRetryDelayMs);
  });
});

describe("mutations never auto-retry", () => {
  it("the mutation module pins retry: false and defines no other retry policy", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/atlas-mutations.ts", "utf-8");
    // One shared hook builds every mutation; its literal `retry: false` is the policy.
    expect(source).toContain("retry: false");
    expect(source).not.toMatch(/retry:\s*(true|\d|retryRead)/);
    expect(source).not.toContain("retryDelay");
  });
});
