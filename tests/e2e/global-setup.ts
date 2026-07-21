import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ADMIN_CREDENTIALS,
  startIsolatedAtlas,
  type AtlasInstance,
} from "../contract/atlas-instance";
import { seedAtlas, type SeededAtlas } from "../contract/atlas-seed";

export const APP_PORT = 3111;
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

/**
 * Where the seeded Atlas ids are handed to the test workers.
 *
 * Playwright runs `globalSetup` in its own process, so an environment variable set here would
 * not reach the workers. A file is the boring, reliable channel. `test-results/` is already
 * gitignored, so nothing seeded ends up committed.
 */
export const SEED_FILE = "test-results/e2e-seed.json";

/**
 * The seed, plus the throwaway Atlas's origin and an admin bearer for it.
 *
 * Handing the tests a way to talk to Atlas directly is what lets a single spec build the exact
 * fixture it needs — a graph shape the UI cannot draw, say — without adding rows to the shared
 * seed that every other spec's assertions would then have to account for. The instance is a
 * temp database on an ephemeral port that is destroyed at teardown, and `test-results/` is
 * gitignored, so nothing here outlives the run.
 */
export interface E2ESeed extends SeededAtlas {
  atlasOrigin: string;
  adminToken: string;
  /** Restart handle for the Atlas-restart recovery spec (kill by pid, respawn on same db/port). */
  atlasRestart: {
    pid: number | undefined;
    port: number;
    dbPath: string;
    uploadDir: string;
  };
}

export function readSeed(): E2ESeed {
  return JSON.parse(readFileSync(SEED_FILE, "utf-8")) as E2ESeed;
}

let atlas: AtlasInstance | undefined;
let devServer: ChildProcess | undefined;

async function waitForApp(deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (devServer?.exitCode != null) {
      throw new Error(`dev server exited early with code ${devServer.exitCode}`);
    }
    try {
      const response = await fetch(`${APP_ORIGIN}/auth`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error("dev server did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

export default async function globalSetup() {
  // The allowlist lets a spec create a run whose reply callback targets a dead loopback port,
  // which is the only way a delivery row can exist for the deliveries page to show. Atlas
  // fail-closes non-allowlisted callback URLs at run start, so without this no delivery is
  // producible at all.
  atlas = await startIsolatedAtlas({ ATLAS_OUTBOUND_ALLOWLIST: "127.0.0.1" });

  /**
   * Seed through Atlas's own API with an admin bearer.
   *
   * The browser tests then read whatever Atlas actually stores. Stubbing a network response in
   * the page instead would prove only that the UI can render a fixture — not that the
   * production read path from the browser through the RPC boundary to Atlas works.
   */
  const login = await fetch(`${atlas.origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  if (!login.ok) throw new Error(`e2e seed login failed: ${login.status}`);
  const { token } = (await login.json()) as { token: string };

  const seeded = await seedAtlas(atlas.origin, token);
  mkdirSync(dirname(SEED_FILE), { recursive: true });
  writeFileSync(
    SEED_FILE,
    JSON.stringify(
      { ...seeded, atlasOrigin: atlas.origin, adminToken: token, atlasRestart: atlas.restart },
      null,
      2,
    ),
  );

  devServer = spawn(
    "./node_modules/.bin/vite",
    // `--strictPort` so a busy 3111 fails loudly. Without it Vite silently picks another
    // port, and every test would then drive whatever else is listening on 3111.
    ["dev", "--port", String(APP_PORT), "--host", "127.0.0.1", "--strictPort"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // The dev server talks to the throwaway Atlas, never a real one.
        ATLAS_API_ORIGIN: atlas.origin,
        PUBLIC_ORIGIN: APP_ORIGIN,
        SESSION_SECRET: "e2e-session-secret-not-a-real-secret-value",
        NODE_ENV: "development",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  devServer.stdout?.resume();
  devServer.stderr?.resume();

  await waitForApp();

  // Playwright treats a returned function as the global teardown.
  return async () => {
    devServer?.kill("SIGTERM");
    atlas?.stop();
  };
}
