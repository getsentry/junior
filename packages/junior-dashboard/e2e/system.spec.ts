import { expect, test } from "./test";
import { NOW_MS } from "../src/mock-reporting/fixtures";
import { expectRequestBudget } from "./request-budget";
import { screenshot } from "./screenshot";

/** Vary merges so the running cost line moves. */
function unitCostDay(index: number) {
  const merged = index % 5 === 3 ? 1 : 0;
  return {
    mergedCodeChangeCostUsd: merged * (3 + (index % 7) * 0.5),
    mergedCodeChanges: merged,
  };
}

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
      ...unitCostDay(index),
    }));
    const metricHours = Array.from({ length: 24 }, (_, index) => ({
      ...metricDays[index],
      date: new Date(NOW_MS - (23 - index) * 3_600_000)
        .toISOString()
        .slice(0, 13),
      ...(index === 23 ? { cacheCreationTokens: undefined } : undefined),
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
  await expect(page.getByText(/6 merged changes\. The line is/)).toBeVisible();
  await expect(
    page.getByLabel("7-day rolling cost per merged change per day"),
  ).toBeVisible();
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
  await expect(
    page.getByLabel("6-hour rolling cost per merged change per hour"),
  ).toBeVisible();
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

test("loads the System overview within its request budget", async ({
  page,
  dashboard,
}) => {
  await expectRequestBudget(
    page,
    async () => {
      await page.goto(`${dashboard.baseURL}/system`);
      await expect(page.getByText("Conversation activity")).toBeVisible();
      await expect(
        page.getByText("Net savings", { exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("region", { name: "Cache health" })
          .getByText("Warmups sent after", { exact: true }),
      ).toBeVisible();
    },
    { requests: 8, serialRounds: 2 },
  );
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
  // The new Workspace's page reads it and its usage.
  const pageReads = Promise.all(
    ["/api/workspaces/11111111-1111-4111-8111-111111111111", "/api/stats"].map(
      (path) =>
        page.waitForResponse(
          (response) => new URL(response.url()).pathname === path,
        ),
    ),
  );
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
  await pageReads;
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

test("shows what cache warming saved in the range", async ({
  page,
  dashboard,
}) => {
  await page.goto(`${dashboard.baseURL}/system`);
  const panel = page.getByRole("region", { name: "Cache warming" });
  await expect(panel.getByText("Net savings", { exact: true })).toBeVisible();
  await expect(panel.getByText("Effectiveness", { exact: true })).toBeVisible();
  await expect(
    panel.getByText(/of possible savings on live days had no warm state/),
  ).toBeVisible();
  await expect(panel.getByText(/Includes 4 days from history/)).toBeVisible();
  await expect(
    panel.getByLabel("Cache warming net savings and effectiveness per day"),
  ).toBeVisible();
  await expect(
    panel
      .getByLabel("Cache warming chart legend")
      .getByText("Daily effectiveness", { exact: true }),
  ).toBeVisible();
  // Only admins can re-fill history.
  await expect(
    panel.getByRole("button", { name: "Re-fill history" }),
  ).toHaveCount(0);
  await screenshot(page, "system-cache-warming", { target: panel });

  const week = page.waitForResponse("**/api/cache-warming/savings?days=7");
  await page.getByRole("button", { name: "7d", exact: true }).click();
  expect((await week).ok()).toBe(true);
  await expect(panel.getByText("Net savings", { exact: true })).toBeVisible();
});

test("shows cache health and warmup outcomes from Sentry", async ({
  page,
  dashboard,
}) => {
  const day = page.waitForResponse("**/api/cache-warming/health?window=7d");
  await page.goto(`${dashboard.baseURL}/system`);
  expect((await day).ok()).toBe(true);
  const health = page.getByRole("region", { name: "Cache health" });
  await expect(
    health.getByText(/^Write share, [\d.]+% last week$/),
  ).toBeVisible();
  await expect(
    health.getByText(/^Full rewrites, [\d.]+k? of [\d.]+k? calls$/),
  ).toBeVisible();
  // The default 30d range shows the last 7 days.
  await expect(health.getByText(/Shows the last 7 days/)).toBeVisible();
  await expect(health.getByText("anthropic warming on")).toBeVisible();
  await expect(
    health.getByText("Warming stopped early", { exact: true }),
  ).toBeVisible();
  await expect(
    health.getByText("Unlikely return", { exact: true }),
  ).toBeVisible();
  await expect(
    health.getByLabel(
      "Prompt cache write share and full-rewrite rate over time",
    ),
  ).toBeVisible();

  const hourly = page.waitForResponse("**/api/cache-warming/health?window=24h");
  await page.getByRole("button", { name: "24h", exact: true }).click();
  expect((await hourly).ok()).toBe(true);
  await expect(health.getByText(/Shows the last 7 days/)).toHaveCount(0);
  await screenshot(page, "system-cache-health-24h", { target: health });
});

test("shows when cache health is not set up, loading, or old", async ({
  page,
  dashboard,
}) => {
  await page.route("**/api/cache-warming/health?*", (route) =>
    route.fulfill({
      json: { status: "unconfigured", missing: ["SENTRY_READ_TOKEN"] },
    }),
  );
  await page.goto(`${dashboard.baseURL}/system`);
  const health = page.getByRole("region", { name: "Cache health" });
  await expect(
    health.getByText(/^Set SENTRY_READ_TOKEN to read cache health from Sentry/),
  ).toBeVisible();
  await screenshot(page, "system-cache-health-setup", {
    target: health,
    view: "desktop",
  });

  // Another load is still reading Sentry, and nothing is stored yet.
  await page.unroute("**/api/cache-warming/health?*");
  await page.route("**/api/cache-warming/health?*", (route) =>
    route.fulfill({ json: { status: "busy" } }),
  );
  await page.reload();
  await expect(
    health.getByText(/^Cache health is still loading from Sentry/),
  ).toBeVisible();
  await screenshot(page, "system-cache-health-busy", {
    target: health,
    view: "desktop",
  });

  // An older answer says when it is from.
  await page.unroute("**/api/cache-warming/health?*");
  await page.route("**/api/cache-warming/health?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), stale: true } });
  });
  await page.reload();
  await expect(health.getByText(/This is from /)).toBeVisible();
  await screenshot(page, "system-cache-health-stale", {
    target: health,
    view: "desktop",
  });
});

test("lets an admin re-fill cache warming savings from history", async ({
  page,
  dashboard,
}) => {
  // The page shell embeds the viewer, so make that viewer an admin.
  await page.addInitScript(() => {
    let bootstrap: { me?: { user?: { isAdmin?: boolean } } } | undefined;
    Object.defineProperty(window, "__JUNIOR_DASHBOARD_BOOTSTRAP__", {
      configurable: true,
      get: () => bootstrap,
      set: (value) => {
        if (value?.me?.user) value.me.user.isAdmin = true;
        bootstrap = value;
      },
    });
  });
  let refill: Record<string, unknown> = {
    status: "done",
    startedAt: new Date(NOW_MS - 3 * 60 * 60 * 1_000).toISOString(),
    finishedAt: new Date(NOW_MS - 2 * 60 * 60 * 1_000).toISOString(),
    scannedConversations: 1_284,
    totalConversations: 1_284,
  };
  const starts: string[] = [];
  await page.route("**/api/cache-warming/savings/refill", async (route) => {
    if (route.request().method() === "POST") {
      starts.push(route.request().method());
      refill = {
        status: "running",
        startedAt: new Date(NOW_MS).toISOString(),
        scannedConversations: 420,
        totalConversations: 1_310,
      };
      await route.fulfill({ status: 202, json: { refill } });
      return;
    }
    await route.fulfill({ json: { refill } });
  });

  await page.goto(`${dashboard.baseURL}/system`);
  const panel = page.getByRole("region", { name: "Cache warming" });
  const button = panel.getByRole("button", { name: "Re-fill history" });
  await expect(button).toBeEnabled();
  await expect(panel.getByText(/Last re-fill finished/)).toBeVisible();
  await screenshot(page, "system-cache-warming-refill", { target: panel });

  await button.click();
  await expect(panel.getByText(/Re-filling history: 420 of/)).toBeVisible();
  await expect(button).toBeDisabled();
  await screenshot(page, "system-cache-warming-refill-running", {
    target: panel,
  });
  expect(starts).toEqual(["POST"]);
});

test.describe("keeps the people directory across window focus", () => {
  test.use({ controlTimers: true });

  test("loads System People within its request budget", async ({
    page,
    dashboard,
  }) => {
    let directoryReads = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/people") {
        directoryReads += 1;
      }
    });

    await expectRequestBudget(
      page,
      async () => {
        await page.goto(`${dashboard.baseURL}/system/people`);
        await expect(
          page.getByText("Highest spend", { exact: true }),
        ).toBeVisible();
      },
      { requests: 6, serialRounds: 2 },
    );
    expect(directoryReads).toBe(1);

    // React Query refetches stale queries on `visibilitychange`. Go past the
    // default stale time so a focus refetch would read the directory again.
    await page.clock.fastForward(60_000);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForLoadState("networkidle");
    expect(directoryReads).toBe(1);
  });
});
