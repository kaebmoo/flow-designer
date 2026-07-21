import { defineConfig, devices } from "@playwright/test";

/**
 * Phase 7 remote-like deployment acceptance.
 *
 * The browser reaches an HTTPS public origin through a reverse proxy. The built Node server
 * listens on a different internal HTTP origin and Atlas on a third private origin, which
 * exercises the proxy/public-origin assumptions that the ordinary localhost suite does not.
 */
export default defineConfig({
  testDir: "./tests/phase7",
  globalSetup: "./tests/phase7/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "https://localhost:3443",
    ignoreHTTPSErrors: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium-remote-like", use: { ...devices["Desktop Chrome"] } }],
});
