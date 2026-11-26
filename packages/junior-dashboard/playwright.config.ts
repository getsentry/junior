import { defineConfig, devices } from "@playwright/test";

const chrome = {
  ...devices["Desktop Chrome"],
  // Blacksmith's Ubuntu runner includes Chrome. Use it in GitHub Actions so
  // the e2e job does not depend on apt package mirrors during Playwright
  // setup. Not on `CI`: other machines, such as Junior's sandbox, set it too.
  ...(process.env["GITHUB_ACTIONS"] ? { channel: "chrome" } : undefined),
};

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../.playwright/junior-dashboard",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  // A broken build fails every journey. Stop early instead of waiting for
  // each timeout and retry until the CI job limit.
  ...(process.env["CI"] ? { maxFailures: 10 } : undefined),
  reporter: process.env["CI"] ? [["github"], ["list"]] : "list",
  use: {
    ...chrome,
    // Dark is the default dashboard theme. Light theme journeys opt in.
    colorScheme: "dark",
    // Reduced motion stops the dashboard's transitions, animations, and
    // smooth scrolls, so journeys act on UI that has stopped moving. Specs
    // do not test motion; visual QA covers it.
    contextOptions: { reducedMotion: "reduce" },
    launchOptions: {
      // Partial raster repaints only the changed part of a tile, so pixels
      // depend on paint history. Full tile raster keeps screenshots stable.
      args: ["--disable-partial-raster"],
    },
    trace: "retain-on-failure",
  },
});
