import { isClientAtlasError } from "./atlas-mappers";

interface QuerySnapshot {
  isActive(): boolean;
  state: {
    data: unknown;
    error: unknown;
  };
}

const OUTAGE_KINDS = new Set(["network", "timeout", "server", "protocol"]);

/**
 * True when an active page still owns cached data while an active Atlas read has failed in a
 * way that can indicate an outage. Permission, validation, conflict, and sign-out failures are
 * excluded: calling those "stale" would hide the real action the operator needs to take.
 */
export function hasActiveStaleAtlasData(queries: readonly QuerySnapshot[]): boolean {
  const active = queries.filter((query) => query.isActive());
  const hasCachedData = active.some((query) => query.state.data !== undefined);
  const hasOutageFailure = active.some(
    (query) => isClientAtlasError(query.state.error) && OUTAGE_KINDS.has(query.state.error.kind),
  );
  return hasCachedData && hasOutageFailure;
}
