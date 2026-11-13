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

test("opens Linked work toward the larger free space", async ({
  page,
  dashboard,
}) => {
  // Some browsers default to a root font smaller than 16px. Set it before
  // the page loads: a later change animates the sidebar width while the
  // hover runs. The first repository conversation sits about 450px from the
  // top.
  await page.addInitScript(() => {
    // The document has no elements yet, so adopt a sheet instead of a tag.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("html { font-size: 14px }");
    document.adoptedStyleSheets = [sheet];
  });
  for (const { height, side } of [
    { height: 1400, side: "bottom" },
    { height: 600, side: "top" },
  ]) {
    await page.setViewportSize({ height, width: 1600 });
    // Open the page directly so it starts at the top. A click from the
    // scrolled Code list can keep that scroll, and a root font change after
    // render moves the row while the hover runs. Both move the trigger up.
    await page.goto(
      `${dashboard.baseURL}/code/00000000-0000-4000-8000-000000000003`,
    );
    await page
      .getByLabel(/^Linked work, newest first/)
      .first()
      .hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("Linked work");
    await expect(tooltip).toHaveAttribute("data-side", side);
  }
});
