import { mockAutomationEditor } from "./automation-editor-fixture";
import { automationReport } from "./automation-fixture";
import { mockAutomationCollection } from "../src/mock-reporting/automation-collection";
import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("opens scheduled and event automations in the native Automations view", async ({
  page,
  dashboard,
}) => {
  // Saved cards may refer to a different deployment. Stay in this dashboard.
  await page.goto(`${dashboard.baseURL}/dev/transcripts`);
  const cardLink = page
    .getByRole("region", { name: "Weekly release digest" })
    .getByRole("link", { name: "Open automation", exact: true });
  await expect(cardLink).toHaveAttribute("href", "/automations/scheduled-1");
  const documentRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document")
      documentRequests.push(request.url());
  });
  await cardLink.click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations/scheduled-1`);
  await expect(
    page.getByRole("complementary", { name: "Automation details" }),
  ).toBeVisible();
  expect(documentRequests).toEqual([]);
  // Shared links can include a trailing slash, as accepted by the router.
  await page.goto(`${dashboard.baseURL}/automations/scheduled-1/?scope=mine`);
  await expect(
    page.getByRole("complementary", { name: "Automation details" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Automations navigation" })
      .getByRole("link", { name: "Automations", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Close automation details" }).click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/list?scope=mine`,
  );

  await page.goto(`${dashboard.baseURL}/tasks/list?range=7#history`);
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/list?range=7#history`,
  );

  await page.goto(dashboard.baseURL);
  await page.getByRole("link", { name: "Automations" }).click();

  await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
  await expect(
    page.getByRole("navigation", { name: "Automations navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Automations" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Automation executions during the last 30 days"),
  ).toBeVisible();
  await screenshot(page, "automations");
  await expect(
    page.getByLabel("Automation execution spend during the last 30 days"),
  ).toBeVisible();
  await expect(page.getByText("Total automations")).toBeVisible();
  await expect(page.getByText("Your automations")).toBeVisible();
  await expect(page.getByText("Public automations")).toBeVisible();
  await expect(page.getByText("Private automations")).toBeVisible();
  const reportingPeriod = page.getByLabel("Reporting period");
  await expect(reportingPeriod).toHaveCount(1);
  await reportingPeriod.getByRole("button", { name: "7d" }).click();
  await expect(page).toHaveURL(/[?&]range=7(?:&|$)/);
  await expect(
    page.getByLabel("Automation executions during the last 7 days"),
  ).toBeVisible();
  await expect(
    page.getByLabel("Automation execution spend during the last 7 days"),
  ).toBeVisible();
  await expect(page.getByText("2 automations")).not.toBeVisible();
  const weeklySummary = page.getByText("Weekly project summary", {
    exact: true,
  });
  const issueSummary = page.getByText("Closed issue summary", { exact: true });
  await expect(weeklySummary).not.toBeVisible();
  await page
    .getByLabel("Automations navigation")
    .getByRole("link", { name: "Automations" })
    .click();
  await expect(page).toHaveURL(/\/automations\/list(?:\?|$)/);
  await expect(page).toHaveURL(/[?&]range=7(?:&|$)/);
  await expect(
    page.getByRole("heading", { name: "All automations" }),
  ).toBeVisible();
  await expect(page.getByLabel("Search automations")).toBeVisible();
  await screenshot(page, "automations-list");
  await page.getByRole("button", { name: /^Mine/ }).click();
  await expect(page.getByLabel("Reporting period")).toHaveCount(0);
  await expect(page.getByText("2 automations")).toBeVisible();
  await expect(weeklySummary).toBeVisible();
  await expect(issueSummary).toBeVisible();
  await page.getByLabel("Search automations").fill("closed issue");
  await expect(weeklySummary).not.toBeVisible();
  await expect(issueSummary).toBeVisible();
  await page.getByLabel("Search automations").fill("");
  await expect(weeklySummary).toBeVisible();
  await expect(page.getByLabel("Scheduled automation")).toBeVisible();
  await expect(page.getByLabel("github event automation")).toBeVisible();
  await expect(page.getByText("#project-updates").last()).toBeVisible();
  await expect(page.getByText("Assigned to")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const automationDetailsTrigger = page.getByRole("button", {
    name: "View automation details: Weekly project summary",
  });
  await automationDetailsTrigger.click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/scheduled-1?range=7&scope=mine`,
  );
  const details = page.getByRole("complementary", {
    name: "Automation details",
  });
  await expect(details).toBeVisible();
  await expect(automationDetailsTrigger).toBeFocused();
  await page
    .getByRole("button", {
      name: "View automation details: Closed issue summary",
    })
    .click();
  await expect(
    details.getByRole("heading", { name: "Closed issue summary", exact: true }),
  ).toBeVisible();
  await details.getByText("About this Automation", { exact: true }).click();
  await automationDetailsTrigger.click();
  await expect(
    details.getByRole("button", { name: "About this Automation", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/scheduled-1\?range=7&scope=mine/);
  await screenshot(page, "automation-details", {
    view: "desktop",
    lightTheme: true,
  });
  await expect(
    details.getByRole("region", { name: "Instructions", exact: true }),
  ).toBeVisible();
  await expect(
    details.getByText("Send the weekly project summary"),
  ).toBeVisible();
  const recentRuns = details.getByRole("region", {
    name: "Recent runs",
    exact: true,
  });
  await expect(recentRuns.getByRole("listitem")).toHaveCount(3);
  await expect(
    recentRuns.getByRole("link", { name: /^Open completed run/ }),
  ).toHaveAttribute("href", "/conversations/scheduler%3Adaily-ops-digest");
  await expect(
    recentRuns.getByText("42s · $0.42", { exact: true }),
  ).toBeVisible();
  await expect(details.getByText("Accounts", { exact: true })).toBeHidden();
  await details.getByRole("button", { name: /^Next run/ }).click();
  await expect(details.getByText("Your time", { exact: true })).toBeVisible();
  const about = details.getByRole("button", {
    name: "About this Automation",
    exact: true,
  });
  await about.focus();
  await page.keyboard.press("Space");
  await expect(about).toHaveAttribute("aria-expanded", "true");
  await expect(details.getByRole("link", { name: "you" })).toHaveAttribute(
    "href",
    "/people/dev%40example.com",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/list?range=7&scope=mine`,
  );
  await expect(automationDetailsTrigger).toBeFocused();
  await automationDetailsTrigger.click();
  await page.setViewportSize({ width: 390, height: 844 });
  const sheet = page.getByRole("dialog", {
    name: "Weekly project summary",
    exact: true,
  });
  await expect(sheet).toBeVisible();
  await sheet
    .getByRole("button", { name: "About pausing", exact: true })
    .click();
  const pausePopover = page.getByRole("dialog", {
    name: "About pausing",
    exact: true,
  });
  await expect(pausePopover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pausePopover).toBeHidden();
  await expect(sheet).toBeVisible();
  const closeSheet = sheet.getByRole("button", { name: "Close", exact: true });
  await closeSheet.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(closeSheet).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeSheet).toBeFocused();
  await screenshot(page, "automation-details-sheet", {
    view: "mobile",
    lightTheme: true,
  });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(automationDetailsTrigger).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("button", { name: /^Actions:/ })).toHaveCount(0);
  await automationDetailsTrigger.click();
  const deleteButton = details.getByRole("button", {
    name: "Delete automation",
    exact: true,
  });
  await deleteButton.click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Delete automation?",
    exact: true,
  });
  await expect(confirmation).toContainText("Weekly project summary");
  await expect(
    confirmation.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(details).toBeVisible();
  await expect(deleteButton).toBeFocused();
  await deleteButton.press("Enter");
  const deletePath = "/api/automations/scheduled-1";
  // The summary GET uses the same URL, so fail only the DELETE.
  await page.route(`**${deletePath}`, (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 500, json: { error: "Delete failed" } })
      : route.fallback(),
  );
  const deletion = page.waitForRequest(
    (request) =>
      request.url().endsWith(deletePath) && request.method() === "DELETE",
  );
  await confirmation
    .getByRole("button", { name: "Delete automation", exact: true })
    .click();
  await deletion;
  await expect(
    page.getByText("The automation could not be deleted. Try again."),
  ).toBeVisible();
  await expect(
    confirmation.getByRole("button", {
      name: "Delete automation",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByText("Automation deleted", { exact: true }),
  ).toHaveCount(0);
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(deleteButton).toBeFocused();
  await page.getByRole("button", { name: "Close automation details" }).click();
  await expect(page.getByText("Incident change alerts")).not.toBeVisible();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("button", { name: "event", exact: true }).click();
  await page.getByLabel("Filter by creator").selectOption("dev@example.com");
  await expect(page).toHaveURL(/[?&]type=event(?:&|$)/);
  await expect(page).toHaveURL(/[?&]creator=dev%40example.com(?:&|$)/);
  await expect(
    page.getByRole("button", { name: "event", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Remove creator filter", exact: true })
    .click();
  await expect(page).toHaveURL(/[?&]type=event(?:&|$)/);
  await expect(weeklySummary).not.toBeVisible();
  await expect(issueSummary).toBeVisible();
  await page.getByRole("button", { name: /^Public/ }).click();
  await expect(page.getByText("Incident change alerts")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Actions: Incident change alerts" }),
  ).toHaveCount(0);
  await expect(page.getByText("#incident-response").last()).toBeVisible();
  await page
    .getByRole("button", {
      name: "View automation details: Incident change alerts",
    })
    .click();
  const publicDetails = page.getByRole("complementary", {
    name: "Automation details",
  });
  await expect(publicDetails).toBeVisible();
  await publicDetails
    .getByText("About this Automation", { exact: true })
    .click();
  await expect(
    publicDetails.getByRole("button", {
      name: "Delete automation",
      exact: true,
    }),
  ).toHaveCount(0);
  const creatorLink = publicDetails.getByRole("link", { name: "Avery Chen" });
  await expect(creatorLink).toHaveAttribute(
    "href",
    "/people/avery%40sentry.io",
  );
  await expect(page.getByLabel("pagerduty event automation")).toBeVisible();
  await expect(page.getByText("Memory system")).not.toBeVisible();
  await creatorLink.click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/people/avery%40sentry.io`);
  await expect(page.getByRole("heading", { name: "Avery Chen" })).toBeVisible();

  // A shared, paged URL and direct details must not depend on the current page.
  const collection = {
    ...automationReport,
    automations: [
      ...automationReport.automations,
      ...Array.from({ length: 30 }, (_, index) => ({
        ...automationReport.automations[0]!,
        id: `scheduled-extra-${index}`,
        title: `Weekly summary ${String(index).padStart(2, "0")}`,
      })),
    ],
  };
  let failList = false;
  let delayList = false;
  const pendingList = Promise.withResolvers<void>();
  await page.route(/\/api\/automations(?:\?.*)?$/, async (route) => {
    if (delayList) await pendingList.promise;
    await route.fulfill(
      failList
        ? { status: 500, json: { error: "List unavailable" } }
        : {
            json: mockAutomationCollection(
              collection,
              new URL(route.request().url()).searchParams,
            ),
          },
    );
  });
  const listUrl = `${dashboard.baseURL}/automations/list?scope=mine&type=scheduled&sort=title&page=2`;
  await page.goto(`${listUrl}&state=invalid`);
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(page.getByLabel("Filter by state")).toHaveValue("");
  await page.keyboard.press("Escape");
  // List order stays visible without opening Filters.
  await expect(page.getByLabel("Sort automations")).toBeVisible();
  await expect(page.getByLabel("Sort automations")).toHaveValue("title");
  await page.goto(listUrl);
  await expect(page.getByText("Showing 26-31 of 31")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Showing 26-31 of 31")).toBeVisible();
  await page
    .getByLabel("Automations navigation")
    .getByRole("link", { name: "Overview" })
    .click();
  await expect(page.getByText("Total automations")).toBeVisible();
  await page
    .getByLabel("Automations navigation")
    .getByRole("link", { name: "Automations", exact: true })
    .click();
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByText("Showing 26-31 of 31")).toBeVisible();
  const pendingDetail = Promise.withResolvers<void>();
  let detailRequests = 0;
  await page.route("**/api/automations/scheduled-1", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    detailRequests += 1;
    if (detailRequests === 1) {
      await pendingDetail.promise;
      return route.fulfill({
        status: 503,
        json: { error: "Detail unavailable" },
      });
    }
    return route.fallback();
  });
  let failRuns = true;
  await page.route("**/api/automations/scheduled-1/executions", (route) => {
    if (!failRuns) return route.fallback();
    failRuns = false;
    return route.fulfill({
      status: 503,
      json: { error: "History unavailable" },
    });
  });
  await page.goto(listUrl.replace("/list?", "/scheduled-1?"));
  await expect(details.getByRole("status")).toHaveText(
    "Loading automation details",
  );
  pendingDetail.resolve();
  await expect(
    details.getByText(/Automation details could not be loaded/),
  ).toBeVisible();
  await details.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    details.getByRole("heading", {
      name: "Weekly project summary",
      exact: true,
    }),
  ).toBeVisible();
  await expect(recentRuns.getByRole("alert")).toContainText(
    "Recent runs could not be loaded.",
  );
  await recentRuns
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(recentRuns.getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "Close automation details" }).click();
  await expect(page).toHaveURL(listUrl);
  await expect(
    page.getByLabel("Automations list", { exact: true }),
  ).toBeFocused();
  await expect(page.getByText("Showing 26-31 of 31")).toBeVisible();
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page.getByText("Showing 1-25 of 31")).toBeVisible();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByLabel("Filter by creator").selectOption("dev@example.com");
  await page.getByLabel("Filter by destination").selectOption("T123:C123");
  await page.getByLabel("Filter by state").selectOption("active");
  await expect(page).toHaveURL(/state=active/);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Remove creator filter", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(page.getByLabel("Filter by creator")).toHaveValue(
    "dev@example.com",
  );
  await expect(page.getByLabel("Sort automations")).toHaveValue("title");
  await page.keyboard.press("Escape");
  delayList = true;
  await page.getByLabel("Search automations").fill("no match");
  await expect(page.getByText("Updating results…")).toBeVisible();
  await expect(weeklySummary).toBeVisible();
  delayList = false;
  pendingList.resolve();
  await expect(
    page.getByText("No automations matched these filters."),
  ).toBeVisible();
  failList = true;
  await page.getByLabel("Search automations").fill("weekly");
  await expect(
    page.getByText("Automations could not be loaded."),
  ).toBeVisible();
  failList = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(weeklySummary).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileFilters = page.getByRole("button", { name: /^Filters/ });
  await expect(mobileFilters).toHaveAttribute("aria-expanded", "false");
  await expect(mobileFilters).toHaveText("Filters (4)");
  await expect(page.getByLabel("Filter by creator")).not.toBeVisible();
  await mobileFilters.click();
  await expect(mobileFilters).toHaveAttribute("aria-expanded", "true");
  await page.getByLabel("Filter by state").selectOption("blocked");
  await expect(
    page.getByText("No automations matched these filters."),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Filters", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.reload();
  await expect(mobileFilters).toHaveText("Filters (4)");
  await mobileFilters.click();
  await expect(page.getByLabel("Filter by state")).toHaveValue("blocked");
  await page
    .getByRole("dialog", { name: "Filters", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove state filter", exact: true })
    .click();
  await expect(page).not.toHaveURL(/[?&]state=/);
  await expect(
    page.getByRole("button", { name: "Remove creator filter", exact: true }),
  ).toBeVisible();

  // Deleting the selected Automation must remove its details as well.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${dashboard.baseURL}/automations/scheduled-1?scope=mine&sort=title`,
  );
  await expect(details).toBeVisible();
  const finishDelete = Promise.withResolvers<void>();
  await page.route("**/api/automations/scheduled-1", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await finishDelete.promise;
    collection.automations = collection.automations.filter(
      (item) => item.id !== "scheduled-1",
    );
    return route.fulfill({ status: 204 });
  });
  await deleteButton.click();
  await confirmation
    .getByRole("button", { name: "Delete automation", exact: true })
    .click();
  await expect(
    confirmation.getByRole("button", { name: "Deleting…", exact: true }),
  ).toBeDisabled();
  await expect(
    confirmation.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeVisible();
  finishDelete.resolve();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/list?scope=mine&sort=title`,
  );
  await expect(details).toBeHidden();
  await expect(automationDetailsTrigger).toHaveCount(0);
  await expect(
    page.getByText("Automation deleted", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Automations list", { exact: true }),
  ).toBeFocused();
});

test("lists runs across automations", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/automations/runs`);

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByLabel("Search runs")).toBeVisible();
  await screenshot(page, "automations-runs");
  await expect(page.getByRole("group", { name: "Type" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Status" })).toBeVisible();
  await expect(page.getByText("Weekly project summary").first()).toBeVisible();
  await expect(page.getByText("$0.42").first()).toBeVisible();
  await expect(page.getByText("42s").first()).toBeVisible();
  await expect(page.getByText("1.2k").first()).toBeVisible();
  await expect(page.getByLabel("Scheduled automation").first()).toBeVisible();
  await expect(
    page.locator('[title="completed"]:visible').first(),
  ).toBeVisible();
  await expect(
    page.getByText("completed", { exact: true }).first(),
  ).toBeVisible();
});

test("opens one automation's execution history", async ({
  page,
  dashboard,
}) => {
  await page.goto(`${dashboard.baseURL}/automations/scheduled-1/executions`);

  await expect(
    page.getByRole("heading", { name: "Weekly project summary" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Executions over time" }),
  ).toBeVisible();
  await screenshot(page, "automation-executions");
  const reportingPeriod = page.getByLabel("Reporting period");
  await expect(reportingPeriod).toHaveCount(1);
  await reportingPeriod.getByRole("button", { name: "90d" }).click();
  await expect(
    page.getByLabel("Automation executions during the last 90 days"),
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

test("pauses and resumes from details, keeps failures visible, and limits actions to creators", async ({
  page,
  dashboard,
}) => {
  const editor = await mockAutomationEditor(page, "scheduled");
  const report = structuredClone(automationReport);
  const summary = report.automations.find(
    (automation) => automation.id === "scheduled-1",
  )!;
  summary.lastRunStatus = "failed";
  await page.route(/\/api\/automations(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: mockAutomationCollection(
        report,
        new URL(route.request().url()).searchParams,
      ),
    }),
  );
  await page.route("**/api/automations/scheduled-1", (route) =>
    route.fulfill({ json: summary }),
  );
  let fail = true;
  await page.route("**/api/automations/scheduled-1/lifecycle", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      revision: editor.value.revision,
    });
    if (fail) {
      fail = false;
      return route.fulfill({
        status: 409,
        json: {
          error: "The Automation changed. Try again.",
          code: "conflict",
        },
      });
    }
    const status =
      route.request().postDataJSON().action === "pause" ? "paused" : "active";
    summary.status = status;
    if (summary.kind === "scheduled" && status === "paused")
      delete summary.nextRunAt;
    editor.value = { ...editor.value, status, revision: "b".repeat(64) };
    return route.fulfill({ json: editor.value });
  });
  await page.goto(`${dashboard.baseURL}/automations/list?scope=attention`);
  await expect(
    page.getByRole("button", { name: "Needs attention" }),
  ).toHaveAttribute("aria-pressed", "true");
  await screenshot(page, "automation-attention");
  await page
    .getByRole("button", {
      name: "View automation details: Weekly project summary",
    })
    .click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByText("The Automation changed. Try again."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "Automation details" })
      .getByRole("status", { name: "Automation state" }),
  ).toHaveText("paused");
  await expect(
    page.getByText("No new runs while paused", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Automation paused", { exact: true }),
  ).toBeVisible();
  await screenshot(page, "automation-paused");
  const pauseHelp = page.getByRole("button", {
    name: "About pausing",
    exact: true,
  });
  await pauseHelp.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Pausing stops new runs/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/Pausing stops new runs/)).not.toBeVisible();
  const moreDetails = page.getByText("About this Automation", { exact: true });
  await moreDetails.click();
  await expect(page.getByText("Accounts", { exact: true })).toBeVisible();
  await moreDetails.click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Automation resumed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open last run", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close automation details" }).click();
  await expect(page).toHaveURL(/list\?scope=attention/);
  await page.route("**/api/automations/event-2/executions", (route) =>
    route.fulfill({
      json: {
        automation: report.automations.find((item) => item.id === "event-2"),
        executions: [],
        executionDays: [],
        truncated: false,
      },
    }),
  );
  await page
    .getByRole("button", {
      name: "View automation details: Incident change alerts",
    })
    .click();
  await expect(
    page.getByRole("button", { name: /^(Pause|Resume)$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "No runs yet. Results will appear here after the first run.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Enable its plugin or choose another event."),
  ).toBeVisible();
});
