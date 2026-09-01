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

test("explores people activity", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(`${server.baseURL}/system/people`);

  await expect(
    page.getByRole("heading", { name: "People", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Active people per day" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "7d" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("combobox", { name: "Sort people" })).toHaveValue(
    "spend",
  );
  await expect(page.getByText("Fleet spend", { exact: true })).toBeVisible();
  await expect(page.getByText("Top contributor", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Largest increase", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("System navigation").getByRole("link", { name: "People" }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "24h" }).click();
  await expect(page.getByRole("button", { name: "24h" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("img", { name: "Active people per hour" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "90d" }).click();
  await expect(page.getByRole("button", { name: "90d" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("img", { name: "Active people per day" }),
  ).toBeVisible();
});
