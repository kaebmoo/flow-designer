/**
 * Typed client for the Atlas per-job SSE stream (Phase 4).
 *
 * Client-safe: no secrets, no `*.server.ts` imports. The browser talks only to the same-origin
 * proxy route (`/api/jobs/{id}/events`), which attaches the Atlas bearer server-side — the
 * token never appears in this module, in a URL, or in browser storage.
 *
 * The contract this implements is verified against Atlas source (`atlas/app.py`
 * `_stream_job_events`, commit `82207f7`) and recorded in `docs/BACKEND_INTEGRATION.md`:
 *
 *  - `after` is an **exclusive** lower bound and the only resume parameter.
 *  - Every data frame carries `id: <seq>` and a JSON payload with `seq` and `created_at`.
 *  - A normal stream ends with `event: close` and `data: {"state": <terminal>}`. The close
 *    frame's id is `last_seq + 1` — an id for a row that does not exist — so it must never
 *    become the confirmed cursor.
 *  - EOF **without** a close frame is a mid-stream disconnect: reconnect with
 *    `after=<lastConfirmedSeq>` under bounded exponential backoff.
 *  - Atlas emits `retry: 3000` and comment-only `: keepalive` bytes. Transport activity resets
 *    the idle watchdog without inventing an event; a bounded retry hint informs reconnect delay.
 *
 * Everything time- and network-shaped is injectable so the stream tests can drive the machine
 * with synthetic frames and a fake clock. Production uses the browser's `fetch` and timers.
 */

// ---------------------------------------------------------------------------
// SSE frame parsing
// ---------------------------------------------------------------------------

export interface SseFrame {
  /** The `id:` field, verbatim, or null when the frame carried none. */
  id: string | null;
  /** The `event:` field, defaulting to "message" per the SSE spec. */
  event: string;
  /** All `data:` lines joined with newlines. */
  data: string;
}

export interface SseTransportSignals {
  /** Any bytes arrived, including comment-only keepalive bytes or a partial frame. */
  activity: boolean;
  /** The last valid bounded `retry:` hint observed since the previous read, if any. */
  retryMs: number | null;
}

/** Atlas's retry hint is milliseconds; reject unbounded or negative values. */
const MIN_RETRY_HINT_MS = 1;
const MAX_RETRY_HINT_MS = 3_600_000;

/**
 * Incremental parser for the SSE subset Atlas emits (`id`, `event`, `data`, comments).
 *
 * Push decoded text in arbitrary chunk sizes; complete frames come back as soon as their
 * terminating blank line arrives. Field parsing follows the SSE spec: CR stripped, one leading
 * space after the colon removed, comment lines (leading `:`) ignored, unknown fields ignored.
 */
export class SseFrameParser {
  private buffer = "";
  private id: string | null = null;
  private event = "message";
  private dataLines: string[] = [];
  private activity = false;
  private retryMs: number | null = null;

  push(chunk: string): SseFrame[] {
    if (chunk.length > 0) this.activity = true;
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);

      if (line === "") {
        if (this.dataLines.length > 0) {
          frames.push({ id: this.id, event: this.event, data: this.dataLines.join("\n") });
        }
        this.id = null;
        this.event = "message";
        this.dataLines = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("id:")) this.id = line.slice(3).replace(/^ /, "");
      else if (line.startsWith("event:")) this.event = line.slice(6).replace(/^ /, "") || "message";
      else if (line.startsWith("data:")) this.dataLines.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("retry:")) {
        const raw = line.slice(6).replace(/^ /, "");
        if (/^\d+$/.test(raw)) {
          const value = Number(raw);
          if (
            Number.isSafeInteger(value) &&
            value >= MIN_RETRY_HINT_MS &&
            value <= MAX_RETRY_HINT_MS
          ) {
            this.retryMs = value;
          }
        }
      }
      // Any other field is ignored, per spec.
    }
    return frames;
  }

  takeTransportSignals(): SseTransportSignals {
    const signals = { activity: this.activity, retryMs: this.retryMs };
    this.activity = false;
    this.retryMs = null;
    return signals;
  }
}

// ---------------------------------------------------------------------------
// Stream state
// ---------------------------------------------------------------------------

/**
 * Event types Atlas is known to write (`atlas/jobs.py` `append_job_event` call sites).
 *
 * An event outside this set is still committed — its `seq` is real and skipping it would open
 * a false gap — but it is flagged `known: false` as the diagnostic marker the UI shows.
 */
const KNOWN_EVENT_TYPES = new Set([
  "route",
  "state",
  "text",
  "error",
  "done",
  "session",
  "message",
  "thinking",
  "usage",
  "result",
  "cancel_requested",
  "files.collected",
  "handoff_configured",
  "handoff_skipped",
  "handoff_error",
  "callback_dispatched",
  "callback_dispatch_unconfirmed",
  "session_lease_waiting",
  "session_lease_acquired",
  "tool_use_start",
  "tool_use_result",
  "tool_use_denied",
  "skill_invoked",
  "skill_invoked_result",
]);

export interface JobStreamEvent {
  seq: number;
  type: string;
  /** Required `created_at` from the validated Atlas data-frame payload. */
  createdAt: string;
  /** Assistant text for `text` frames; null for structured frames. */
  text: string | null;
  /** Compact JSON of the payload (already redacted server-side by Atlas) for display. */
  detail: string;
  /** False marks an event type this client does not recognise — the diagnostic marker. */
  known: boolean;
}

export type JobStreamPhase =
  | { phase: "idle" }
  | { phase: "connecting"; attempt: number }
  | { phase: "streaming" }
  /** Connection open but silent past the idle threshold. Transport health only. */
  | { phase: "stale" }
  /** Disconnected; an automatic reconnect is scheduled `retryInMs` from now. */
  | { phase: "disconnected"; attempt: number; retryInMs: number }
  | { phase: "terminal"; state: string }
  | {
      phase: "failed";
      reason: "unauthorized" | "forbidden" | "not_found" | "exhausted";
      message: string;
    };

export interface JobStreamSnapshot {
  phase: JobStreamPhase;
  /** Bounded, seq-ascending window of committed events. Never exceeds `maxEvents`. */
  events: readonly JobStreamEvent[];
  /** Highest seq validated, deduplicated, and committed. The resume cursor. */
  lastConfirmedSeq: number;
  /** Events evicted from the bounded window (they remain in Atlas's persisted history). */
  dropped: number;
  duplicates: number;
  malformed: number;
  /** True once a verified gap was crossed; the owner refetched authoritative state via onGap. */
  gapNotice: boolean;
}

export const IDLE_JOB_STREAM_SNAPSHOT: JobStreamSnapshot = {
  phase: { phase: "idle" },
  events: [],
  lastConfirmedSeq: 0,
  dropped: 0,
  duplicates: 0,
  malformed: 0,
  gapNotice: false,
};

// ---------------------------------------------------------------------------
// Driver configuration
// ---------------------------------------------------------------------------

/** Hard cap on events retained in memory per stream. The live log's boundedness rests on it. */
export const JOB_STREAM_EVENT_CAP = 500;

/** Out-of-order frames held while waiting for the hole to fill; beyond this, verify via replay. */
const PENDING_CAP = 64;

export interface JobStreamBackoff {
  baseMs: number;
  factor: number;
  maxMs: number;
  /** Consecutive failed connections before automatic retry stops and manual Retry is offered. */
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: JobStreamBackoff = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 30_000,
  maxAttempts: 6,
};

/** Silence on an open connection before it is *displayed* as stale. */
export const IDLE_STALE_MS = 15_000;
/** Silence before the transport assumes a dead proxy hop and reconnects. */
export const IDLE_RECONNECT_MS = 45_000;

export interface JobStreamOptions {
  /** Builds the same-origin URL for a connection resuming after the given (exclusive) seq. */
  url: (after: number) => string;
  fetchImpl?: typeof fetch;
  /** Timer injection for tests. Every scheduled timer is cleared on stop/close/error. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  maxEvents?: number;
  backoff?: JobStreamBackoff;
  idleStaleMs?: number;
  idleReconnectMs?: number;
  /** Every committed event, in seq order, exactly once. */
  onEvent?: (event: JobStreamEvent) => void;
  /** The terminal `close` frame's state. The stream never reconnects after this. */
  onTerminal?: (state: string) => void;
  /** A verified gap was crossed: the owner should refetch authoritative persisted state. */
  onGap?: () => void;
  /** The transport answered 401. Retrying is pointless; the session guard owns what follows. */
  onAuthError?: () => void;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

type FrameOutcome = "continue" | "finished" | "reconnect";

export class JobEventStream {
  private readonly options: Required<
    Pick<JobStreamOptions, "url" | "maxEvents" | "backoff" | "idleStaleMs" | "idleReconnectMs">
  > &
    JobStreamOptions;

  private snapshot: JobStreamSnapshot = IDLE_JOB_STREAM_SNAPSHOT;
  private listeners = new Set<() => void>();

  private abort: AbortController | null = null;
  private retryTimer: unknown = null;
  private staleTimer: unknown = null;
  private idleReconnectTimer: unknown = null;
  private attempt = 0;
  private stopped = false;
  /** Out-of-order frames held within one connection, keyed by seq. */
  private pendingBySeq = new Map<number, JobStreamEvent>();
  /**
   * The cursor position at which a gap was observed once. If a fresh replay from this same
   * cursor shows the gap again, the missing rows verifiably do not exist in Atlas and the
   * cursor may advance past them — never before that second sighting.
   */
  private gapProbeAt: number | null = null;
  /**
   * Monotonic connection generation. A superseded connection's read loop (aborted by the idle
   * watchdog, a manual retry, or a gap probe) must fall silent instead of scheduling a second
   * reconnect beside the one that replaced it.
   */
  private generation = 0;
  /** Server-provided retry hint, bounded by the parser and the driver's backoff ceiling. */
  private retryHintMs: number | null = null;

  constructor(options: JobStreamOptions) {
    this.options = {
      maxEvents: JOB_STREAM_EVENT_CAP,
      backoff: DEFAULT_BACKOFF,
      idleStaleMs: IDLE_STALE_MS,
      idleReconnectMs: IDLE_RECONNECT_MS,
      ...options,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): JobStreamSnapshot {
    return this.snapshot;
  }

  start(): void {
    if (this.stopped) return;
    void this.connect();
  }

  /** Stops everything: timers cleared, in-flight connection aborted. Safe to call twice. */
  stop(): void {
    this.stopped = true;
    this.clearAllTimers();
    this.abort?.abort();
    this.abort = null;
  }

  /** Manual retry after automatic attempts were exhausted (or any time earlier). */
  retry(): void {
    if (this.stopped) return;
    if (this.snapshot.phase.phase === "terminal") return;
    this.attempt = 0;
    this.clearAllTimers();
    this.abort?.abort();
    void this.connect();
  }

  // -- internals ------------------------------------------------------------

  private notify(patch: Partial<JobStreamSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return (this.options.setTimer ?? ((f: () => void, m: number) => setTimeout(f, m)))(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    if (handle === null) return;
    if (this.options.clearTimer) this.options.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private clearAllTimers(): void {
    this.clearTimer(this.retryTimer);
    this.clearTimer(this.staleTimer);
    this.clearTimer(this.idleReconnectTimer);
    this.retryTimer = this.staleTimer = this.idleReconnectTimer = null;
  }

  /**
   * The transport idle watchdog. Re-armed on connect and on every received byte; cleared on stop,
   * stream close, and stream error. It only manages connection health: `stale` is a display
   * of transport silence, and the reconnect replays from the confirmed cursor — no event is
   * invented and no node state is touched.
   */
  private armIdleWatchdog(): void {
    this.clearTimer(this.staleTimer);
    this.clearTimer(this.idleReconnectTimer);
    this.staleTimer = this.setTimer(() => {
      if (this.snapshot.phase.phase === "streaming") this.notify({ phase: { phase: "stale" } });
    }, this.options.idleStaleMs);
    this.idleReconnectTimer = this.setTimer(() => {
      // The connection has been silent long enough that an intermediary has likely dropped
      // it without an EOF. Abort and reconnect from the confirmed cursor.
      this.abort?.abort();
      if (!this.stopped) void this.connect();
    }, this.options.idleReconnectMs);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.clearAllTimers();
    this.pendingBySeq.clear();

    this.notify({ phase: { phase: "connecting", attempt: this.attempt + 1 } });
    const controller = new AbortController();
    this.abort = controller;

    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(this.options.url(this.snapshot.lastConfirmedSeq), {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
    } catch {
      if (this.stopped || generation !== this.generation || controller.signal.aborted) return;
      this.scheduleRetry();
      return;
    }
    if (this.stopped || generation !== this.generation) return;

    if (response.status === 401) {
      this.notify({
        phase: {
          phase: "failed",
          reason: "unauthorized",
          message: "The session is no longer valid.",
        },
      });
      this.options.onAuthError?.();
      return;
    }
    if (response.status === 403) {
      this.notify({
        phase: {
          phase: "failed",
          reason: "forbidden",
          message: "Atlas did not permit this account to read job events.",
        },
      });
      return;
    }
    if (response.status === 404) {
      this.notify({
        phase: { phase: "failed", reason: "not_found", message: "Atlas has no such job." },
      });
      return;
    }
    if (!response.ok || !response.body) {
      this.scheduleRetry();
      return;
    }

    this.notify({ phase: { phase: "streaming" } });
    this.armIdleWatchdog();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseFrameParser();
    let outcome: FrameOutcome = "continue";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (this.stopped || generation !== this.generation) return;
        if (done) break;
        const frames = parser.push(decoder.decode(value, { stream: true }));
        const signals = parser.takeTransportSignals();
        if (signals.retryMs !== null) this.retryHintMs = signals.retryMs;
        if (signals.activity) {
          // Any received bytes, including a comment-only keepalive, prove the connection is alive.
          this.attempt = 0;
          this.armIdleWatchdog();
          if (this.snapshot.phase.phase === "stale") this.notify({ phase: { phase: "streaming" } });
        }
        for (const frame of frames) {
          outcome = this.handleFrame(frame);
          if (outcome !== "continue") break;
        }
        if (outcome !== "continue") break;
      }
    } catch {
      // Read error (network drop, abort): fall through to the disconnect path below.
    }

    this.clearTimer(this.staleTimer);
    this.clearTimer(this.idleReconnectTimer);
    if (this.stopped || generation !== this.generation) return;

    if (outcome === "finished") {
      reader.cancel().catch(() => {});
      return;
    }
    if (outcome === "reconnect") {
      // Gap verification pass: reconnect immediately from the confirmed cursor. Not counted
      // against the backoff budget — it is one bounded probe per gap position, not a loop.
      reader.cancel().catch(() => {});
      void this.connect();
      return;
    }

    // EOF without a close frame — a mid-stream disconnect. If out-of-order frames were still
    // pending, the hole can no longer be filled by this connection; the reconnect replays from
    // the confirmed cursor, and `gapProbeAt` arms the one-shot verification.
    if (this.pendingBySeq.size > 0) {
      this.gapProbeAt = this.snapshot.lastConfirmedSeq;
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    const { baseMs, factor, maxMs, maxAttempts } = this.options.backoff;
    this.attempt += 1;
    if (this.attempt > maxAttempts) {
      this.notify({
        phase: {
          phase: "failed",
          reason: "exhausted",
          message: "Automatic reconnects were exhausted.",
        },
      });
      return;
    }
    const exponential = baseMs * factor ** (this.attempt - 1);
    const delay = Math.min(Math.max(exponential, this.retryHintMs ?? 0), maxMs);
    this.notify({ phase: { phase: "disconnected", attempt: this.attempt, retryInMs: delay } });
    this.retryTimer = this.setTimer(() => void this.connect(), delay);
  }

  private handleFrame(frame: SseFrame): FrameOutcome {
    if (frame.event === "close") return this.handleClose(frame);

    const event = this.parseDataFrame(frame);
    if (event === null) {
      this.notify({ malformed: this.snapshot.malformed + 1 });
      return "continue";
    }

    const last = this.snapshot.lastConfirmedSeq;
    if (event.seq <= last) {
      this.notify({ duplicates: this.snapshot.duplicates + 1 });
      return "continue";
    }
    if (event.seq === last + 1) {
      this.gapProbeAt = null;
      this.commit(event);
      this.flushPending();
      return "continue";
    }

    // seq > last + 1: a hole. Atlas orders each connection ascending, so the hole can only be
    // filled by out-of-order delivery inside this connection — buffer for that case. If a
    // fresh replay from this same cursor shows the same hole, the rows verifiably do not
    // exist and the cursor may advance past them (with the gap surfaced, never silently).
    if (this.gapProbeAt === last) {
      this.gapProbeAt = null;
      this.notify({ gapNotice: true });
      this.commit(event);
      this.flushPending(true);
      this.options.onGap?.();
      return "continue";
    }
    this.pendingBySeq.set(event.seq, event);
    if (this.pendingBySeq.size > PENDING_CAP) {
      this.gapProbeAt = last;
      return "reconnect";
    }
    return "continue";
  }

  private handleClose(frame: SseFrame): FrameOutcome {
    let state = "unknown";
    try {
      const payload: unknown = JSON.parse(frame.data);
      if (payload !== null && typeof payload === "object") {
        const value = (payload as Record<string, unknown>).state;
        if (typeof value === "string" && value.length > 0) state = value;
      }
    } catch {
      // A close frame with an unreadable payload is still a close frame.
    }

    // The close id is `last_seq + 1` — a row that does not exist — and the close payload
    // carries no seq. Neither may advance `lastConfirmedSeq`.
    if (this.pendingBySeq.size > 0) {
      // Terminal, but with an unfilled hole before it: surface the gap and hand the committed
      // frames over in order; the authoritative record is Atlas's persisted history.
      this.notify({ gapNotice: true });
      this.flushPending(true);
      this.options.onGap?.();
    }

    this.clearAllTimers();
    this.notify({ phase: { phase: "terminal", state } });
    this.options.onTerminal?.(state);
    return "finished";
  }

  private parseDataFrame(frame: SseFrame): JobStreamEvent | null {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(frame.data);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      payload = parsed as Record<string, unknown>;
    } catch {
      return null;
    }

    // Atlas supplies the same positive sequence twice: as the SSE id and in the JSON payload.
    // Requiring both and requiring equality prevents a malformed frame from advancing the
    // exclusive resume cursor past rows the browser has never committed.
    if (frame.id === null || !/^\d+$/.test(frame.id)) return null;
    const idSeq = Number.parseInt(frame.id, 10);
    if (!Number.isSafeInteger(idSeq) || idSeq <= 0) return null;
    if (
      typeof payload.seq !== "number" ||
      !Number.isSafeInteger(payload.seq) ||
      payload.seq <= 0 ||
      payload.seq !== idSeq
    ) {
      return null;
    }

    const createdAt =
      typeof payload.created_at === "string" && payload.created_at.length > 0
        ? payload.created_at
        : null;
    if (createdAt === null) return null;

    const type = frame.event;
    const text = type === "text" && typeof payload.text === "string" ? payload.text : null;

    let detail = "";
    if (text === null) {
      // Compact and bounded: the payload was already projected/redacted by Atlas, and the
      // live log is a window, not an archive.
      const { seq: _seq, created_at: _createdAt, ...rest } = payload;
      detail = JSON.stringify(rest).slice(0, 500);
    }

    return { seq: idSeq, type, createdAt, text, detail, known: KNOWN_EVENT_TYPES.has(type) };
  }

  private commit(event: JobStreamEvent): void {
    const events = [...this.snapshot.events, event];
    let dropped = this.snapshot.dropped;
    // ponytail: plain array with shift-style truncation; at a 500-item cap a ring buffer buys
    // nothing measurable.
    if (events.length > this.options.maxEvents) {
      dropped += events.length - this.options.maxEvents;
      events.splice(0, events.length - this.options.maxEvents);
    }
    this.notify({ events, dropped, lastConfirmedSeq: event.seq });
    this.options.onEvent?.(event);
  }

  /**
   * Commits buffered out-of-order frames. Normally only the consecutive run after the cursor;
   * with `all` (a verified gap), everything ascending — their seqs are real Atlas rows, and the
   * gap has already been surfaced.
   */
  private flushPending(all = false): void {
    if (this.pendingBySeq.size === 0) return;
    const seqs = [...this.pendingBySeq.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      const event = this.pendingBySeq.get(seq);
      if (!event) continue;
      if (seq <= this.snapshot.lastConfirmedSeq) {
        this.pendingBySeq.delete(seq);
        continue;
      }
      if (!all && seq !== this.snapshot.lastConfirmedSeq + 1) break;
      this.pendingBySeq.delete(seq);
      this.commit(event);
    }
  }
}
