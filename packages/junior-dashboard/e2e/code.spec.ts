import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("shows code activity", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/code`);

  await expect(
    page.getByRole("main").getByRole("heading", { name: "Code", exact: true }),
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

test("counts every open code change past the listed ones", async ({
  page,
  dashboard,
}) => {
  // The reports list at most 100 changes. The counts cover every change.
  await page.route(/\/api\/people\/[^/]+\/code$/, async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    await route.fulfill({
      response,
      json: {
        ...report,
        changes: Array.from({ length: 100 }, (_, index) => ({
          ...report.changes[0],
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          number: index + 1,
          state: "open",
        })),
        summary: { ...report.summary, open: 105 },
      },
    });
  });
  await page.route(/\/api\/code\/repositories\/[^/]+$/, async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    await route.fulfill({
      response,
      json: { ...report, changeCounts: { closed: 12, merged: 3, open: 105 } },
    });
  });

  await page.goto(`${dashboard.baseURL}/conversations/new`);
  await expect(
    page.getByRole("region", { name: "Your week" }).getByText("105", {
      exact: true,
    }),
  ).toBeVisible();

  await page.goto(`${dashboard.baseURL}/code`);
  await page
    .getByRole("link", { name: "getsentry/junior", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Repository navigation" })
    .getByRole("link", { name: "Changes" })
    .click();
  await expect(page.getByRole("tab", { name: /^All/ })).toContainText("120");
  await expect(page.getByRole("tab", { name: /^Open/ })).toContainText("105");
});
