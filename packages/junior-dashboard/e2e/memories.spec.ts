import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("opens a registered plugin page from the profile menu", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(dashboard.baseURL);

  await page
    .getByRole("button", {
      name: "Open profile menu for Dashboard User",
      exact: true,
    })
    .click();
  const memoriesLink = page
    .locator("#profile-popover")
    .getByRole("menuitem", { name: "Memories" });
  await expect(memoriesLink).toHaveAttribute("href", "/memories");
  await memoriesLink.click();

  await expect(page).toHaveURL(`${dashboard.baseURL}/memories`);
  await expect(
    page.getByRole("heading", { name: "Memories", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Memory summary" })
      .getByText("Total active", { exact: true }),
  ).toBeVisible();
  await screenshot(page, "memories");
  await expect(
    page.getByRole("heading", { name: "Activity over time" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /^\$/ })).toBeVisible();
  await expect(page.getByText(/^Extraction · \$/)).toBeVisible();
  await expect(page.getByText(/^Recall · \$/)).toBeVisible();
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
  await expect(page).toHaveURL(`${dashboard.baseURL}/memories/library`);
  await expect(
    page.getByRole("button", {
      name: /^View memory details: I prefer concise summaries/,
    }),
  ).toBeVisible();
  await screenshot(page, "memories-library");
});

test("opens memory details beside the library", async ({ page, dashboard }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(`${dashboard.baseURL}/memories/library`);

  const memory = page.getByRole("button", {
    name: /^View memory details: I prefer concise summaries/,
  });
  await memory.click();
  await expect(page).toHaveURL(/\/memories\/memory-1/);
  const details = page.getByRole("complementary", { name: "Memory details" });
  await expect(
    details.getByRole("heading", { name: "Preference" }),
  ).toBeVisible();
  await expect(details.getByText("From a Slack conversation")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The docked panel is not modal: the list stays usable beside it.
  await expect(memory).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(page).toHaveURL(/\/memories\/library$/);
  await expect(memory).toBeFocused();
  await expect(
    page
      .getByRole("navigation", { name: "Memory navigation" })
      .getByRole("link", { name: "Memories" }),
  ).toHaveAttribute("aria-current", "page");

  await page.setViewportSize({ height: 844, width: 390 });
  await memory.click();
  const mobileDetails = page.getByRole("dialog", { name: "Preference" });
  await expect(mobileDetails).toBeVisible();
  await expect(
    mobileDetails.getByRole("button", { name: "Forget this memory" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(memory).toBeFocused();
});

test("renders an empty registered plugin page", async ({ page, dashboard }) => {
  await page.route("**/api/user-pages/memory/memories", async (route) => {
    await route.fulfill({
      json: {
        type: "list",
        emptyText: "No memories yet.",
        records: [],
      },
    });
  });

  await page.goto(`${dashboard.baseURL}/memories/library`);

  await expect(page.getByText("No memories yet.")).toBeVisible();
});

test("shows the memory overview error state", async ({ page, dashboard }) => {
  await page.route("**/api/memory/dashboard", async (route) => {
    await route.fulfill({ json: { error: "Unavailable" }, status: 500 });
  });

  await page.goto(`${dashboard.baseURL}/memories`);

  await expect(
    page.getByText("Memory history is temporarily unavailable."),
  ).toBeVisible();
  await expect(page.getByText("Loading memory summary")).not.toBeVisible();
});

test("searches, paginates, and forgets plugin page records", async ({
  page,
  dashboard,
}) => {
  let forgotMemory = false;
  let forgetRequests = 0;
  let dashboardRequestCount = 0;
  await page.route("**/api/memory/dashboard", async (route) => {
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
                  confirmation: "Forget this memory for everyone?",
                  href: "/api/memory/memories/memory-search",
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
        ...(!query && !cursor ? { nextCursor: "page-2" } : undefined),
        records,
        searchPlaceholder: "Search memories",
      },
    });
  });
  await page.route("**/api/memory/memories/memory-search", async (route) => {
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
        },
      });
      return;
    }
    forgetRequests += 1;
    expect(route.request().method()).toBe("DELETE");
    forgotMemory = true;
    await route.fulfill({ status: 204 });
  });

  // Load the summary first, so the forget must invalidate a cached copy.
  await page.goto(`${dashboard.baseURL}/memories`);
  await expect.poll(() => dashboardRequestCount).toBe(1);
  const memoryNavigation = page.getByRole("navigation", {
    name: "Memory navigation",
  });
  await memoryNavigation.getByRole("link", { name: "Memories" }).click();
  await expect(
    page.getByRole("button", {
      name: /^View memory details: First page memory/,
    }),
  ).toBeVisible();
  const searchbox = page.getByRole("searchbox", { name: "Search memories" });
  await searchbox.fill("runbook");
  await expect(page).toHaveURL(/q=runbook/);
  await expect(
    page.getByRole("button", { name: "Load more" }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /^View memory details: Deploy runbooks live in Notion/,
    }),
  ).toBeVisible();
  await expect(page.locator("mark")).toHaveText(["runbook"]);
  await screenshot(page, "memories-search");

  await searchbox.fill("");
  await expect(page).not.toHaveURL(/q=/);
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

  await page
    .getByRole("button", {
      name: /^View memory details: Deploy runbooks live in Notion/,
    })
    .click();
  await page
    .getByRole("complementary", { name: "Memory details" })
    .getByRole("button", { name: "Forget this memory" })
    .click();
  await page
    .getByRole("alertdialog", { name: "Forget this memory for everyone?" })
    .getByRole("button", { name: "Forget" })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect(
    page.getByText("No memories matched your search."),
  ).toBeVisible();
  expect(forgetRequests).toBe(1);

  await searchbox.fill("");
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByText("No memories yet.")).toBeVisible();

  await memoryNavigation.getByRole("link", { name: "Overview" }).click();
  await expect.poll(() => dashboardRequestCount).toBeGreaterThan(1);
});

test("lists archived memories and restores one", async ({
  page,
  dashboard,
}) => {
  let restoreMethod: string | undefined;
  let restoreBody: unknown;
  let activeReads = 0;
  // Off when the permalink opens, as if the memory were past the first page.
  let listed = true;
  // Holds the first archived list read, so the tab switch can be checked.
  let releaseArchived = () => {};
  const archivedGate = new Promise<void>((resolve) => {
    releaseArchived = resolve;
  });
  await page.route("**/api/user-pages/memory/memories*", async (route) => {
    const archived =
      new URL(route.request().url()).searchParams.get("filter") === "archived";
    if (archived) await archivedGate;
    const records = !archived
      ? [{ id: "memory-1", title: "First page memory." }]
      : restoreMethod || !listed
        ? []
        : [
            {
              id: "memory-archived",
              metadata: [
                { label: "Type", value: "Knowledge" },
                { label: "Learned", value: "Automatic" },
                { label: "Source", value: "Slack" },
                { label: "Remembered", value: "Jul 1, 2026, 12:00 PM" },
                { label: "Archived", value: "Jul 30, 2026, 12:00 PM" },
                { label: "Reason", value: "Contradicted" },
              ],
              title: "Junior's updatePlan tool does not persist plan steps.",
            },
          ];
    await route.fulfill({
      json: {
        type: "list",
        emptyText: archived ? "No archived memories." : "No memories yet.",
        records,
        searchPlaceholder: "Search memories",
      },
    });
  });
  await page.route(
    "**/api/memory/memories/memory-archived**",
    async (route) => {
      if (route.request().method() === "PATCH") {
        restoreMethod = route.request().method();
        restoreBody = route.request().postDataJSON();
        await route.fulfill({
          json: {
            content: "Junior's updatePlan tool does not persist plan steps.",
            createdAt: "2026-07-01T12:00:00.000Z",
            id: "memory-archived",
            kind: "knowledge",
            observedAt: "2026-07-01T12:00:00.000Z",
            origin: "automatic",
            sourcePlatform: "slack",
          },
        });
        return;
      }
      if (
        new URL(route.request().url()).searchParams.get("archived") !== "true"
      ) {
        activeReads += 1;
      }
      await route.fulfill({
        json: {
          archiveReason: "contradicted",
          archivedAt: "2026-07-30T12:00:00.000Z",
          content: "Junior's updatePlan tool does not persist plan steps.",
          createdAt: "2026-07-01T12:00:00.000Z",
          id: "memory-archived",
          kind: "knowledge",
          observedAt: "2026-07-01T12:00:00.000Z",
          origin: "automatic",
          sourcePlatform: "slack",
        },
      });
    },
  );

  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(`${dashboard.baseURL}/memories/library`);
  await page
    .getByRole("tablist", { name: "Memory state" })
    .getByRole("tab", { name: "Archived" })
    .click();
  await expect(page).toHaveURL(/filter=archived/);
  // Active rows do not stay on the Archived tab while it loads.
  await expect(
    page.getByRole("button", { name: /^View memory details: First page/ }),
  ).toHaveCount(0);
  releaseArchived();
  await expect(
    page.getByRole("heading", { name: "Archived memories" }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: /^View memory details: Junior's updatePlan tool/,
    })
    .click();
  const details = page.getByRole("complementary", { name: "Memory details" });
  await expect(details.getByText("Contradicted")).toBeVisible();
  await expect(
    details.getByRole("button", { name: "Forget this memory" }),
  ).toHaveCount(0);
  await screenshot(page, "memories-archived-details");

  // A permalink opens without the list, through the archived detail read.
  listed = false;
  await page.goto(
    `${dashboard.baseURL}/memories/memory-archived?filter=archived`,
  );
  await details.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("No archived memories.")).toBeVisible();
  expect(restoreMethod).toBe("PATCH");
  expect(restoreBody).toEqual({ archived: false });
  expect(activeReads).toBe(0);
  await screenshot(page, "memories-archived-empty");
});
