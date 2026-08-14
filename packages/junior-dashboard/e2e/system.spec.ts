import { expect, test } from "@playwright/test";
import {
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
  await page.goto(`${server.baseURL}/system`);

  await expect(page.getByText("Conversation activity")).toBeVisible();
  await expect(page.getByLabel("Conversations per day")).toBeVisible();
  await expect(page.getByText("Cache hit rate")).toBeVisible();
  await expect(page.getByText("Input token cache")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Model spend", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Plugins" })).toHaveCount(0);

  const systemNavigation = page.getByLabel("System navigation");
  await expect(systemNavigation.getByRole("link")).toHaveText([
    "Overview",
    "People",
    "Locations",
    "Workspaces",
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
});

test("creates a Workspace recipe", async ({ page }) => {
  let createdBody: unknown;
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() === "POST") {
      createdBody = route.request().postDataJSON();
      await route.fulfill({
        json: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "sentry",
          setupScript: "pnpm install",
          repos: [
            {
              checkoutPath: "repos/sentry",
              isPrimary: true,
              provider: "github",
              repo: "getsentry/sentry",
            },
          ],
        },
        status: 201,
      });
      return;
    }
    await route.fulfill({ json: { workspaces: [] } });
  });

  await page.goto(`${server.baseURL}/system/workspaces`);
  await page.getByRole("button", { name: "New Workspace" }).click();
  await page.getByLabel("Name").fill("sentry");
  await page
    .getByLabel("Repository 1", { exact: true })
    .fill("getsentry/sentry");
  await page.getByLabel("Setup script").fill("pnpm install");
  await page.getByRole("button", { name: "Create Workspace" }).click();

  await expect(page.getByText("github:getsentry/sentry")).toBeVisible();
  expect(createdBody).toEqual({
    name: "sentry",
    repos: [
      {
        isPrimary: true,
        provider: "github",
        repo: "getsentry/sentry",
      },
    ],
    setupScript: "pnpm install",
  });
});

test("keeps System navigation usable on mobile", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${server.baseURL}/system`);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect(page.getByLabel("System navigation")).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  const systemNavigation = page.getByLabel("System navigation");
  await expect(systemNavigation.getByRole("link")).toHaveText([
    "Overview",
    "People",
    "Locations",
    "Workspaces",
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
