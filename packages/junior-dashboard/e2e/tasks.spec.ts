import { expect, test } from "./test";
import { captureDashboardScreenshots } from "./screenshot";

test("opens scheduled and event tasks in the native Tasks view", async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.baseURL);

  await page.getByRole("link", { name: "Tasks" }).click();

  await expect(page).toHaveURL(`${dashboard.baseURL}/tasks`);
  await expect(page.getByLabel("Tasks navigation")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(
    page.getByLabel("Task executions during the last 30 days"),
  ).toBeVisible();
  await captureDashboardScreenshots(page, "tasks");
  await expect(
    page.getByLabel("Task execution spend during the last 30 days"),
  ).toBeVisible();
  await expect(page.getByText("Total tasks")).toBeVisible();
  await expect(page.getByText("Your tasks")).toBeVisible();
  await expect(page.getByText("Public tasks")).toBeVisible();
  await expect(page.getByText("Private tasks")).toBeVisible();
  const reportingPeriod = page.getByLabel("Reporting period");
  await expect(reportingPeriod).toHaveCount(1);
  await reportingPeriod.getByRole("button", { name: "7d" }).click();
  await expect(page).toHaveURL(/[?&]range=7(?:&|$)/);
  await expect(
    page.getByLabel("Task executions during the last 7 days"),
  ).toBeVisible();
  await expect(
    page.getByLabel("Task execution spend during the last 7 days"),
  ).toBeVisible();
  await expect(page.getByText("2 tasks")).not.toBeVisible();
  await expect(page.getByText("Weekly project summary")).not.toBeVisible();
  await page
    .getByLabel("Tasks navigation")
    .getByRole("link", { name: "Tasks" })
    .click();
  await expect(page).toHaveURL(/\/tasks\/list(?:\?|$)/);
  await expect(page).toHaveURL(/[?&]range=7(?:&|$)/);
  await expect(page.getByRole("heading", { name: "All tasks" })).toBeVisible();
  await expect(page.getByLabel("Search tasks")).toBeVisible();
  await captureDashboardScreenshots(page, "tasks-list");
  const listReportingPeriod = page.getByLabel("Reporting period");
  await expect(listReportingPeriod).toHaveCount(1);
  await expect(
    listReportingPeriod.getByRole("button", { name: "7d" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByLabel("Task executions during the last 7 days"),
  ).toBeVisible();
  await expect(
    page.getByLabel("Task execution spend during the last 7 days"),
  ).toBeVisible();
  await expect(page.getByText("2 tasks")).toBeVisible();
  await expect(page.getByText("Weekly project summary")).toBeVisible();
  await expect(page.getByText("Closed issue summary")).toBeVisible();
  await expect(page.getByLabel("Scheduled task")).toBeVisible();
  await expect(page.getByLabel("GitHub event task")).toBeVisible();
  await expect(page.getByText("#project-updates").last()).toBeVisible();
  // Assert the range-aware run count on the row. Bare "Runs" also matches nav.
  const weeklyRow = page
    .getByRole("listitem")
    .filter({ hasText: "Weekly project summary" });
  await expect(weeklyRow).toContainText("3");
  await listReportingPeriod.getByRole("button", { name: "30d" }).click();
  await expect(page).toHaveURL(/\/tasks\/list(?:\?|$)/);
  await expect(weeklyRow).toContainText("12");
  await expect(page.getByText("Assigned to")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const taskDetailsTrigger = page.getByRole("button", {
    name: "View task details: Weekly project summary",
  });
  await taskDetailsTrigger.click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/tasks/scheduled-1`);
  const details = page.getByRole("dialog", { name: "Weekly project summary" });
  await expect(details).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("hidden");
  const closeTaskDetails = details.getByRole("button", {
    name: "Close task details",
  });
  await expect(closeTaskDetails).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(closeTaskDetails).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeTaskDetails).toBeFocused();
  await expect(details.getByText("Instruction")).toBeVisible();
  await expect(
    details.getByText("Send the weekly project summary"),
  ).toBeVisible();
  await expect(details.getByRole("link", { name: "you" })).toHaveAttribute(
    "href",
    "/people/dev%40example.com",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(`${dashboard.baseURL}/tasks/list`);
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");
  await expect(taskDetailsTrigger).toBeFocused();
  await expect(page.getByText("Incident change alerts")).not.toBeVisible();
  await page.getByRole("button", { name: "event", exact: true }).click();
  await expect(page.getByText("Weekly project summary")).not.toBeVisible();
  await expect(page.getByText("Closed issue summary")).toBeVisible();
  await page.getByRole("button", { name: /^Public/ }).click();
  await expect(page.getByText("Incident change alerts")).toBeVisible();
  await expect(page.getByText("#incident-response").last()).toBeVisible();
  await page
    .getByRole("button", {
      name: "View task details: Incident change alerts",
    })
    .click();
  const publicDetails = page.getByRole("dialog");
  await expect(publicDetails).toBeVisible();
  const creatorLink = publicDetails.getByRole("link", { name: "Avery Chen" });
  await expect(creatorLink).toHaveAttribute(
    "href",
    "/people/avery%40sentry.io",
  );
  await expect(page.getByLabel("PagerDuty event task")).toBeVisible();
  await expect(page.getByText("Memory system")).not.toBeVisible();
  await creatorLink.click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/people/avery%40sentry.io`);
  await expect(page.getByRole("heading", { name: "Avery Chen" })).toBeVisible();
});

test("lists runs across tasks", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/tasks/runs`);

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByLabel("Search runs")).toBeVisible();
  await captureDashboardScreenshots(page, "tasks-runs");
  await expect(page.getByRole("group", { name: "Type" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Status" })).toBeVisible();
  await expect(page.getByText("Weekly project summary").first()).toBeVisible();
  await expect(page.getByText("$0.42").first()).toBeVisible();
  await expect(page.getByText("42s").first()).toBeVisible();
  await expect(page.getByText("1.2k").first()).toBeVisible();
  await expect(page.getByLabel("Scheduled task").first()).toBeVisible();
  await expect(
    page.locator('[title="completed"]:visible').first(),
  ).toBeVisible();
  await expect(
    page.getByText("completed", { exact: true }).first(),
  ).toBeVisible();
});

test("opens one task's execution history", async ({ page, dashboard }) => {
  await page.goto(
    `${dashboard.baseURL}/tasks/scheduled/scheduled-1/executions`,
  );

  await expect(
    page.getByRole("heading", { name: "Weekly project summary" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Executions over time" }),
  ).toBeVisible();
  await captureDashboardScreenshots(page, "task-executions");
  const reportingPeriod = page.getByLabel("Reporting period");
  await expect(reportingPeriod).toHaveCount(1);
  await reportingPeriod.getByRole("button", { name: "90d" }).click();
  await expect(
    page.getByLabel("Task executions during the last 90 days"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Weekly project summary/ }),
  ).toBeVisible();
  await expect(
    page.locator('[title="completed"]:visible').first(),
  ).toBeVisible();
  await expect(page.getByText("$0.42").first()).toBeVisible();
  await expect(page.getByText("42s").first()).toBeVisible();
  await expect(page.getByText("1.2k").first()).toBeVisible();
  await expect(
    page.getByText("No conversation", { exact: true }),
  ).toBeVisible();
});
