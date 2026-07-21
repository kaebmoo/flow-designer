/**
 * Job-event SSE contract tests against a REAL Atlas instance (Phase 4).
 *
 * No mock SSE server anywhere: every stream read here comes from Atlas's own
 * `GET /api/jobs/{job_id}/events` handler (`atlas/app.py` `_stream_job_events`), serving rows
 * Atlas itself wrote while executing real jobs. Two deterministic job lifecycles are used:
 *
 *  - a job routed to the harness's deliberately unreachable worker, which fails within
 *    milliseconds and terminally settles with exactly three events
 *    (`route`, `state: running`, `error`);
 *  - a job routed to the thClaws-compatible stub worker fixture, which Atlas genuinely dials
 *    and streams from — the stub substitutes for a *worker*, not for Atlas's SSE.
 *
 * The production adapter (`JobEventStream`, `SseFrameParser`) is also driven against the real
 * stream, so its parsing is proven on real Atlas bytes, not only on synthetic frames.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { atlasLogin, atlasOpenJobEventStream } from "@/lib/atlas-api.server";
import {
  JobEventStream,
  SseFrameParser,
  type JobStreamSnapshot,
  type SseFrame,
} from "@/lib/job-stream";
import { resetServerEnvCache } from "@/lib/env.server";
import { startStubWorker, type StubWorker } from "../fixtures/thclaws-stub";
import {
  ADMIN_CREDENTIALS,
  atlasAvailable,
  startIsolatedAtlas,
  type AtlasInstance,
} from "./atlas-instance";

const available = atlasAvailable();
let atlas: AtlasInstance | undefined;
let stub: StubWorker | undefined;
let adminToken = "";
let unreachableWorkerId = "";
let stubWorkerId = "";

// ---------------------------------------------------------------------------
// Harness helpers (all through Atlas's own API; nothing fabricated)
// ---------------------------------------------------------------------------

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${atlas!.origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
      // The keep-alive desync workaround the production client applies; docs/ATLAS_LIMITATIONS.md.
      connection: "close",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function submitJob(workerId: string, prompt: string): Promise<string> {
  const payload = (await api("POST", "/api/jobs", { prompt, worker_id: workerId })) as {
    job: { id: string };
  };
  return payload.job.id;
}

async function untilJobTerminal(jobId: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const payload = (await api("GET", `/api/jobs/${jobId}`)) as { job: { state: string } };
    if (["succeeded", "failed", "cancelled"].includes(payload.job.state)) return payload.job.state;
    if (Date.now() > deadline) throw new Error(`job ${jobId} never terminal: ${payload.job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Reads one whole stream through the production connect + parse path, until EOF. */
async function readStream(jobId: string, after: number): Promise<SseFrame[]> {
  return (await readStreamWithSignals(jobId, after)).frames;
}

async function readStreamWithSignals(
  jobId: string,
  after: number,
): Promise<{ frames: SseFrame[]; activity: boolean; retryMs: number | null }> {
  const response = await atlasOpenJobEventStream(adminToken, jobId, after);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();
  const frames: SseFrame[] = [];
  let activity = false;
  let retryMs: number | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    frames.push(...parser.push(decoder.decode(value, { stream: true })));
    const signals = parser.takeTransportSignals();
    activity ||= signals.activity;
    if (signals.retryMs !== null) retryMs = signals.retryMs;
  }
  return { frames, activity, retryMs };
}

function dataOf(frame: SseFrame): Record<string, unknown> {
  return JSON.parse(frame.data) as Record<string, unknown>;
}

beforeAll(async () => {
  if (!available) return;
  atlas = await startIsolatedAtlas();
  stub = await startStubWorker();

  process.env.ATLAS_API_ORIGIN = atlas.origin;
  process.env.PUBLIC_ORIGIN = "http://localhost:3000";
  process.env.SESSION_SECRET = "d".repeat(32);
  process.env.NODE_ENV = "test";
  resetServerEnvCache();

  adminToken = (await atlasLogin(ADMIN_CREDENTIALS)).token;

  // One unreachable worker (fail-fast lifecycle) and one real stub worker (streaming
  // lifecycle). Distinct base_urls: Atlas upserts workers on that natural key.
  // The discard port on 127.0.0.1 exactly like the shared seed harness: it refuses instantly
  // on every platform, where another loopback alias (127.0.0.x) can *hang* on macOS instead
  // of refusing — turning the fail-fast lifecycle into a 75-second connect timeout.
  const dead = (await api("POST", "/api/workers", {
    name: "Stream Contract Dead Worker",
    base_url: "http://127.0.0.1:9",
    role: "reporter",
  })) as { worker: { id: string } };
  unreachableWorkerId = dead.worker.id;

  const live = (await api("POST", "/api/workers", {
    name: "Stream Contract Stub Worker",
    base_url: stub.origin,
    role: "streamer",
  })) as { worker: { id: string } };
  stubWorkerId = live.worker.id;
}, 60_000);

afterAll(async () => {
  const output = atlas?.logs() ?? "";
  if (output.trim()) console.log(`--- Atlas server output ---\n${output}`);
  atlas?.stop();
  await stub?.close();
  resetServerEnvCache();
});

describe.skipIf(!available)("Atlas job-event SSE contract", () => {
  it("streams text/event-stream with id=seq, created_at, and a terminal close, then EOF", async () => {
    const jobId = await submitJob(unreachableWorkerId, "Stream contract: fail fast.");
    const state = await untilJobTerminal(jobId);
    expect(state).toBe("failed");

    // Content type is asserted by the production opener itself (it throws `protocol`
    // otherwise); re-assert here so the contract is named by a test, not only by a guard.
    const response = await atlasOpenJobEventStream(adminToken, jobId, 0);
    expect((response.headers.get("content-type") ?? "").split(";")[0]).toBe("text/event-stream");
    response.body?.cancel().catch(() => {});

    const stream = await readStreamWithSignals(jobId, 0);
    const frames = stream.frames;
    expect(stream.activity).toBe(true);
    expect(stream.retryMs).toBe(3_000);
    expect(frames.length).toBeGreaterThanOrEqual(4); // route, state, error, close

    const dataFrames = frames.slice(0, -1);
    const close = frames.at(-1)!;

    let previousSeq = 0;
    for (const frame of dataFrames) {
      expect(frame.event).not.toBe("close");
      // id: <seq> on every normal frame, integer, ascending.
      expect(frame.id).toMatch(/^\d+$/);
      const payload = dataOf(frame);
      expect(payload.seq).toBe(Number(frame.id));
      expect(typeof payload.created_at).toBe("string");
      expect(payload.seq as number).toBeGreaterThan(previousSeq);
      previousSeq = payload.seq as number;
    }
    expect(dataFrames.map((frame) => frame.event)).toEqual(["route", "state", "error"]);

    // Terminal frame: event=close, an id, and the job's terminal state — and the stream ended
    // (readStream returned, i.e. Atlas closed after writing it).
    expect(close.event).toBe("close");
    expect(close.id).toMatch(/^\d+$/);
    expect(dataOf(close)).toEqual({ state: "failed" });
    expect(Number(close.id)).toBe(previousSeq + 1);
  });

  it("treats after as an exclusive lower bound", async () => {
    const jobId = await submitJob(unreachableWorkerId, "Stream contract: replay boundaries.");
    await untilJobTerminal(jobId);

    const all = await readStream(jobId, 0);
    const seqs = all.slice(0, -1).map((frame) => Number(frame.id));
    const first = seqs[0]!;
    const last = seqs.at(-1)!;

    // after=<first seq> must exclude that seq and start strictly after it.
    const replay = await readStream(jobId, first);
    const replaySeqs = replay.slice(0, -1).map((frame) => Number(frame.id));
    expect(replaySeqs).toEqual(seqs.slice(1));

    // after=<last data seq> leaves nothing but the close frame.
    const tail = await readStream(jobId, last);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.event).toBe("close");
  });

  it("drives the production adapter to terminal against the real stream", async () => {
    const jobId = await submitJob(unreachableWorkerId, "Stream contract: adapter end-to-end.");
    await untilJobTerminal(jobId);

    // The adapter normally points at the same-origin proxy; here its injected fetch adds the
    // bearer server-side-style and dials Atlas directly. Real frames, real close.
    const stream = new JobEventStream({
      url: (after) => `${atlas!.origin}/api/jobs/${jobId}/events?after=${after}`,
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
        fetch(input, {
          ...init,
          headers: { ...Object(init?.headers), authorization: `Bearer ${adminToken}` },
        })) as typeof fetch,
    });

    const terminal = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("adapter never reached terminal")), 15_000);
      stream.subscribe(() => {
        const snapshot: JobStreamSnapshot = stream.getSnapshot();
        if (snapshot.phase.phase === "terminal") {
          clearTimeout(timer);
          resolve(snapshot.phase.state);
        }
      });
      stream.start();
    });
    stream.stop();

    expect(terminal).toBe("failed");
    const snapshot = stream.getSnapshot();
    expect(snapshot.events.map((event) => event.type)).toEqual(["route", "state", "error"]);
    expect(snapshot.gapNotice).toBe(false);
    expect(snapshot.malformed).toBe(0);
    // The close frame's id is last+1 and must not have advanced the cursor.
    expect(snapshot.lastConfirmedSeq).toBe(snapshot.events.at(-1)?.seq);
  });

  it("streams a genuinely running job live from the stub worker, then closes succeeded", async () => {
    const jobId = await submitJob(stubWorkerId, "stub:count=6;interval=250");

    // Connect while the job is still running — the point of the stub fixture.
    const frames = await readStream(jobId, 0);
    const close = frames.at(-1)!;
    expect(close.event).toBe("close");
    expect(dataOf(close).state).toBe("succeeded");

    const types = frames.slice(0, -1).map((frame) => frame.event);
    expect(types.filter((type) => type === "text")).toHaveLength(6);
    expect(stub!.runsServed()).toBeGreaterThanOrEqual(1);
    expect(await untilJobTerminal(jobId)).toBe("succeeded");
  });

  it("resumes a live stream mid-run with after and receives no duplicates", async () => {
    const jobId = await submitJob(stubWorkerId, "stub:count=8;interval=250");

    // First connection: take frames until at least two data frames arrived, then drop the
    // connection without a close — a mid-stream disconnect.
    const first = await atlasOpenJobEventStream(adminToken, jobId, 0);
    const reader = first.body!.getReader();
    const decoder = new TextDecoder();
    const parser = new SseFrameParser();
    const seen: SseFrame[] = [];
    while (seen.filter((frame) => frame.event !== "close").length < 2) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stream ended before two data frames");
      seen.push(...parser.push(decoder.decode(value, { stream: true })));
    }
    await reader.cancel();
    const lastSeq = Math.max(
      ...seen.filter((frame) => frame.event !== "close").map((frame) => Number(frame.id)),
    );

    // Resume exactly where the confirmed cursor stands. Everything that arrives must be
    // strictly beyond it — `after` is exclusive — and the stream must still end with close.
    const resumed = await readStream(jobId, lastSeq);
    const resumedSeqs = resumed.slice(0, -1).map((frame) => Number(frame.id));
    expect(Math.min(...resumedSeqs)).toBeGreaterThan(lastSeq);
    expect(new Set(resumedSeqs).size).toBe(resumedSeqs.length);
    expect(resumed.at(-1)?.event).toBe("close");
  }, 30_000);
});
