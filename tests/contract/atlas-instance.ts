/**
 * Boots a throwaway Atlas for contract tests.
 *
 * Isolation is the whole point: a fresh SQLite file in a temp directory, an ephemeral port,
 * and its own secret key. It never touches a developer's running Atlas, its data directory,
 * or anything in the Atlas checkout — the repository is only ever read from.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ATLAS_REPO =
  process.env.ATLAS_REPO_PATH ?? "/Users/seal/Documents/GitHub/atlas-control-plane";

export const ADMIN_CREDENTIALS = { username: "admin", password: "contract-admin-password" };
export const VIEWER_CREDENTIALS = { username: "viewer", password: "contract-viewer-password" };
/**
 * The third role, and the only one that can express Atlas's permission *asymmetry*.
 *
 * `ROLE_PERMISSIONS` (`atlas/app.py:70-73`) gives operator everything an admin has except
 * `admin` itself, and `_required_permission` (`atlas/app.py:1207-1211`) demands `admin` for
 * every non-poll write under `/api/workers` while `/api/workspaces` falls through to
 * `resources.manage`. Admin-versus-viewer can never show that split: an operator may create
 * and delete workspaces yet is 403 on any worker mutation.
 */
export const OPERATOR_CREDENTIALS = {
  username: "operator",
  password: "contract-operator-password",
};

/**
 * True when a real Atlas can be started here.
 *
 * A missing checkout at the *default* path is a legitimate skip (a machine without Atlas).
 * An explicitly configured `ATLAS_REPO_PATH` that does not exist is a misconfiguration, and
 * throwing beats skipping: contract tests that silently vanish would report green while
 * proving nothing about the real server.
 */
export function atlasAvailable(): boolean {
  const present = existsSync(join(ATLAS_REPO, "atlas", "__main__.py"));
  if (!present && process.env.ATLAS_REPO_PATH) {
    throw new Error(
      `ATLAS_REPO_PATH is set to ${process.env.ATLAS_REPO_PATH} but no Atlas checkout was found there.`,
    );
  }
  if (!present) {
    console.warn(
      `\n[contract] SKIPPING real-Atlas contract tests: no Atlas checkout at ${ATLAS_REPO}.\n` +
        `[contract] These are the only tests that verify the real Atlas wire contract.\n` +
        `[contract] Set ATLAS_REPO_PATH to run them.\n`,
    );
  }
  return present;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("could not resolve an ephemeral port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export interface AtlasInstance {
  origin: string;
  stop: () => void;
  /** Everything Atlas wrote to stdout/stderr, for diagnosing a failing contract test. */
  logs: () => string;
}

export async function startIsolatedAtlas(): Promise<AtlasInstance> {
  const dataDir = mkdtempSync(join(tmpdir(), "flow-designer-atlas-"));
  const dbPath = join(dataDir, "atlas.sqlite");
  const port = await freePort();

  const env = {
    ...process.env,
    ATLAS_DB: dbPath,
    ATLAS_SECRET_KEY: "contract-test-secret-key",
    ATLAS_UPLOAD_DIR: join(dataDir, "uploads"),
    // Bypasses must stay off, or every request would authenticate as admin and the 401/403
    // assertions would silently pass for the wrong reason.
    ATLAS_LOOPBACK_NO_AUTH: "",
    ATLAS_API_TOKEN: "",
  };

  const seed = (args: string[], password: string) => {
    const result = spawnSync("python3", ["-m", "atlas.admin", ...args], {
      cwd: ATLAS_REPO,
      env,
      input: `${password}\n`,
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      throw new Error(`atlas.admin ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
  };

  // Seeding runs external processes that can fail; without this the temp directory would be
  // left behind on every failed run.
  try {
    seed(["create-admin", ADMIN_CREDENTIALS.username], ADMIN_CREDENTIALS.password);
    seed(
      ["create-user", VIEWER_CREDENTIALS.username, "--role", "viewer"],
      VIEWER_CREDENTIALS.password,
    );
    seed(
      ["create-user", OPERATOR_CREDENTIALS.username, "--role", "operator"],
      OPERATOR_CREDENTIALS.password,
    );
  } catch (error) {
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  const child: ChildProcess = spawn(
    "python3",
    ["-m", "atlas", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: ATLAS_REPO, env, stdio: ["ignore", "pipe", "pipe"] },
  );

  // Buffered so a failing contract test can show what Atlas itself reported.
  const logs: string[] = [];
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  const origin = `http://127.0.0.1:${port}`;
  const stop = () => {
    child.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
  };

  // Ready when it answers at all; 401 from an unauthenticated /api/me is the expected reply.
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      stop();
      throw new Error(`Atlas exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${origin}/api/me`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 401) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      stop();
      throw new Error("Atlas did not become ready within 30s");
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return { origin, stop, logs: () => logs.join("") };
}
