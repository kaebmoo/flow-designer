/**
 * The per-job SSE stream driver, exercised with synthetic frames and a fake clock.
 *
 * Everything time- or network-shaped is injected, so each rule of the verified Atlas contract
 * (`docs/BACKEND_INTEGRATION.md`, "Job event SSE contract") is asserted deterministically:
 * exclusive `after` resume, dedupe by seq, out-of-order tolerance without state regression,
 * verified gap crossing, terminal `close`, EOF-without-close reconnects under bounded backoff,
 * a retry ceiling with a manual Retry, transport-idle staleness, and a hard memory bound.
 *
 * These are unit tests of the adapter and transport behaviour only. They prove nothing about
 * the production path against a real Atlas — `tests/contract/stream.contract.test.ts` does
 * that, with no mock SSE server.
 */

import { describe, expect, it } from "vitest";

import {
  JobEventStream,
  type JobStreamEvent,
  type JobStreamOptions,
  type JobStreamSnapshot,
} from "@/lib/job-stream";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Lets pending promise callbacks run. Two rounds cover promise-of-promise chains. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class FakeClock {
  private timers = new Map<number, { fn: () => void; at: number }>();
  private nextId = 1;
  now = 0;

  set = (fn: () => void, ms: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };

  clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Advances fake time, firing due timers in order and letting async work settle between. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
      await flush();
    }
    this.now = target;
    await flush();
  }

  pending(): number {
    return this.timers.size;
  }
}

/** One controllable SSE connection: push frames, end cleanly, or error mid-read. */
class FakeConnection {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly response: Response;

  constructor(status = 200, signal?: AbortSignal) {
    if (status === 200) {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.controller = controller;
          signal?.addEventListener("abort", () => {
            try {
              controller.error(new DOMException("aborted", "AbortError"));
            } catch {
              // already closed
            }
          });
        },
      });
      this.response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    } else {
      this.response = new Response("refused", { status });
    }
  }

  push(text: string): void {
    this.controller.enqueue(new TextEncoder().encode(text));
  }

  end(): void {
    try {
      this.controller.close();
    } catch {
      // already closed/errored
    }
  }
}

/** Records every requested URL and hands out one scripted connection per request. */
class FakeTransport {
  urls: string[] = [];
  connections: FakeConnection[] = [];
  /** Status per upcoming connection; defaults to 200. "network" throws instead. */
  script: Array<number | "network"> = [];

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.urls.push(String(input));
    const behaviour = this.script.shift() ?? 200;
    if (behaviour === "network") return Promise.reject(new TypeError("fetch failed"));
    const connection = new FakeConnection(behaviour, init?.signal ?? undefined);
    this.connections.push(connection);
    return Promise.resolve(connection.response);
  };

  latest(): FakeConnection {
    const connection = this.connections.at(-1);
    if (!connection) throw new Error("no connection opened yet");
    return connection;
  }
}

function frame(seq: number, type: string, payload: Record<string, unknown> = {}): string {
  const data = JSON.stringify({
    seq,
    created_at: `2026-07-20T00:00:${String(seq).padStart(2, "0")}`,
    ...payload,
  });
  return `id: ${seq}\nevent: ${type}\ndata: ${data}\n\n`;
}

function closeFrame(id: number, state: string): string {
  return `id: ${id}\nevent: close\ndata: ${JSON.stringify({ state })}\n\n`;
}

interface Rig {
  stream: JobEventStream;
  transport: FakeTransport;
  clock: FakeClock;
  events: JobStreamEvent[];
  terminals: string[];
  gaps: number;
  authErrors: number;
  snapshot: () => JobStreamSnapshot;
}

function rig(overrides: Partial<JobStreamOptions> = {}): Rig {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const events: JobStreamEvent[] = [];
  const terminals: string[] = [];
  const state = { gaps: 0, authErrors: 0 };

  const stream = new JobEventStream({
    url: (after) => `/api/jobs/job_1/events?after=${after}`,
    fetchImpl: transport.fetch as typeof fetch,
    setTimer: clock.set,
    clearTimer: clock.clear,
    onEvent: (event) => events.push(event),
    onTerminal: (terminal) => terminals.push(terminal),
    onGap: () => {
      state.gaps += 1;
    },
    onAuthError: () => {
      state.authErrors += 1;
    },
    ...overrides,
  });

  return {
    stream,
    transport,
    clock,
    events,
    terminals,
    get gaps() {
      return state.gaps;
    },
    get authErrors() {
      return state.authErrors;
    },
    snapshot: () => stream.getSnapshot(),
  };
}

async function start(r: Rig): Promise<void> {
  r.stream.start();
  await flush();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JobEventStream", () => {
  it("connects with after=<lastConfirmedSeq> and replays from there on reconnect", async () => {
    const r = rig();
    await start(r);
    expect(r.transport.urls).toEqual(["/api/jobs/job_1/events?after=0"]);

    r.transport.latest().push(frame(1, "route") + frame(2, "state", { state: "running" }));
    await flush();
    expect(r.snapshot().lastConfirmedSeq).toBe(2);

    // EOF without close = disconnect; the reconnect must resume from the *confirmed* cursor,
    // which `after`'s exclusive semantics then replay strictly after.
    r.transport.latest().end();
    await flush();
    await r.clock.advance(1_000);
    expect(r.transport.urls).toEqual([
      "/api/jobs/job_1/events?after=0",
      "/api/jobs/job_1/events?after=2",
    ]);
    r.stream.stop();
  });

  it("drops duplicate seqs without duplicating log lines", async () => {
    const r = rig();
    await start(r);
    r.transport.latest().push(frame(1, "text", { text: "a" }) + frame(2, "text", { text: "b" }));
    r.transport.latest().push(frame(2, "text", { text: "b" }) + frame(3, "text", { text: "c" }));
    await flush();

    expect(r.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(r.snapshot().events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(r.snapshot().duplicates).toBe(1);
    r.stream.stop();
  });

  it("reorders out-of-order frames without regressing state", async () => {
    const r = rig();
    await start(r);
    r.transport.latest().push(frame(1, "state") + frame(3, "text", { text: "late" }));
    await flush();
    // 3 arrived before 2: buffered, cursor NOT advanced across the hole.
    expect(r.snapshot().lastConfirmedSeq).toBe(1);

    r.transport.latest().push(frame(2, "state"));
    await flush();
    expect(r.snapshot().lastConfirmedSeq).toBe(3);
    expect(r.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(r.snapshot().gapNotice).toBe(false);
    r.stream.stop();
  });

  it("crosses an unclosable gap only after a reconnect replay confirms it, then refetches", async () => {
    const r = rig();
    await start(r);
    r.transport.latest().push(frame(1, "state") + frame(3, "text", { text: "x" }));
    r.transport.latest().end(); // EOF with the hole still open
    await flush();
    expect(r.snapshot().lastConfirmedSeq).toBe(1);
    expect(r.gaps).toBe(0);

    await r.clock.advance(1_000);
    expect(r.transport.urls.at(-1)).toBe("/api/jobs/job_1/events?after=1");
    // The replay from the same cursor shows the same hole: seq 2 verifiably does not exist.
    r.transport.latest().push(frame(3, "text", { text: "x" }));
    await flush();

    expect(r.snapshot().lastConfirmedSeq).toBe(3);
    expect(r.snapshot().gapNotice).toBe(true);
    expect(r.gaps).toBe(1);
    expect(r.events.map((event) => event.seq)).toEqual([1, 3]);
    r.stream.stop();
  });

  it("treats event: close as terminal and never reconnects afterwards", async () => {
    const r = rig();
    await start(r);
    r.transport.latest().push(frame(1, "state") + closeFrame(2, "succeeded"));
    await flush();

    expect(r.snapshot().phase).toEqual({ phase: "terminal", state: "succeeded" });
    expect(r.terminals).toEqual(["succeeded"]);
    // The close id (2) must not become the cursor — it names a row that does not exist.
    expect(r.snapshot().lastConfirmedSeq).toBe(1);

    // No timer may be armed and no reconnect may happen, however long we wait.
    expect(r.clock.pending()).toBe(0);
    await r.clock.advance(300_000);
    expect(r.transport.urls).toHaveLength(1);
    r.stream.stop();
  });

  it("reports the close state verbatim, including missing", async () => {
    const r = rig();
    await start(r);
    r.transport.latest().push(closeFrame(1, "missing"));
    await flush();
    expect(r.snapshot().phase).toEqual({ phase: "terminal", state: "missing" });
    r.stream.stop();
  });

  it("backs off exponentially with a bound, then stops with a working manual Retry", async () => {
    const r = rig();
    r.transport.script = [
      "network",
      "network",
      "network",
      "network",
      "network",
      "network",
      "network",
    ];
    await start(r);

    // Six attempts at 1s, 2s, 4s, 8s, 16s, 30s(capped) — then exhausted.
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
    for (const [index, delay] of delays.entries()) {
      const phase = r.snapshot().phase;
      expect(phase).toEqual({ phase: "disconnected", attempt: index + 1, retryInMs: delay });
      await r.clock.advance(delay);
    }
    expect(r.snapshot().phase).toEqual({
      phase: "failed",
      reason: "exhausted",
      message: "Automatic reconnects were exhausted.",
    });
    expect(r.transport.urls).toHaveLength(7); // initial + 6 retries
    expect(r.clock.pending()).toBe(0);

    // Manual Retry starts over.
    r.stream.retry();
    await flush();
    expect(r.transport.urls).toHaveLength(8);
    r.transport.latest().push(frame(1, "state") + closeFrame(2, "failed"));
    await flush();
    expect(r.snapshot().phase).toEqual({ phase: "terminal", state: "failed" });
  });

  it("marks a silent open connection stale, then recovers on the next frame", async () => {
    const r = rig();
    await start(r);
    r.transport.latest().push(frame(1, "state"));
    await flush();
    expect(r.snapshot().phase.phase).toBe("streaming");

    await r.clock.advance(15_000);
    expect(r.snapshot().phase.phase).toBe("stale");

    // Idle is transport display only — a frame flips it straight back, no reconnect needed.
    r.transport.latest().push(frame(2, "text", { text: "again" }));
    await flush();
    expect(r.snapshot().phase.phase).toBe("streaming");
    expect(r.transport.urls).toHaveLength(1);
    r.stream.stop();
  });

  it("reconnects a connection idle past the watchdog ceiling, resuming from the cursor", async () => {
    const r = rig();
    await start(r);
    r.transport.latest().push(frame(1, "state"));
    await flush();

    await r.clock.advance(45_000);
    expect(r.transport.urls).toEqual([
      "/api/jobs/job_1/events?after=0",
      "/api/jobs/job_1/events?after=1",
    ]);
    // The superseded read loop must not have scheduled a competing retry.
    r.transport.latest().push(frame(2, "state") + closeFrame(3, "succeeded"));
    await flush();
    expect(r.snapshot().phase).toEqual({ phase: "terminal", state: "succeeded" });
    await r.clock.advance(120_000);
    expect(r.transport.urls).toHaveLength(2);
    r.stream.stop();
  });

  it("stops on a 401 without reconnecting, and reports it for the session guard", async () => {
    const r = rig();
    await start(r);
    r.transport.latest().push(frame(1, "state"));
    r.transport.latest().end();
    await flush();

    r.transport.script = [401];
    await r.clock.advance(1_000);
    expect(r.snapshot().phase).toEqual({
      phase: "failed",
      reason: "unauthorized",
      message: "The session is no longer valid.",
    });
    expect(r.authErrors).toBe(1);
    expect(r.clock.pending()).toBe(0);
    await r.clock.advance(300_000);
    expect(r.transport.urls).toHaveLength(2);
    r.stream.stop();
  });

  it("stops on a 403 and reports access denied instead of retrying it as a disconnect", async () => {
    const r = rig();
    r.transport.script = [403];
    await start(r);

    expect(r.snapshot().phase).toEqual({
      phase: "failed",
      reason: "forbidden",
      message: "Atlas did not permit this account to read job events.",
    });
    expect(r.authErrors).toBe(0);
    expect(r.clock.pending()).toBe(0);
    await r.clock.advance(300_000);
    expect(r.transport.urls).toHaveLength(1);
    r.stream.stop();
  });

  it("stops on a 404 — the job row is gone and retrying cannot bring it back", async () => {
    const r = rig();
    r.transport.script = [404];
    await start(r);
    expect(r.snapshot().phase).toEqual({
      phase: "failed",
      reason: "not_found",
      message: "Atlas has no such job.",
    });
    expect(r.clock.pending()).toBe(0);
    r.stream.stop();
  });

  it("commits unknown event types safely, flagged with the diagnostic marker", async () => {
    const r = rig();
    await start(r);
    r.transport
      .latest()
      .push(
        frame(1, "state") +
          frame(2, "wibble", { anything: true }) +
          frame(3, "text", { text: "on" }),
      );
    await flush();

    const unknown = r.snapshot().events.find((event) => event.seq === 2);
    expect(unknown?.known).toBe(false);
    expect(unknown?.type).toBe("wibble");
    // The stream carried on: skipping seq 2 would have opened a false gap.
    expect(r.snapshot().lastConfirmedSeq).toBe(3);
    expect(r.snapshot().malformed).toBe(0);
    r.stream.stop();
  });

  it("ignores malformed frames without advancing the cursor", async () => {
    const r = rig();
    await start(r);
    const bad =
      "id: 1\nevent: text\ndata: not-json\n\n" + // unparseable payload
      'event: text\ndata: {"text":"no seq anywhere"}\n\n'; // no seq, no id
    r.transport.latest().push(bad + frame(1, "text", { text: "good" }));
    await flush();

    expect(r.snapshot().malformed).toBe(2);
    expect(r.snapshot().lastConfirmedSeq).toBe(1);
    expect(r.events.map((event) => event.seq)).toEqual([1]);
    r.stream.stop();
  });

  it("requires matching id/seq and created_at before advancing the resume cursor", async () => {
    const r = rig();
    await start(r);
    const malformed =
      'id: 1\nevent: state\ndata: {"seq":2,"created_at":"2026-07-20T00:00:01"}\n\n' +
      'id: 1\nevent: state\ndata: {"created_at":"2026-07-20T00:00:01"}\n\n' +
      'event: state\ndata: {"seq":1,"created_at":"2026-07-20T00:00:01"}\n\n' +
      'id: 1\nevent: state\ndata: {"seq":1}\n\n';
    r.transport.latest().push(malformed + frame(1, "state", { state: "running" }));
    await flush();

    expect(r.snapshot().malformed).toBe(4);
    expect(r.snapshot().lastConfirmedSeq).toBe(1);
    expect(r.events.map((event) => event.seq)).toEqual([1]);
    r.stream.stop();
  });

  it("holds the live buffer at its hard cap however long the stream runs", async () => {
    const r = rig({ maxEvents: 50 });
    await start(r);
    for (let seq = 1; seq <= 600; seq += 1) {
      r.transport.latest().push(frame(seq, "text", { text: `line ${seq}` }));
    }
    await flush();

    const snapshot = r.snapshot();
    expect(snapshot.events).toHaveLength(50);
    expect(snapshot.events[0]?.seq).toBe(551);
    expect(snapshot.events.at(-1)?.seq).toBe(600);
    expect(snapshot.dropped).toBe(550);
    expect(snapshot.lastConfirmedSeq).toBe(600);
    r.stream.stop();
  });

  it("clears every timer on stop, and fires nothing afterwards", async () => {
    const r = rig();
    await start(r);
    r.transport.latest().push(frame(1, "state"));
    r.transport.latest().end(); // schedules a backoff retry
    await flush();
    expect(r.clock.pending()).toBeGreaterThan(0);

    r.stream.stop();
    expect(r.clock.pending()).toBe(0);
    await r.clock.advance(300_000);
    expect(r.transport.urls).toHaveLength(1);
  });
});
