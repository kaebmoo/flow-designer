/**
 * Regression tests for the one-time-token race the gate review flagged.
 *
 * Atlas can never show a token value twice, so the moment `POST /api/tokens` answers, the raw
 * value must reach the caller — a slow, stalled, or failing query invalidation must neither
 * delay nor destroy it. These tests drive `mintApiToken` with an injected client whose
 * `invalidateQueries` misbehaves on purpose.
 */

import { describe, expect, it, vi } from "vitest";

import { AtlasMutationError, mintApiToken } from "@/lib/atlas-mutations";
import { queryKeys } from "@/lib/query-keys";
import type { createApiTokenFn } from "@/lib/atlas-mutations.functions";

const MINTED = {
  token: {
    id: "tok_1",
    userId: "usr_1",
    username: "viewer",
    name: "test token",
    revoked: false,
    lastUsedAt: "—",
    createdAt: "2026-07-21 10:00:00 UTC",
    revokedAt: "—",
  },
  apiToken: "at_raw_value_shown_once",
};

/** The RPC, stubbed at the same boundary the browser build replaces with a network call. */
const mintOk = (async () => ({ ok: true, data: MINTED })) as unknown as typeof createApiTokenFn;

describe("mintApiToken", () => {
  it("resolves with the raw token even while invalidation never settles", async () => {
    const invalidateQueries = vi.fn(() => new Promise<unknown>(() => {}));

    // If the implementation awaited the invalidation, this would hang and lose the race —
    // exactly the failure mode under test: a stalled refetch must not gate the one-time value.
    const result = await Promise.race([
      mintApiToken({ invalidateQueries }, { userId: "usr_1", name: "test token" }, mintOk),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("raw token was gated behind invalidation")), 250),
      ),
    ]);

    expect(result.apiToken).toBe(MINTED.apiToken);
    // The background invalidation still fired, once per affected family.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.tokens() });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.users() });
  });

  it("resolves with the raw token when invalidation rejects, without an unhandled rejection", async () => {
    const invalidateQueries = vi.fn(() => Promise.reject(new Error("refetch failed")));

    const result = await mintApiToken(
      { invalidateQueries },
      { userId: "usr_1", name: "test token" },
      mintOk,
    );
    expect(result.apiToken).toBe(MINTED.apiToken);

    // Let the background rejection settle; the internal catch must have absorbed it (an
    // unhandled rejection would fail this test run).
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("still surfaces Atlas's refusal as a typed error before any invalidation", async () => {
    const invalidateQueries = vi.fn(() => Promise.resolve());
    const mintForbidden = (async () => ({
      ok: false,
      error: { kind: "forbidden", message: "forbidden" },
    })) as unknown as typeof createApiTokenFn;

    await expect(
      mintApiToken({ invalidateQueries }, { userId: "usr_1", name: "test token" }, mintForbidden),
    ).rejects.toBeInstanceOf(AtlasMutationError);
    // A refused mint changed nothing, so nothing is invalidated.
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
