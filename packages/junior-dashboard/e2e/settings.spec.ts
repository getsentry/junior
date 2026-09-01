import { expect, test } from "./test";
import { captureDashboardScreenshot, DESKTOP } from "./screenshot";

test("updates the signed-in user's display name", async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.baseURL);
  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveValue("Dashboard User");
  await captureDashboardScreenshot(page, "settings", { viewport: DESKTOP });

  await page.getByLabel("Display name").fill("Cramer Jr.");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Changes saved.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /profile menu for Cramer Jr\./i }),
  ).toBeVisible();
});
