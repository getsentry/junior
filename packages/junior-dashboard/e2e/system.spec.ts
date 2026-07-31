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
  await expect(page.getByText("Model spend")).toBeVisible();
  await expect(page.getByRole("region", { name: "Plugins" })).toHaveCount(0);

  const headerBounds = await page
    .locator("main > header > div")
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, width: bounds.width };
    });
  expect(headerBounds).toEqual({ left: 160, width: 1280 });

  const systemNavigation = page.getByLabel("System navigation");
  const allPluginsLink = systemNavigation.getByRole("link", {
    name: "All Plugins",
    exact: true,
  });
  await expect(allPluginsLink).toBeVisible();
  await expect(
    systemNavigation.getByRole("link", { name: "GitHub", exact: true }),
  ).toHaveCount(0);
  await expect(
    systemNavigation.getByRole("link", { name: "Scheduler", exact: true }),
  ).toHaveCount(0);

  await allPluginsLink.click();
  await expect(page).toHaveURL(`${server.baseURL}/system/plugins`);
  await expect(page.getByLabel("Reporting period")).toHaveCount(0);

  const pluginPanels = page.getByRole("region", { name: "Plugins" });
  const githubPanel = pluginPanels.getByRole("link", {
    name: /GitHub/,
  });
  const schedulerPanel = pluginPanels.getByRole("link", {
    name: /Scheduler/,
  });
  const [githubBounds, schedulerBounds] = await Promise.all([
    githubPanel.boundingBox(),
    schedulerPanel.boundingBox(),
  ]);
  expect(githubBounds?.x).toBe(schedulerBounds?.x);
  expect(schedulerBounds?.y).toBeGreaterThan(
    (githubBounds?.y ?? 0) + (githubBounds?.height ?? 0),
  );

  await githubPanel.click();
  await expect(page).toHaveURL(`${server.baseURL}/system/plugins/github`);
  await expect(
    page.getByRole("heading", { name: "GitHub", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("This plugin does not expose operational activity yet."),
  ).toBeVisible();
  await expect(page.getByText("github.organization")).toBeVisible();
  expect(
    await page
      .getByRole("heading", { level: 2, name: "System", exact: true })
      .evaluate((element) => element.getBoundingClientRect().top),
  ).toBeLessThan(180);

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
  await expect(page.getByLabel("System view").locator("option")).toHaveText([
    "Overview",
    "All Plugins",
    "Scheduler",
  ]);
  await page.getByLabel("System view").selectOption("/system/plugins");
  await expect(page).toHaveURL(`${server.baseURL}/system/plugins`);
  await expect(
    page.getByLabel("System view").locator("option:checked"),
  ).toHaveText("All Plugins");
  await page
    .getByRole("region", { name: "Plugins" })
    .getByRole("link", { name: /GitHub/ })
    .click();
  await expect(page.getByLabel("System view")).toHaveValue(
    "/system/plugins/github",
  );
  await expect(
    page.getByLabel("System view").locator("option:checked"),
  ).toHaveText("GitHub");
  await expect(
    page
      .getByLabel("System view")
      .locator('option[value="/system/plugins/github"]'),
  ).toHaveAttribute("disabled", "");
  await page.getByLabel("System view").selectOption("/system");
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
