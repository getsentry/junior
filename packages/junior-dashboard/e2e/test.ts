import { expect, test as base } from "@playwright/test";
import {
  mockDashboardApis,
  resetDashboardMockState,
  startDashboardE2eServer,
  trackOpenRequests,
  type DashboardE2eServer,
} from "./harness";
import type { DashboardShell } from "../src/public-assets";

/** Options that a Playwright project or a spec can set. */
export type DashboardOptions = {
  /** When true, install controllable timers for tests that fast-forward time. */
  controlTimers: boolean;
  /** UI shell the viewer sees. */
  ui: DashboardShell;
};

type DashboardWorkerFixtures = {
  /** Built dashboard server shared by every test in the worker. */
  dashboard: DashboardE2eServer;
};

/**
 * Shared dashboard browser fixtures.
 * Every test gets the fixed current time and common API stubs.
 */
export const test = base.extend<DashboardOptions, DashboardWorkerFixtures>({
  controlTimers: [false, { option: true }],
  ui: ["classic", { option: true }],
  dashboard: [
    async ({}, use) => {
      const server = await startDashboardE2eServer();
      await use(server);
      await server.close();
    },
    // The server takes 4 to 6 seconds to boot. With the default, that time
    // counts against the first test of each worker and against every retry,
    // because a retry starts a new worker. Give the boot its own limit.
    { scope: "worker", timeout: 60_000 },
  ],
  page: async ({ page, controlTimers, dashboard, ui }, use, testInfo) => {
    // The dashboard server is shared per worker; reset its mutable mock
    // state before every test so archive/restore and profile-update tests
    // cannot leak into unrelated specs.
    await resetDashboardMockState();
    await mockDashboardApis(page, { controlTimers });
    const requests = trackOpenRequests(page);
    // The page shell reads the viewer's setting on the server, so a page
    // route cannot choose the shell.
    if (ui === "inbox") {
      const response = await page.request.patch(`${dashboard.baseURL}/api/me`, {
        data: { experimentalUi: true },
      });
      expect(response.ok()).toBe(true);
    }
    await use(page);
    try {
      // A test that already failed can stop with any request open.
      if (testInfo.status === testInfo.expectedStatus) {
        await requests.expectNoneOpen();
      }
    } finally {
      // The check lets a background read stay open, so one can still be in
      // a route handler here. Closing the page then disposes its response,
      // and the handler throws. Handler errors during the test still fail
      // it.
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  },
});

export { expect };
