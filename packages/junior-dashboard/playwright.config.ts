import { readdirSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";
import type { DashboardShell } from "./src/public-assets";

const chrome = {
  ...devices["Desktop Chrome"],
  // Blacksmith's Ubuntu runner includes Chrome. Use it in GitHub Actions so
  // the e2e job does not depend on apt package mirrors during Playwright
  // setup. Not on `CI`: other machines, such as Junior's sandbox, set it too.
  ...(process.env["GITHUB_ACTIONS"] ? { channel: "chrome" } : undefined),
};

// A spec under e2e/inbox/ tests the new UI, so its namesake in e2e/ is
// for the current UI only. The review desk exists only in the current UI.
const currentUiSpecs = [
  ...readdirSync(new URL("./e2e/inbox", import.meta.url)).filter((name) =>
    name.endsWith(".spec.ts"),
  ),
  "review-desk.spec.ts",
].map((name) => `**/e2e/${name}`);

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
  // One project for each UI shell. A test for one shell has the `@classic`
  // or `@new` tag, or is in a spec for one shell. Other specs run on both.
  projects: [
    {
      grepInvert: /@new\b/,
      name: "classic",
      use: { ...chrome, ui: "classic" },
    },
    {
      grepInvert: /@classic\b/,
      name: "inbox",
      testIgnore: currentUiSpecs,
      use: { ...chrome, ui: "inbox" },
    },
  ],
});
