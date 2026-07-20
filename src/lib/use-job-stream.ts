/**
 * React binding for `JobEventStream` (Phase 4).
 *
 * Client-safe. The stream is created in an effect, so nothing connects during server
 * rendering, and it is stopped — timers cleared, connection aborted — on unmount or when the
 * job id changes. The URL is the same-origin proxy route; no token, ever.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  IDLE_JOB_STREAM_SNAPSHOT,
  JobEventStream,
  type JobStreamEvent,
  type JobStreamSnapshot,
} from "./job-stream";

export interface UseJobEventStreamCallbacks {
  /** Every committed event, exactly once, in seq order. */
  onEvent?: (event: JobStreamEvent) => void;
  onTerminal?: (state: string) => void;
  /** A verified gap was crossed — refetch authoritative persisted state. */
  onGap?: () => void;
  /** The transport answered 401. The caller triggers a read so the session guard takes over. */
  onAuthError?: () => void;
}

export interface UseJobEventStreamResult {
  snapshot: JobStreamSnapshot;
  /** Manual reconnect, for when automatic retries were exhausted. */
  retry: () => void;
}

export function useJobEventStream(
  jobId: string | null,
  enabled: boolean,
  callbacks: UseJobEventStreamCallbacks,
): UseJobEventStreamResult {
  const [stream, setStream] = useState<JobEventStream | null>(null);

  // Callbacks live in a ref so a re-rendered parent handing fresh closures does not tear the
  // connection down and replay the whole stream.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (jobId === null || !enabled) {
      setStream(null);
      return;
    }
    const created = new JobEventStream({
      url: (after) => `/api/jobs/${encodeURIComponent(jobId)}/events?after=${after}`,
      onEvent: (event) => callbacksRef.current.onEvent?.(event),
      onTerminal: (state) => callbacksRef.current.onTerminal?.(state),
      onGap: () => callbacksRef.current.onGap?.(),
      onAuthError: () => callbacksRef.current.onAuthError?.(),
    });
    setStream(created);
    created.start();
    return () => {
      created.stop();
      setStream(null);
    };
  }, [jobId, enabled]);

  const subscribe = useCallback(
    (listener: () => void) => (stream ? stream.subscribe(listener) : () => {}),
    [stream],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (stream ? stream.getSnapshot() : IDLE_JOB_STREAM_SNAPSHOT),
    () => IDLE_JOB_STREAM_SNAPSHOT,
  );

  const retry = useCallback(() => stream?.retry(), [stream]);

  return { snapshot, retry };
}
