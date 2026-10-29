import { expect, test } from "./test";
import { NOW_MS } from "../src/mock-reporting/fixtures";
import { screenshot } from "./screenshot";

test("shows system usage and plugin details", async ({ page, dashboard }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.route("**/api/conversations/stats", async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    const metricDays = Array.from({ length: 30 }, (_, index) => ({
      date: new Date(NOW_MS - (29 - index) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      conversations: 8,
      durationMs: 120_000,
      inputTokens: 2_000,
      cachedInputTokens: index === 25 ? 8_000 : 180_000,
      cacheCreationTokens: index === 25 ? 190_000 : 10_000 + index * 100,
      tokens: 205_000,
      costUsd: 1.5,
    }));
    const metricHours = Array.from({ length: 24 }, (_, index) => ({
      ...metricDays[index],
      date: new Date(NOW_MS - (23 - index) * 3_600_000)
        .toISOString()
        .slice(0, 13),
      ...(index === 23 ? { cacheCreationTokens: undefined } : {}),
    }));
    await route.fulfill({
      json: { ...report, metricDays, metricHours, metricSixHours: undefined },
    });
  });
  await page.goto(`${dashboard.baseURL}/system`);

  await expect(
    page.getByRole("heading", { name: "System", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Conversation activity")).toBeVisible();
  await expect(page.getByLabel("Conversations per day")).toBeVisible();
  await expect(page.getByText("Input cache")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Model spend", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Plugins" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Percent", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("group", { name: "Reporting period" }),
  ).toHaveCount(1);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot(page, "system-cache-share");
  await page.getByRole("button", { name: "Tokens", exact: true }).click();
  await expect(page.getByLabel("Input cache tokens per day")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Tokens", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot(page, "system-cache-tokens", { view: "desktop" });
  await page.getByRole("button", { name: "24h", exact: true }).click();
  await expect(page.getByLabel("Input cache tokens per hour")).toBeVisible();
  await page.getByText("Largest cache writes", { exact: true }).click();
  const largestWrites = page.getByRole("table", {
    name: "Largest cache writes",
  });
  await expect(largestWrites).not.toContainText("190k");
  await expect(page.getByText(/Missing data in 1 of 24/)).toBeVisible();
  await page.getByText("How to read this", { exact: true }).click();
  await expect(
    page.getByText(/They do not show individual calls/),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot(page, "system-cache-missing", { view: "desktop" });
  await page.getByRole("button", { name: "30d", exact: true }).click();
  await expect(largestWrites).toContainText("190k");
  await expect(page.getByText(/Missing data in 1 of 24/)).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);

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
  await screenshot(page, "system-plugins", { view: "desktop" });

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
  await screenshot(page, "system-plugin-github", { view: "desktop" });
});

test("lists Workspaces with the baseline snapshot", async ({
  page,
  dashboard,
}) => {
  await page.goto(`${dashboard.baseURL}/system/workspaces`);

  await expect(
    page.getByRole("heading", { name: "Workspaces", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Base Sandbox", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("4 vCPUs · 8 GB", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View Workspace details: sentry" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View Workspace details: sentry" }),
  ).toContainText("2 repos · 4 vCPUs · 8 GB");
  await expect(page.getByRole("link", { name: "New Workspace" })).toBeVisible();
  await screenshot(page, "workspaces");
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
          vcpus: 8,
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
    await route.fulfill({
      json: { baselineSnapshot: null, defaultVcpus: 4, workspaces: [] },
    });
  });

  await page.goto(`${dashboard.baseURL}/system/workspaces`);
  await page.getByRole("link", { name: "New Workspace" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/system/workspaces/new`);
  await expect(
    page.getByRole("heading", { name: "New Workspace", exact: true }),
  ).toBeVisible();
  await screenshot(page, "workspace-create");
  await page.getByLabel("Name").fill("sentry");
  await page
    .getByLabel("Repository 1", { exact: true })
    .fill("getsentry/sentry");
  await page.getByLabel("Setup script").fill("pnpm install");
  await page.getByLabel("vCPUs").fill("8");
  await page.getByRole("button", { name: "Create Workspace" }).click();

  await expect(page).toHaveURL(
    `${dashboard.baseURL}/system/workspaces/11111111-1111-4111-8111-111111111111`,
  );
  await expect(
    page
      .getByRole("region", { name: "Workspaces list" })
      .getByText("github:getsentry/sentry"),
  ).toBeVisible();
  expect(createdBody).toEqual({
    name: "sentry",
    repos: [
      {
        provider: "github",
        repo: "getsentry/sentry",
      },
    ],
    setupScript: "pnpm install",
    vcpus: 8,
  });
});

test("opens Workspace details beside the list and edits on a full page", async ({
  page,
  dashboard,
}) => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(`${dashboard.baseURL}/system/workspaces`);

  const row = page.getByRole("button", {
    name: "View Workspace details: sentry",
  });
  await row.click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/system/workspaces/${workspaceId}`,
  );
  await expect(row).toHaveAttribute("aria-expanded", "true");
  const details = page.getByRole("complementary", {
    name: "Workspace details",
  });
  await expect(details.getByText("snap_workspace_123")).toBeVisible();
  await expect(details.getByText(/built in 45s/)).toBeVisible();
  await expect(details.getByText("repos/getsentry")).toBeVisible();
  await expect(details.getByText("pnpm install")).toBeVisible();
  await screenshot(page, "workspace-detail", { view: "desktop" });

  await details.getByRole("link", { name: "Edit sentry" }).click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/system/workspaces/${workspaceId}/edit`,
  );
  await expect(page.getByLabel("Name")).toHaveValue("sentry");
  await expect(
    page.getByLabel("System navigation").getByRole("link", {
      name: "Workspaces",
      exact: true,
    }),
  ).toHaveAttribute("href", "/system/workspaces");

  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(details).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(`${dashboard.baseURL}/system/workspaces`);
  await expect(details).toBeHidden();
  await expect(row).toBeFocused();
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
  // Page tabs stay on the page, so moving between System pages does not need
  // the navigation menu.
  const systemNavigation = page.getByRole("navigation", {
    name: "System navigation",
  });
  await expect(systemNavigation.getByRole("link")).toHaveText([
    "Overview",
    "People",
    "Locations",
    "Workspaces",
    "Plugins",
  ]);
  const pluginsLink = systemNavigation.getByRole("link", { name: "Plugins" });
  await pluginsLink.click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/system/plugins`);
  await expect(
    page.getByRole("heading", { name: "Plugins", exact: true }),
  ).toBeVisible();
  // The current page tab scrolls into view when the row is wider than the screen.
  await expect(pluginsLink).toHaveAttribute("aria-current", "page");
  await expect(pluginsLink).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
