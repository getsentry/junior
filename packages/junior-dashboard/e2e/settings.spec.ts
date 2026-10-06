import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("updates the signed-in user's display name", async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.baseURL);
  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveValue("Dashboard User");
  const optIn = page.getByRole("checkbox", {
    name: "Allow distillation for my private Conversations",
  });
  await expect(optIn).not.toBeChecked();
  await screenshot(page, "settings", { view: "desktop" });

  await optIn.click();
  await expect(optIn).toBeChecked();
  await page.reload();
  await expect(optIn).toBeChecked();
  await optIn.click();
  await expect(optIn).not.toBeChecked();

  await page.getByLabel("Display name").fill("Cramer Jr.");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Changes saved.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /profile menu for Cramer Jr\./i }),
  ).toBeVisible();
});
