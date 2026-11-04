import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("shows code activity", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/code`);

  await expect(
    page.getByRole("heading", { name: "Code", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Repositories and code changes created by Junior."),
  ).toBeVisible();
  await screenshot(page, "code");

  await page.goto(`${dashboard.baseURL}/code?repository=getsentry/junior`);
  const filter = page.getByRole("group", { name: "Repositories" });
  await expect(
    filter.getByRole("link", { name: "Remove getsentry/junior" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "getsentry/payments", exact: true }),
  ).toHaveCount(0);
  await screenshot(page, "code-filtered");
  await filter.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(/\/code$/);
  await expect(
    page.getByRole("link", { name: "getsentry/payments", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("link", { name: "getsentry/junior", exact: true })
    .click();

  await expect(
    page.getByRole("heading", { name: "getsentry/junior", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("getsentry/junior - Junior");
  await expect(
    page.getByRole("link", { name: "junior", exact: true }),
  ).toHaveAttribute("href", "/system/workspaces/workspace-junior");
  await expect(
    page.getByText("Keep repository context across turns"),
  ).toBeVisible();
  await screenshot(page, "code-repository");

  await page
    .getByRole("navigation", { name: "Repository navigation" })
    .getByRole("link", { name: "Changes" })
    .click();
  await expect(page).toHaveURL(/\/code\/[^/]+\/changes$/);
  await expect(page.getByRole("tab", { name: /Merged/ })).toBeVisible();
});
