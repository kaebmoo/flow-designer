import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Standalone from `vite.config.ts` on purpose: the app config loads the TanStack Start
 * plugin, which rewrites `createServerFn` bodies into network calls. Unit tests need the
 * real server-side modules, so they run against plain TypeScript with only the `@` alias.
 *
 * Projects map one-to-one onto the `test`, `test:contract`, and `test:stream` scripts.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        resolve: {
          alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
        },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        resolve: {
          alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
        },
        test: {
          name: "contract",
          environment: "node",
          include: ["tests/contract/**/*.test.ts"],
          // A real Atlas has to boot and seed a temporary database first.
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        resolve: {
          alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
        },
        test: {
          name: "stream",
          environment: "node",
          // Phase 4's SSE adapter and transport tests: synthetic frames plus a fake clock.
          include: ["tests/stream/**/*.test.ts"],
        },
      },
    ],
  },
});
