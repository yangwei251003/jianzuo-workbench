import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:8790",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [{ name: "desktop-chrome", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // Keep the actual Node process under Playwright so a pnpm wrapper cannot
    // exit while leaving the test API listening on port 8790.
    command: "node --import tsx scripts/e2e-server.ts",
    url: "http://127.0.0.1:8790/api/health",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
