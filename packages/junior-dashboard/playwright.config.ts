import { defineConfig, devices } from "@playwright/test";
import type { DashboardShell } from "./src/public-assets";

const chrome = {
  ...devices["Desktop Chrome"],
  // Blacksmith's Ubuntu runner includes Chrome. Use it in CI so the e2e
  // job does not depend on apt package mirrors during Playwright setup.
  ...(process.env["CI"] ? { channel: "chrome" } : undefined),
};

export default defineConfig<{ ui: DashboardShell }>({
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
    // Dark is the default dashboard theme. Light theme journeys opt in.
    colorScheme: "dark",
    launchOptions: {
      // Partial raster repaints only the changed part of a tile, so pixels
      // depend on paint history. Full tile raster keeps screenshots stable.
      args: ["--disable-partial-raster"],
    },
    trace: "retain-on-failure",
  },
  // One project for each UI shell. A spec for one shell has the `@classic`
  // or `@new` tag. Until the new shell renders the shared pages, untagged
  // specs run only on the current UI.
  projects: [
    {
      grepInvert: /@new\b/,
      name: "classic",
      use: { ...chrome, ui: "classic" },
    },
    {
      grep: /@new\b/,
      name: "inbox",
      use: { ...chrome, ui: "inbox" },
    },
  ],
});
