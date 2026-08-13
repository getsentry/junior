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

test("explores location activity", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(`${server.baseURL}/locations?q=proj`);

  await expect(page).toHaveURL(`${server.baseURL}/system/locations?q=proj`);
  await expect(
    page.getByRole("searchbox", { name: "Search locations" }),
  ).toHaveValue("proj");
  await page.getByRole("searchbox", { name: "Search locations" }).fill("");

  await expect(
    page.getByRole("heading", { name: "Locations", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Public and private conversations per day" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "90d" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "7d" }).click();
  await expect(page.getByRole("button", { name: "7d" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("combobox", { name: "Sort locations" }),
  ).toHaveValue("conversations");
  await expect(
    page
      .getByLabel("System navigation")
      .getByRole("link", { name: "Locations" }),
  ).toHaveAttribute("aria-current", "page");
});
