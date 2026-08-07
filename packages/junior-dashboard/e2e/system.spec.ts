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

  await expect(page.getByText("Conversation activity")).toBeVisible();
  await expect(page.getByLabel("Conversations per day")).toBeVisible();
  await expect(page.getByText("Model spend")).toBeVisible();
  await expect(page.getByRole("region", { name: "Plugins" })).toHaveCount(0);

  const systemNavigation = page.getByLabel("System navigation");
  await expect(systemNavigation.getByRole("link")).toHaveText([
    "Overview",
    "People",
    "Locations",
    "Plugins",
  ]);
  const pluginsLink = systemNavigation.getByRole("link", {
    name: "Plugins",
    exact: true,
  });
  await pluginsLink.click();
  await expect(page).toHaveURL(`${server.baseURL}/system/plugins`);
  await expect(
    page.getByRole("heading", { name: "Plugins", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Reporting period")).toHaveCount(0);

  const pluginPanels = page.getByRole("region", { name: "Plugins" });
  const githubPanel = pluginPanels.getByRole("link", {
    name: /GitHub/,
  });

  await githubPanel.click();
  await expect(page).toHaveURL(`${server.baseURL}/system/plugins/github`);
  await expect(
    page.getByRole("heading", { name: "GitHub", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("This plugin does not expose operational activity yet."),
  ).toBeVisible();
  await expect(page.getByText("github.organization")).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("keeps System navigation usable on mobile", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${server.baseURL}/system`);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const systemNavigation = page.getByLabel("System navigation");
  await expect(systemNavigation.getByRole("link")).toHaveText([
    "Overview",
    "People",
    "Locations",
    "Plugins",
  ]);
  await systemNavigation.getByRole("link", { name: "Plugins" }).click();
  await expect(page).toHaveURL(`${server.baseURL}/system/plugins`);
  await expect(
    page.getByRole("heading", { name: "Plugins", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
