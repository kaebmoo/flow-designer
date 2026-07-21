import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";

import { hasActiveStaleAtlasData } from "@/lib/stale-data";

/**
 * One shell-level affordance rather than a copy on every table. Query-cache notifications make
 * it appear on a failed background refetch and disappear as soon as the active reads recover.
 */
export function StaleDataWarning() {
  const queryClient = useQueryClient();
  const cache = queryClient.getQueryCache();
  const subscribe = useCallback(
    (onStoreChange: () => void) => cache.subscribe(onStoreChange),
    [cache],
  );
  const getSnapshot = useCallback(() => hasActiveStaleAtlasData(cache.getAll()), [cache]);
  const visible = useSyncExternalStore(subscribe, getSnapshot, () => false);

  if (!visible) return null;
  return (
    <div
      role="status"
      data-testid="stale-data-warning"
      className="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-warning"
    >
      <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
      <span>
        Atlas is not responding. Some data may be cached and stale; retry the affected panel before
        acting on it.
      </span>
    </div>
  );
}
