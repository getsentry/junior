import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../.playwright/junior-dashboard",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Blacksmith's Ubuntu runner includes Chrome. Use it in CI so the e2e
        // job does not depend on apt package mirrors during Playwright setup.
        ...(process.env.CI ? { channel: "chrome" } : undefined),
      },
    },
  ],
});
