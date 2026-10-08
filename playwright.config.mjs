import { defineConfig, devices } from "@playwright/test";

// Browser tests live in test/e2e. They start their own servers on random
// loopback ports and stop them when done.
export default defineConfig({
  testDir: "test/e2e",
  testMatch: /.*\.spec\.mjs$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { headless: true, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
