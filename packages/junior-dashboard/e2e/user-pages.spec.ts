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
  await expect(memoriesLink).toHaveAttribute("href", "/memories");
  await memoriesLink.click();

  await expect(page).toHaveURL(`${server.baseURL}/memories`);
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
  await expect(page.getByText(/^Extraction \$/)).toBeVisible();
  await expect(page.getByText(/^Recall \$/)).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: "Memory extraction and recall cost during the last 30 days",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What Junior remembers" }),
  ).toBeVisible();
  const reportingPeriod = page.getByLabel("Reporting period");
  await expect(reportingPeriod).toHaveCount(1);
  const sevenDays = reportingPeriod.getByRole("button", { name: "7d" });
  const thirtyDays = reportingPeriod.getByRole("button", { name: "30d" });
  const ninetyDays = reportingPeriod.getByRole("button", { name: "90d" });
  await expect(thirtyDays).toHaveAttribute("aria-pressed", "true");
  await sevenDays.click();
  await expect(sevenDays).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("img", { name: "Memories learned during the last 7 days" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: "Memory extraction and recall cost during the last 7 days",
    }),
  ).toBeVisible();
  await ninetyDays.click();
  await expect(ninetyDays).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("img", { name: "Memories learned during the last 90 days" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: "Memory extraction and recall cost during the last 90 days",
    }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Memory navigation" })
    .getByRole("link", { name: "Memories" })
    .click();
  await expect(page).toHaveURL(`${server.baseURL}/memories/library`);
  await expect(
    page.getByRole("button", {
      name: /^View memory details: I prefer concise summaries/,
    }),
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

test("opens scheduled and event tasks in the native Tasks view", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto(server.baseURL);

  await page.getByRole("link", { name: "Tasks" }).click();

  await expect(page).toHaveURL(`${server.baseURL}/tasks`);
  await expect(page.getByLabel("Tasks navigation")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Activity over time" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Task executions during the last 30 days"),
  ).toBeVisible();
  const reportingPeriod = page.getByLabel("Reporting period");
  await expect(reportingPeriod).toHaveCount(1);
  await reportingPeriod.getByRole("button", { name: "7d" }).click();
  await expect(
    page.getByLabel("Task executions during the last 7 days"),
  ).toBeVisible();
  await expect(page.getByText("2 tasks")).toBeVisible();
  await page
    .getByLabel("Tasks navigation")
    .getByRole("link", { name: "Tasks" })
    .click();
  await expect(page).toHaveURL(`${server.baseURL}/tasks/list`);
  await expect(page.getByRole("heading", { name: "All tasks" })).toBeVisible();
  await expect(page.getByLabel("Search tasks")).toBeVisible();
  await expect(page.getByText("Weekly project summary")).toBeVisible();
  await expect(page.getByText("Closed issue summary")).toBeVisible();
  await expect(page.getByLabel("Scheduled task")).toBeVisible();
  await expect(page.getByLabel("GitHub event task")).toBeVisible();
  await expect(page.getByText("#project-updates").last()).toBeVisible();
  await expect(page.getByText("Assigned to")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const taskDetailsTrigger = page.getByRole("button", {
    name: "View task details: Weekly project summary",
  });
  await taskDetailsTrigger.click();
  const details = page.getByRole("dialog", { name: "Weekly project summary" });
  await expect(details).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("hidden");
  const closeTaskDetails = details.getByRole("button", {
    name: "Close task details",
  });
  await expect(closeTaskDetails).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(closeTaskDetails).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeTaskDetails).toBeFocused();
  await expect(details.getByText("Instruction")).toBeVisible();
  await expect(
    details.getByText("Send the weekly project summary"),
  ).toBeVisible();
  await expect(details.getByRole("link", { name: "you" })).toHaveAttribute(
    "href",
    "/people/morgan%40sentry.io",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");
  await expect(taskDetailsTrigger).toBeFocused();
  await expect(page.getByText("Incident change alerts")).not.toBeVisible();
  await page.getByRole("button", { name: "event", exact: true }).click();
  await expect(page.getByText("Weekly project summary")).not.toBeVisible();
  await expect(page.getByText("Closed issue summary")).toBeVisible();
  await page.getByRole("button", { name: /^Public/ }).click();
  await expect(page.getByText("Incident change alerts")).toBeVisible();
  await expect(page.getByText("#incident-response").last()).toBeVisible();
  await page
    .getByRole("button", {
      name: "View task details: Incident change alerts",
    })
    .click();
  const publicDetails = page.getByRole("dialog");
  await expect(publicDetails).toBeVisible();
  const creatorLink = publicDetails.getByRole("link", { name: "Avery Chen" });
  await expect(creatorLink).toHaveAttribute(
    "href",
    "/people/avery%40sentry.io",
  );
  await expect(page.getByLabel("PagerDuty event task")).toBeVisible();
  await expect(page.getByText("Memory system")).not.toBeVisible();
  await creatorLink.click();
  await expect(page).toHaveURL(`${server.baseURL}/people/avery%40sentry.io`);
  await expect(page.getByRole("heading", { name: "Avery Chen" })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("lists runs across tasks", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto(`${server.baseURL}/tasks/runs`);

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByText("Weekly project summary").first()).toBeVisible();
  await expect(
    page.getByText("scheduled", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("completed", { exact: true }).first(),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("opens one task's execution history", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto(`${server.baseURL}/tasks/scheduled/scheduled-1/executions`);

  await expect(
    page.getByRole("heading", { name: "Weekly project summary" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Executions over time" }),
  ).toBeVisible();
  const reportingPeriod = page.getByLabel("Reporting period");
  await expect(reportingPeriod).toHaveCount(1);
  await reportingPeriod.getByRole("button", { name: "90d" }).click();
  await expect(
    page.getByLabel("Task executions during the last 90 days"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Weekly project summary/ }),
  ).toBeVisible();
  await expect(
    page.getByText("completed", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("No conversation", { exact: true }),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("opens memory details in a slide-out drawer", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const browserErrors = collectBrowserErrors(page);
  await page.goto(`${server.baseURL}/memories/library`);

  const memory = page.getByRole("button", {
    name: /^View memory details: I prefer concise summaries/,
  });
  await memory.click();
  const details = page.getByRole("dialog", { name: "What Junior remembers" });
  await expect(details).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("hidden");
  const closeMemoryDetails = details.getByRole("button", {
    name: "Close memory details",
  });
  await expect(closeMemoryDetails).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(closeMemoryDetails).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeMemoryDetails).toBeFocused();
  await expect(details.getByText("Why Junior remembers this")).toBeVisible();
  await expect(details.getByText(/Preference · Private ·/)).toBeVisible();
  await expect(
    details.getByText(/Junior learned this from a Slack conversation/),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");
  await expect(memory).toBeFocused();

  await page.setViewportSize({ height: 844, width: 390 });
  await memory.click();
  const mobileDetails = page.getByRole("dialog", {
    name: "What Junior remembers",
  });
  await expect(mobileDetails).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("hidden");
  await expect(
    mobileDetails.getByText("Why Junior remembers this"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
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

  await page.goto(`${server.baseURL}/memories/library`);

  await expect(page.getByText("No memories yet.")).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("shows the memory overview error state", async ({ page }) => {
  await page.route("**/api/plugins/memory/dashboard", async (route) => {
    await route.fulfill({ json: { error: "Unavailable" }, status: 500 });
  });

  await page.goto(`${server.baseURL}/memories`);

  await expect(
    page.getByText("Memory history is temporarily unavailable."),
  ).toBeVisible();
  await expect(page.getByText("Loading memory summary")).not.toBeVisible();
});

test("searches, paginates, and forgets plugin page records", async ({
  page,
}) => {
  let forgotMemory = false;
  let forgetRequests = 0;
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
      if (route.request().method() === "GET") {
        if (forgotMemory) {
          await route.fulfill({
            json: { error: "Memory was not found." },
            status: 404,
          });
          return;
        }
        await route.fulfill({
          json: {
            content: "Deploy runbooks live in Notion.",
            createdAt: "2026-07-30T12:00:00.000Z",
            id: "memory-search",
            kind: "knowledge",
            observedAt: "2026-07-30T12:00:00.000Z",
            origin: "explicit",
            sourcePlatform: "slack",
            visibility: "private",
          },
        });
        return;
      }
      forgetRequests += 1;
      expect(route.request().method()).toBe("DELETE");
      forgotMemory = true;
      await route.fulfill({ status: 204 });
    },
  );
  const browserErrors = collectBrowserErrors(page);

  await page.goto(`${server.baseURL}/memories/library`);
  await expect(
    page.getByRole("button", {
      name: /^View memory details: First page memory/,
    }),
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
    page.getByRole("button", {
      name: /^View memory details: Deploy runbooks live in Notion/,
    }),
  ).toBeVisible();

  await searchbox.fill("");
  await expect(page).not.toHaveURL(/q=/);
  await page.getByRole("tab", { name: /^All/ }).click();
  await expect(page).not.toHaveURL(/filter=/);
  await expect(
    page.getByRole("button", {
      name: /^View memory details: First page memory/,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(
    page.getByRole("button", {
      name: /^View memory details: Second page memory/,
    }),
  ).toBeVisible();

  await searchbox.fill("runbook");
  await expect(page).toHaveURL(/q=runbook/);
  await expect(searchbox).toBeFocused();
  await expect(
    page.getByRole("button", {
      name: /^View memory details: Deploy runbooks live in Notion/,
    }),
  ).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", {
      name: /^View memory details: Deploy runbooks live in Notion/,
    })
    .click();
  await page
    .getByRole("dialog", { name: "What Junior remembers" })
    .getByRole("button", { name: "Forget this memory" })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect(
    page.getByText("No memories matched your search."),
  ).toBeVisible();
  expect(forgetRequests).toBe(1);
  await expect.poll(() => dashboardRequestCount).toBeGreaterThan(1);

  await searchbox.fill("");
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByText("No memories yet.")).toBeVisible();
  expect(browserErrors).toEqual([]);
});
