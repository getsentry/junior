import { expect, test } from "@playwright/test";
import {
  collectBrowserErrors,
  type DashboardE2eServer,
  mockDashboardApis,
  startDashboardE2eServer,
} from "./harness";

let server: DashboardE2eServer;

test.beforeAll(async () => {
  server = await startDashboardE2eServer();
});

test.afterAll(async () => {
  await server.close();
});

test.beforeEach(async ({ page }) => {
  await mockDashboardApis(page);
});

test("shows system usage and plugin details", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  const browserErrors = collectBrowserErrors(page);
  await page.goto(`${server.baseURL}/system`);

  await expect(page.getByText("Usage over time")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Plugins", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Model spend")).toBeVisible();

  const headerBounds = await page
    .locator("main > header > div")
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, width: bounds.width };
    });
  expect(headerBounds).toEqual({ left: 160, width: 1280 });

  await page
    .getByLabel("System navigation")
    .getByRole("link", { name: "GitHub", exact: true })
    .click();
  await expect(page).toHaveURL(`${server.baseURL}/system/plugins/github`);
  await expect(
    page.getByRole("heading", { name: "GitHub", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("This plugin does not expose operational activity yet."),
  ).toBeVisible();
  await expect(page.getByText("github.organization")).toBeVisible();

  await page.goto(`${server.baseURL}/system/plugins/github/`);
  await expect(page).toHaveURL(`${server.baseURL}/system/plugins/github/`);
  await expect(
    page.getByRole("heading", { name: "GitHub", exact: true }),
  ).toBeVisible();

  const containerBounds = await page
    .locator("main > div")
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, width: bounds.width };
    });
  expect(containerBounds).toEqual(headerBounds);
  expect(browserErrors).toEqual([]);
});

test("navigates plugin information and activity on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.route("**/api/plugin-reports", async (route) => {
    await route.fulfill({
      json: {
        generatedAt: "2026-06-12T00:00:00.000Z",
        reports: [
          {
            metrics: [
              { label: "Active tasks", value: "4" },
              { label: "Runs today", value: "12" },
            ],
            pluginName: "scheduler",
            recordSets: [
              {
                fields: [
                  { key: "task", label: "Task" },
                  { key: "next", label: "Next run" },
                  { key: "owner", label: "Owner" },
                  { key: "status", label: "Status" },
                ],
                records: [
                  {
                    id: "daily-triage",
                    values: {
                      next: "Tomorrow, 9:00 AM",
                      owner: "Junior",
                      status: "Ready",
                      task: "Daily issue triage",
                    },
                  },
                ],
                title: "Upcoming",
              },
            ],
            title: "Scheduler",
          },
        ],
        source: "plugins",
      },
    });
  });

  await page.goto(`${server.baseURL}/system`);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page
    .getByLabel("System view")
    .selectOption("/system/plugins/scheduler");

  await expect(page).toHaveURL(`${server.baseURL}/system/plugins/scheduler`);
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 2, name: "Scheduler", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Runs today")).toBeVisible();
  await expect(page.getByText("12", { exact: true })).toBeVisible();
  await expect(page.getByText("Daily issue triage").first()).toBeVisible();
  await expect(page.getByText("Tomorrow, 9:00 AM").first()).toBeVisible();
  await expect(page.getByText("Ready", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Reporting period")).toHaveCount(0);
});
