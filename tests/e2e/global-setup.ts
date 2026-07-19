import { spawn, type ChildProcess } from "node:child_process";

import { startIsolatedAtlas, type AtlasInstance } from "../contract/atlas-instance";

export const APP_PORT = 3111;
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

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
  atlas = await startIsolatedAtlas();

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
