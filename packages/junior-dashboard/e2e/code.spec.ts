import { NOW_MS } from "../src/mock-reporting/fixtures";
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
  // Draft only shows on open changes; a merged change shows Merged.
  const recentChanges = page.locator("section", { hasText: "Recent changes" });
  await expect(recentChanges.getByText(/^draft$/i)).toHaveCount(1);
  await expect(recentChanges.getByText(/^merged$/i)).toHaveCount(1);
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

test("counts every change in the state tabs and loads each state", async ({
  page,
  dashboard,
}) => {
  const day = 86_400_000;
  const states: (string | null)[] = [];
  await page.route("**/api/code/repositories/*", async (route) => {
    const state = new URL(route.request().url()).searchParams.get("state");
    states.push(state);
    const response = await route.fetch();
    const report = await response.json();
    const idleChange = {
      draft: false,
      id: "00000000-0000-4000-8000-000000000099",
      lastActivityAt: new Date(NOW_MS - 10 * day).toISOString(),
      number: 990,
      openedAt: new Date(NOW_MS - 12 * day).toISOString(),
      provider: "github",
      repository: "getsentry/junior",
      state: "open",
      title: "Retry Slack uploads after a rate limit",
    };
    await route.fulfill({
      json: {
        ...report,
        // The report lists only some changes; the counts cover all of them.
        changeCounts: { closed: 2, merged: 40, open: 3 },
        changes: state === "open" ? [idleChange] : report.changes,
      },
      response,
    });
  });
  await page.goto(`${dashboard.baseURL}/code`);
  await page
    .getByRole("link", { name: "getsentry/junior", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Repository navigation" })
    .getByRole("link", { name: "Changes" })
    .click();

  const tabs = page.getByRole("tablist", { name: "Change state" });
  await expect(tabs.getByRole("tab", { name: "All 45" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "Merged 40" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "Closed 2" })).toBeVisible();

  await tabs.getByRole("tab", { name: "Open 3" }).click();
  const changes = page.getByRole("region", { name: "Changes" });
  await expect(
    changes.getByText("Retry Slack uploads after a rate limit"),
  ).toBeVisible();
  await expect(
    changes.getByText("Keep repository context across turns"),
  ).toHaveCount(0);
  expect(states).toContain("open");
  // The open change shows how long it has been idle.
  await changes.getByText("10d", { exact: true }).hover();
  await expect(
    page.getByText("Last activity 10d ago · opened 12d ago"),
  ).toBeVisible();
});
