import { test as base } from "@playwright/test";
import {
  mockDashboardApis,
  resetDashboardMockState,
  startDashboardE2eServer,
  type DashboardE2eServer,
} from "./harness";

type DashboardFixtures = {
  /** When true, install controllable timers for tests that fast-forward time. */
  controlTimers: boolean;
};

type DashboardWorkerFixtures = {
  /** Built dashboard server shared by every test in the worker. */
  dashboard: DashboardE2eServer;
};

/**
 * Shared dashboard browser fixtures.
 * Every test gets the fixed current time and common API stubs.
 */
export const test = base.extend<DashboardFixtures, DashboardWorkerFixtures>({
  controlTimers: [false, { option: true }],
  dashboard: [
    async ({}, use) => {
      const server = await startDashboardE2eServer({ componentGallery: true });
      await use(server);
      await server.close();
    },
    { scope: "worker" },
  ],
  page: async ({ page, controlTimers }, use) => {
    // The dashboard server is shared per worker; reset its mutable mock
    // state before every test so archive/restore and profile-update tests
    // cannot leak into unrelated specs.
    await resetDashboardMockState();
    await mockDashboardApis(page, { controlTimers });
    await use(page);
  },
});

export { expect } from "@playwright/test";
