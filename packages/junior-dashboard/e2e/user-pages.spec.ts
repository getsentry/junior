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
