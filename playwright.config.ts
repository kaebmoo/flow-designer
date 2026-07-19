import { defineConfig, devices } from "@playwright/test";

/**
 * Browser acceptance tests.
 *
 * `globalSetup` boots an isolated Atlas (temp database, ephemeral port) and writes its origin
 * plus a throwaway `SESSION_SECRET` into the environment that the dev server below inherits.
 * Nothing here touches a developer's running Atlas or its data.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:3111",
    trace: "off",
    // Never record a video/screenshot by default: a login form would capture a password.
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // No `webServer` block on purpose: Playwright starts it *before* `globalSetup`, so it could
  // not inherit the Atlas origin that setup allocates. `globalSetup` launches the dev server
  // itself, after Atlas, and tears both down.
});
