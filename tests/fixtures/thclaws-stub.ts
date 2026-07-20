/**
 * A minimal thClaws-compatible worker for the test harness.
 *
 * This is NOT a mock of Atlas's SSE endpoint — Atlas genuinely executes the job, consumes this
 * worker's `/agent/run` stream (`atlas/thclaws_client.py` `run_agent_stream`/`iter_sse`), writes
 * real `job_events` rows, and serves its own `/api/jobs/{id}/events` stream from them. The stub
 * exists because the harness's other workers are deliberately unreachable, which makes every
 * job fail within milliseconds: fine for read fixtures, useless for observing a *running* job.
 *
 * The lifecycle is deterministic and controlled by the job's own prompt:
 *
 *   "stub:count=5;interval=200"        five text frames, one every 200 ms, then [DONE]
 *   "stub:count=1;interval=0;stall=20000"  one frame, then 20 s of silence, then [DONE]
 *
 * Defaults: count=3, interval=100, stall=0. Every response ends with `data: [DONE]` — except
 * when the prompt contains `nodone`, which ends the stream without it so Atlas's
 * "stream ended without a terminal [DONE] frame" failure path can be exercised.
 *
 * Implements exactly what Atlas dials: `GET /healthz`, `GET /v1/agent/info`, `POST /agent/run`.
 */

import { createServer, type Server } from "node:http";

export interface StubWorker {
  origin: string;
  port: number;
  /** Number of /agent/run requests served, for asserting Atlas actually dialled us. */
  runsServed: () => number;
  close: () => Promise<void>;
}

interface StubDirectives {
  count: number;
  interval: number;
  stall: number;
  done: boolean;
}

function parseDirectives(prompt: string): StubDirectives {
  const directives: StubDirectives = { count: 3, interval: 100, stall: 0, done: true };
  const match = /stub:([a-z0-9=;]*)/i.exec(prompt);
  if (match) {
    for (const pair of match[1]!.split(";")) {
      const [key, value] = pair.split("=");
      const parsed = Number.parseInt(value ?? "", 10);
      if (key === "count" && Number.isFinite(parsed)) directives.count = parsed;
      if (key === "interval" && Number.isFinite(parsed)) directives.interval = parsed;
      if (key === "stall" && Number.isFinite(parsed)) directives.stall = parsed;
      if (key === "nodone") directives.done = false;
    }
  }
  if (/nodone/.test(prompt)) directives.done = false;
  return directives;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startStubWorker(): Promise<StubWorker> {
  let runsServed = 0;

  const server: Server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "thclaws-stub", version: "0.0.1" }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/agent/info") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: "thclaws-stub", version: "0.0.1", models: [] }));
      return;
    }
    if (request.method === "POST" && request.url === "/agent/run") {
      runsServed += 1;
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        let prompt = "";
        try {
          const parsed = JSON.parse(body) as { prompt?: string };
          prompt = parsed.prompt ?? "";
        } catch {
          // An unreadable body streams the defaults.
        }
        const directives = parseDirectives(prompt);

        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "close",
        });

        void (async () => {
          try {
            for (let index = 1; index <= directives.count; index += 1) {
              if (response.destroyed) return;
              response.write(
                `event: text\ndata: ${JSON.stringify({ text: `stub line ${index}\n` })}\n\n`,
              );
              if (directives.interval > 0) await sleep(directives.interval);
            }
            if (directives.stall > 0) await sleep(directives.stall);
            if (response.destroyed) return;
            if (directives.done) response.write("data: [DONE]\n\n");
          } finally {
            response.end();
          }
        })();
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("stub worker could not resolve its port");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    runsServed: () => runsServed,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Open SSE responses hold the server; close them so shutdown never hangs.
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
