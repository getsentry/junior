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

test("opens a registered plugin page from primary navigation", async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  const browserErrors = collectBrowserErrors(page);
  await page.goto(server.baseURL);

  const memoriesLink = page.getByRole("link", { name: "Memories" });
  await expect(memoriesLink).toHaveAttribute(
    "href",
    "/plugins/memory/memories",
  );
  await memoriesLink.click();

  await expect(page).toHaveURL(`${server.baseURL}/plugins/memory/memories`);
  await expect(
    page.getByRole("heading", { name: "Memories", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Memory summary" })
      .getByText("Total active", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Activity over time" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /^\$/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What Junior remembers" }),
  ).toBeVisible();
  const activityRange = page.getByLabel("Memory timeline range");
  const sevenDays = activityRange.getByRole("button", { name: "7d" });
  const thirtyDays = activityRange.getByRole("button", { name: "30d" });
  const ninetyDays = activityRange.getByRole("button", { name: "90d" });
  await expect(thirtyDays).toHaveAttribute("aria-pressed", "true");
  await sevenDays.click();
  await expect(sevenDays).toHaveAttribute("aria-pressed", "true");
  await ninetyDays.click();
  await expect(ninetyDays).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("navigation", { name: "Memory navigation" })
    .getByRole("link", { name: "Memories" })
    .click();
  await expect(page).toHaveURL(
    `${server.baseURL}/plugins/memory/memories/library`,
  );
  await expect(
    page.getByRole("button", { name: /^I prefer concise summaries/ }),
  ).toBeVisible();
  await expect(page.getByText("Private").last()).toBeVisible();
  const privateTab = page.getByRole("tab", { name: "Private 24" });
  await privateTab.click();
  await expect(privateTab).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/filter=private/);
  const navLinks = await page.locator("header nav a").allTextContents();
  expect(navLinks.at(-1)?.trim()).toBe("System");
  expect(browserErrors).toEqual([]);
});

test("keeps other plugin pages on the generic renderer", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto(server.baseURL);

  await page
    .getByRole("button", { name: "Open profile menu for Dashboard User" })
    .click();
  await page.getByRole("link", { name: "Scheduled tasks" }).click();

  await expect(page).toHaveURL(`${server.baseURL}/plugins/scheduler/tasks`);
  await expect(
    page.getByRole("heading", { name: "Scheduled tasks" }),
  ).toBeVisible();
  await expect(page.getByText("Send the weekly project summary")).toBeVisible();
  await expect(page.getByText("Memory system")).not.toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("expands memory details inline on desktop", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const browserErrors = collectBrowserErrors(page);
  await page.goto(`${server.baseURL}/plugins/memory/memories/library`);

  const memory = page.getByRole("button", {
    name: /^I prefer concise summaries/,
  });
  await memory.click();
  await expect(
    page.getByText("Why Junior remembers this").first(),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");

  await memory.click();
  await expect(
    page.getByText("Why Junior remembers this").first(),
  ).not.toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("opens memory details in a mobile sheet", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  const browserErrors = collectBrowserErrors(page);
  await page.goto(`${server.baseURL}/plugins/memory/memories/library`);

  await page
    .getByRole("button", { name: /^I prefer concise summaries/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("hidden");
  await expect(dialog.getByText("Why Junior remembers this")).toBeVisible();
  await expect(dialog.getByText("Private")).toBeVisible();
  await expect(
    dialog.getByText(/Junior learned this from a Slack conversation/),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");
  expect(browserErrors).toEqual([]);
});

test("renders an empty registered plugin page", async ({ page }) => {
  await page.route("**/api/user-pages/memory/memories", async (route) => {
    await route.fulfill({
      json: {
        type: "list",
        emptyText: "No memories yet.",
        records: [],
      },
    });
  });
  const browserErrors = collectBrowserErrors(page);

  await page.goto(`${server.baseURL}/plugins/memory/memories/library`);

  await expect(page.getByText("No memories yet.")).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("shows the memory overview error state", async ({ page }) => {
  await page.route("**/api/plugins/memory/dashboard", async (route) => {
    await route.fulfill({ json: { error: "Unavailable" }, status: 500 });
  });

  await page.goto(`${server.baseURL}/plugins/memory/memories`);

  await expect(
    page.getByText("Memory history is temporarily unavailable."),
  ).toBeVisible();
  await expect(page.getByText("Loading memory summary")).not.toBeVisible();
});

test("searches, paginates, and forgets plugin page records", async ({
  page,
}) => {
  let forgotMemory = false;
  let dashboardRequestCount = 0;
  await page.route("**/api/plugins/memory/dashboard", async (route) => {
    dashboardRequestCount += 1;
    await route.fallback();
  });
  await page.route("**/api/user-pages/memory/memories*", async (route) => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get("q");
    const cursor = url.searchParams.get("cursor");
    if (query) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const records = forgotMemory
      ? []
      : query
        ? [
            {
              actions: [
                {
                  confirmation: "Forget this memory?",
                  href: "/api/plugins/memory/memories/memory-search",
                  label: "Forget",
                  method: "DELETE",
                  tone: "danger",
                },
              ],
              id: "memory-search",
              title: "Deploy runbooks live in Notion.",
            },
          ]
        : cursor
          ? [{ id: "memory-2", title: "Second page memory." }]
          : [{ id: "memory-1", title: "First page memory." }];
    await route.fulfill({
      json: {
        type: "list",
        emptyText: query
          ? "No memories matched your search."
          : "No memories yet.",
        ...(!query && !cursor ? { nextCursor: "page-2" } : {}),
        records,
        searchPlaceholder: "Search memories",
      },
    });
  });
  await page.route(
    "**/api/plugins/memory/memories/memory-search",
    async (route) => {
      expect(route.request().method()).toBe("DELETE");
      forgotMemory = true;
      await route.fulfill({ status: 204 });
    },
  );
  const browserErrors = collectBrowserErrors(page);

  await page.goto(`${server.baseURL}/plugins/memory/memories/library`);
  await expect(
    page.getByRole("button", { name: /^First page memory/ }),
  ).toBeVisible();
  const searchbox = page.getByRole("searchbox", { name: "Search memories" });
  await searchbox.fill("runbook");
  const privateTab = page.getByRole("tab", { name: /^Private/ });
  await privateTab.click();
  await expect(page).toHaveURL(/filter=private/);
  await expect(page).toHaveURL(/q=runbook/);
  await expect(
    page.getByRole("button", { name: "Load more" }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Deploy runbooks live in Notion/ }),
  ).toBeVisible();

  await searchbox.fill("");
  await expect(page).not.toHaveURL(/q=/);
  await page.getByRole("tab", { name: /^All/ }).click();
  await expect(page).not.toHaveURL(/filter=/);
  await expect(
    page.getByRole("button", { name: /^First page memory/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(
    page.getByRole("button", { name: /^Second page memory/ }),
  ).toBeVisible();

  await searchbox.fill("runbook");
  await expect(page).toHaveURL(/q=runbook/);
  await expect(searchbox).toBeFocused();
  await expect(
    page.getByRole("button", { name: /^Deploy runbooks live in Notion/ }),
  ).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: /^Deploy runbooks live in Notion/ })
    .click();
  await page.getByRole("button", { name: "Forget this memory" }).click();
  await expect(
    page.getByText("No memories matched your search."),
  ).toBeVisible();
  await expect.poll(() => dashboardRequestCount).toBeGreaterThan(1);

  await searchbox.fill("");
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByText("No memories yet.")).toBeVisible();
  expect(browserErrors).toEqual([]);
});
