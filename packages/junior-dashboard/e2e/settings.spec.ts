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
  await screenshot(page, "settings", { view: "desktop" });

  await page.getByLabel("Display name").fill("Cramer Jr.");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Changes saved.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /profile menu for Cramer Jr\./i }),
  ).toBeVisible();
});

test("saves notification working hours", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/settings`);
  await expect(
    page.getByRole("heading", { name: "Phone notifications" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Phone notifications are not set up for this Junior install.",
    ),
  ).toBeVisible();
  await screenshot(page, "settings-notifications");

  const saturday = page.getByRole("button", { name: "Sat" });
  await expect(saturday).toHaveAttribute("aria-pressed", "false");
  await saturday.click();
  await page.getByLabel("Start").fill("08:30");
  const saved = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().endsWith("/api/notifications/schedule"),
  );
  await page.getByRole("button", { name: "Save hours" }).click();
  expect((await saved).postDataJSON()).toEqual({
    workingHoursOnly: true,
    days: [1, 2, 3, 4, 5, 6],
    start: "08:30",
    end: "18:00",
  });
  await expect(page.getByText("Hours saved.")).toBeVisible();
  await expect(saturday).toHaveAttribute("aria-pressed", "true");
});

test("follows the system theme until the user picks one", async ({
  page,
  dashboard,
}) => {
  const root = page.locator("html");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(dashboard.baseURL);
  await expect(root).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await expect(
    page.getByRole("button", { name: "System theme" }),
  ).toHaveAttribute("aria-pressed", "true");
  await screenshot(page, "settings-theme-light", { view: "desktop" });

  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("button", { name: "System theme" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
});
