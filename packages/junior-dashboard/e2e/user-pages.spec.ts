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

test("opens a registered plugin page from the user menu", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  const browserErrors = collectBrowserErrors(page);
  await page.goto(server.baseURL);

  await page
    .getByRole("button", { name: "Open profile menu for Dashboard User" })
    .click();
  const memoriesLink = page.getByRole("link", { name: "Memories" });
  await expect(memoriesLink).toHaveAttribute(
    "href",
    "/settings/plugins/memory/memories",
  );
  await memoriesLink.click();

  await expect(page).toHaveURL(
    `${server.baseURL}/settings/plugins/memory/memories`,
  );
  await expect(
    page.getByRole("heading", { name: "Memories", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("I prefer concise summaries.")).toBeVisible();
  await expect(page.getByText("Preference", { exact: true })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("renders an empty registered plugin page", async ({ page }) => {
  await page.route("**/api/user-pages/memory/memories", async (route) => {
    await route.fulfill({
      json: {
        type: "list",
        emptyText: "No personal memories yet.",
        records: [],
      },
    });
  });
  const browserErrors = collectBrowserErrors(page);

  await page.goto(`${server.baseURL}/settings/plugins/memory/memories`);

  await expect(page.getByText("No personal memories yet.")).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("searches, paginates, and forgets plugin page records", async ({
  page,
}) => {
  let forgotMemory = false;
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
          : "No personal memories yet.",
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

  await page.goto(`${server.baseURL}/settings/plugins/memory/memories`);
  await expect(page.getByText("First page memory.")).toBeVisible();
  const searchbox = page.getByRole("searchbox", { name: "Search memories" });
  await searchbox.fill("runbook");
  await expect(page).toHaveURL(/q=runbook/);
  await expect(
    page.getByRole("button", { name: "Load more" }),
  ).not.toBeVisible();
  await expect(searchbox).toBeFocused();
  await expect(page.getByText("Deploy runbooks live in Notion.")).toBeVisible();

  await searchbox.fill("");
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByText("First page memory.")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Second page memory.")).toBeVisible();

  await searchbox.fill("runbook");
  await expect(page).toHaveURL(/q=runbook/);
  await expect(searchbox).toBeFocused();
  await expect(page.getByText("Deploy runbooks live in Notion.")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", {
      name: "Forget: Deploy runbooks live in Notion.",
    })
    .click();
  await expect(
    page.getByText("No memories matched your search."),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});
