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
  // On CI a failing test keeps its trace and screenshot (uploaded by the
  // workflow), so a failure that only shows up there can be looked at.
  use: process.env.CI
    ? { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure", video: "off" }
    : { headless: true, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
