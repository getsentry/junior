import { expect, test } from "./test";
import { NOW_MS } from "../src/mock-reporting/fixtures";

test("shows system usage and plugin details", async ({ page, dashboard }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(`${dashboard.baseURL}/system`);

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
  await expect(page).toHaveURL(`${dashboard.baseURL}/system/plugins`);
  await expect(
    page.getByRole("heading", { name: "Plugins", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Reporting period")).toHaveCount(0);

  const pluginPanels = page.getByRole("region", { name: "Plugins" });
  const githubPanel = pluginPanels.getByRole("link", {
    name: /GitHub/,
  });

  await githubPanel.click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/system/plugins/github`);
  await expect(
    page.getByRole("heading", { name: "GitHub", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("This plugin does not expose operational activity yet."),
  ).toBeVisible();
  await expect(page.getByText("github.organization")).toBeVisible();
});

test("creates a Workspace recipe", async ({ page, dashboard }) => {
  let createdBody: unknown;
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() === "POST") {
      createdBody = route.request().postDataJSON();
      await route.fulfill({
        json: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "sentry",
          setupScript: "pnpm install",
          snapshot: null,
          repos: [
            {
              checkoutPath: "repos/sentry",
              provider: "github",
              repo: "getsentry/sentry",
            },
          ],
        },
        status: 201,
      });
      return;
    }
    await route.fulfill({ json: { baselineSnapshot: null, workspaces: [] } });
  });

  await page.goto(`${dashboard.baseURL}/system/workspaces`);
  await page.getByRole("link", { name: "New Workspace" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/system/workspaces/new`);
  await page.getByLabel("Name").fill("sentry");
  await page
    .getByLabel("Repository 1", { exact: true })
    .fill("getsentry/sentry");
  await page.getByLabel("Setup script").fill("pnpm install");
  await page.getByRole("button", { name: "Create Workspace" }).click();

  await expect(page).toHaveURL(`${dashboard.baseURL}/system/workspaces`);
  await expect(page.getByText("github:getsentry/sentry")).toBeVisible();
  expect(createdBody).toEqual({
    name: "sentry",
    repos: [
      {
        provider: "github",
        repo: "getsentry/sentry",
      },
    ],
    setupScript: "pnpm install",
  });
});

test("shows Workspace snapshot details on its direct route", async ({
  page,
  dashboard,
}) => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  await page.route(`**/api/workspaces/${workspaceId}`, async (route) => {
    await route.fulfill({
      json: {
        id: workspaceId,
        name: "sentry",
        setupScript: "pnpm install",
        snapshot: {
          id: "snap_workspace_123",
          generatedAt: new Date(NOW_MS - 60_000).toISOString(),
          buildDurationMs: 45_000,
          sizeBytes: 4_194_304,
        },
        repos: [
          {
            checkoutPath: "repos/sentry",
            provider: "github",
            repo: "getsentry/sentry",
          },
        ],
      },
    });
  });

  await page.goto(`${dashboard.baseURL}/system/workspaces/${workspaceId}`);

  await expect(
    page.getByRole("heading", { name: "Current snapshot" }),
  ).toBeVisible();
  await expect(page.getByText("snap_workspace_123")).toBeVisible();
  await expect(page.getByText("45s")).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("sentry");
  await expect(
    page.getByLabel("System navigation").getByRole("link", {
      name: "Workspaces",
      exact: true,
    }),
  ).toHaveAttribute("href", "/system/workspaces");
});

test("keeps System navigation usable on mobile", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${dashboard.baseURL}/system`);
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
  await expect(page).toHaveURL(`${dashboard.baseURL}/system/plugins`);
  await expect(
    page.getByRole("heading", { name: "Plugins", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
