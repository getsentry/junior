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
  await expect(page).toHaveTitle(/^\(\d+\) getsentry\/junior - Junior$/);
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
        // Every listed change is active. The one idle change is past the
        // limit, so only the summary counts it.
        changes: Array.from({ length: 100 }, (_, index) => ({
          ...report.changes[0],
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          lastActivityAt: report.generatedAt,
          number: index + 1,
          state: "open",
        })),
        summary: { ...report.summary, idle: 1, open: 105 },
      },
    });
  });
  // The open changes fill the list, so the Closed tab loads its own rows.
  await page.route(/\/api\/code\/repositories\/[^/]+$/, async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    const state = new URL(route.request().url()).searchParams.get("state");
    const changes = (count: number, changeState: string, title: string) =>
      Array.from({ length: count }, (_, index) => ({
        draft: false,
        id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
        number: index + 1,
        openedAt: report.generatedAt,
        provider: "github",
        repository: report.repository.name,
        state: changeState,
        title: `${title} ${index + 1}`,
        url: `https://github.com/${report.repository.name}/pull/${index + 1}`,
      }));
    await route.fulfill({
      response,
      json: {
        ...report,
        changeCounts: { closed: 12, merged: 3, open: 105 },
        changes:
          state === "closed"
            ? changes(12, "closed", "Closed change")
            : changes(100, "open", "Open change"),
      },
    });
  });

  await page.goto(`${dashboard.baseURL}/conversations/new`);
  const week = page.getByRole("region", { name: "Your week" });
  await expect(week.getByText("105", { exact: true })).toBeVisible();
  await expect(week.getByText("1 idle 7d+")).toBeVisible();
  await expect(week.getByText("all moving")).toHaveCount(0);

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
  await page.getByRole("tab", { name: /^Closed/ }).click();
  await expect(
    page.getByRole("link", { name: "Closed change 12" }),
  ).toBeVisible();
  await expect(page.getByText("No changes match this state.")).toHaveCount(0);
});

test("opens Linked work toward the larger free space", async ({
  page,
  dashboard,
}) => {
  // The first repository conversation sits about 500px from the top.
  for (const { height, side } of [
    { height: 1400, side: "bottom" },
    { height: 600, side: "top" },
  ]) {
    await page.setViewportSize({ height, width: 1600 });
    await page.goto(`${dashboard.baseURL}/code`);
    await page
      .getByRole("link", { name: "getsentry/junior", exact: true })
      .click();
    // Some browsers default to a root font smaller than 16px.
    await page.addStyleTag({ content: "html { font-size: 14px }" });
    await page
      .getByLabel(/^Linked work, newest first/)
      .first()
      .hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("Linked work");
    await expect(tooltip).toHaveAttribute("data-side", side);
  }
});
