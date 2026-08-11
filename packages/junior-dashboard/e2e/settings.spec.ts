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

test("updates the signed-in user's display name", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto(server.baseURL);
  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveValue("Dashboard User");

  await page.getByLabel("Display name").fill("Cramer Jr.");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Changes saved.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /profile menu for Cramer Jr\./i }),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});
