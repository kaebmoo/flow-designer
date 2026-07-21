import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ADMIN_CREDENTIALS,
  startIsolatedAtlas,
  type AtlasInstance,
} from "../contract/atlas-instance";
import { seedAtlas } from "../contract/atlas-seed";

const INTERNAL_APP_PORT = 3211;
const PUBLIC_PORT = 3443;
const INTERNAL_APP_ORIGIN = `http://127.0.0.1:${INTERNAL_APP_PORT}`;
export const PUBLIC_ORIGIN = `https://localhost:${PUBLIC_PORT}`;
export const SEED_FILE = "test-results/phase7-remote-seed.json";

interface Phase7Seed {
  atlasOrigin: string;
  artifactId: string;
  artifactBody: string;
  jobId: string;
  nodeVersion: string;
}

export function readPhase7Seed(): Phase7Seed {
  return JSON.parse(readFileSync(SEED_FILE, "utf-8")) as Phase7Seed;
}

let atlas: AtlasInstance | undefined;
let app: ChildProcess | undefined;
let proxy: HttpsServer | undefined;
let certificateDir: string | undefined;

async function waitFor(origin: string, appProcess?: ChildProcess, deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (appProcess?.exitCode != null) {
      throw new Error(`internal app exited early with code ${appProcess.exitCode}`);
    }
    try {
      const response = await fetch(`${origin}/auth`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // not listening yet (the public probe also uses a self-signed test certificate)
    }
    if (Date.now() > deadline) throw new Error(`${origin} did not become ready`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function login(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  if (!response.ok) throw new Error(`phase 7 seed login failed: ${response.status}`);
  return ((await response.json()) as { token: string }).token;
}

async function uploadArtifact(origin: string, token: string, runId: string) {
  const artifactBody = "phase 7 remote-like artifact\n";
  const response = await fetch(`${origin}/api/workflow-runs/${runId}/files?key=phase7_release`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain",
      "x-filename": "phase7-release.txt",
      connection: "close",
    },
    body: artifactBody,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`phase 7 artifact upload failed: ${response.status} ${text}`);
  const artifactId = (JSON.parse(text) as { artifact: { id: string } }).artifact.id;
  return { artifactId, artifactBody };
}

async function waitForTerminalJob(origin: string, token: string, jobId: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const response = await fetch(`${origin}/api/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`phase 7 job read failed: ${response.status}`);
    const state = ((await response.json()) as { job: { state: string } }).job.state;
    if (["succeeded", "failed", "cancelled"].includes(state)) return;
    if (Date.now() > deadline) throw new Error(`phase 7 job ${jobId} did not become terminal`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function createCertificate() {
  certificateDir = mkdtempSync(join(tmpdir(), "flow-designer-phase7-cert-"));
  const key = join(certificateDir, "key.pem");
  const cert = join(certificateDir, "cert.pem");
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr}`);
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

async function startProxy() {
  const tls = createCertificate();
  proxy = createHttpsServer(tls, (incoming, outgoing) => {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: INTERNAL_APP_PORT,
        method: incoming.method,
        path: incoming.url,
        headers: {
          ...incoming.headers,
          host: `localhost:${PUBLIC_PORT}`,
          "x-forwarded-host": `localhost:${PUBLIC_PORT}`,
          "x-forwarded-proto": "https",
        },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain" });
      outgoing.end("upstream unavailable");
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    proxy!.once("error", reject);
    proxy!.listen(PUBLIC_PORT, "127.0.0.1", resolve);
  });
}

async function cleanup() {
  await new Promise<void>((resolve) => proxy?.close(() => resolve()) ?? resolve());
  app?.kill("SIGTERM");
  atlas?.stop();
  if (certificateDir) rmSync(certificateDir, { recursive: true, force: true });
}

export default async function globalSetup() {
  try {
    return await startEverything();
  } catch (error) {
    // A failure mid-setup (build, node check, readiness probe) must not leak the Atlas or
    // app child processes — Playwright never calls a teardown that was never returned.
    await cleanup();
    throw error;
  }
}

async function startEverything() {
  atlas = await startIsolatedAtlas({ ATLAS_OUTBOUND_ALLOWLIST: "127.0.0.1" });
  const token = await login(atlas.origin);
  const seeded = await seedAtlas(atlas.origin, token);
  const artifact = await uploadArtifact(atlas.origin, token, seeded.runId);
  await waitForTerminalJob(atlas.origin, token, seeded.jobId);

  mkdirSync(dirname(SEED_FILE), { recursive: true });

  const appEnv = {
    ...process.env,
    ATLAS_API_ORIGIN: atlas.origin,
    // Deliberate case + trailing slash: production code must compare URL origins, not text.
    PUBLIC_ORIGIN: `${PUBLIC_ORIGIN.toUpperCase()}/`,
    SESSION_SECRET: "phase7-remote-like-session-secret-canary",
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(INTERNAL_APP_PORT),
  };
  const build = spawnSync("bun", ["run", "build"], {
    cwd: process.cwd(),
    env: appEnv,
    encoding: "utf-8",
  });
  if (build.status !== 0) {
    throw new Error(`phase 7 production build failed:\n${build.stdout}\n${build.stderr}`);
  }

  const nodeBinary = process.env.PHASE7_NODE_BINARY ?? "node";
  const nodeVersionResult = spawnSync(nodeBinary, ["--version"], { encoding: "utf-8" });
  // stdout is null (not "") when the binary itself is missing; keep the guidance error.
  const nodeVersion = (nodeVersionResult.stdout ?? "").trim();
  if (nodeVersionResult.status !== 0 || !/^v24\./.test(nodeVersion)) {
    throw new Error(
      `Phase 7 requires Node 24.x, got ${nodeVersion || "an unreadable version"}. ` +
        "Set PHASE7_NODE_BINARY to a Node 24 executable.",
    );
  }
  writeFileSync(
    SEED_FILE,
    JSON.stringify(
      { atlasOrigin: atlas.origin, jobId: seeded.jobId, nodeVersion, ...artifact },
      null,
      2,
    ),
  );

  app = spawn(nodeBinary, [".output/server/index.mjs"], {
    cwd: process.cwd(),
    env: appEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.resume();
  app.stderr?.resume();
  await waitFor(INTERNAL_APP_ORIGIN, app);
  await startProxy();

  return cleanup;
}
