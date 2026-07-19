/**
 * TanStack Query key factory.
 *
 * Keys only — no fetching, no domain state, no cached entities. Centralising them here keeps
 * invalidation honest once Phase 2 introduces real reads.
 */

export const queryKeys = {
  /** The current Atlas identity behind the active session. */
  identity: () => ["atlas", "identity"] as const,
} as const;

export type QueryKeys = typeof queryKeys;
