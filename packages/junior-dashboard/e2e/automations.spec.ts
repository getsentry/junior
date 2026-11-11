import { mockAutomationEditor } from "./automation-editor-fixture";
import { automationReport } from "./automation-fixture";
import { mockLandingAutomationApis } from "./automation-landing-fixture";
import { mockAutomationCollection } from "../src/mock-reporting/automation-collection";
import { NOW } from "../src/mock-reporting/fixtures";
import { withRequestedMailbox } from "./harness";
import { expect, test } from "./test";
import { screenshot } from "./screenshot";
import type { Page } from "@playwright/test";

/** One option in a filter of the Automations filter panel or sheet. */
function filterOption(page: Page, filter: string, option: string) {
  return page
    .getByRole("group", { name: `Filter by ${filter}`, exact: true })
    .getByRole("button", { name: option, exact: true });
}

test("opens scheduled and event automations in the native Automations view", async ({
  page,
  dashboard,
}) => {
  // Saved cards may refer to a different deployment. Stay in this dashboard.
  const conversationId = "automation-card";
  await page.route(`**/api/conversations/${conversationId}*`, async (route) => {
    const card = { key: "scheduled-1", kind: "object", plugin: "junior" };
    await route.fulfill({
      json: withRequestedMailbox(route, {
        annotations: [
          {
            ...card,
            createdAt: NOW,
            label: "Weekly release digest",
            objectType: "automation",
            title: "Weekly release digest",
            updatedAt: NOW,
            url: null,
          },
        ],
        conversationId,
        cumulativeDurationMs: 1_000,
        displayTitle: "Automation card",
        kind: "root",
        eventHistory: { status: "available" },
        events: [
          {
            createdAt: NOW,
            data: {
              cards: [card],
              messageId: `${conversationId}:reply`,
              role: "assistant",
              text: "I saved the weekly release digest.",
              type: "message",
            },
            seq: 0,
          },
        ],
        generatedAt: NOW,
        isParticipant: true,
        lastProgressAt: NOW,
        lastSeenAt: NOW,
        startedAt: NOW,
        status: "completed",
        surface: "internal",
      }),
    });
  });
  await page.goto(`${dashboard.baseURL}/conversations/${conversationId}`);
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
    page.getByRole("heading", { name: "Weekly project summary", exact: true }),
  ).toBeVisible();
  expect(documentRequests).toEqual([]);
  // Shared links can include a trailing slash, as accepted by the router.
  await page.goto(`${dashboard.baseURL}/automations/scheduled-1/?q=weekly`);
  await expect(
    page
      .getByRole("navigation", { name: "Automation navigation" })
      .getByRole("link", { name: "Overview", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Back to automations" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations?q=weekly`);

  // The list moved to the landing page; old list links still land there.
  await page.goto(`${dashboard.baseURL}/tasks/list?type=event#history`);
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations?type=event#history`,
  );

  await page.goto(dashboard.baseURL);
  await page.getByRole("link", { name: "Automations" }).click();

  await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
  await expect(
    page.getByRole("navigation", { name: "Automations navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Automations", exact: true }),
  ).toBeVisible();
  // Problems lead the page, each with the link that fixes it.
  const attention = page.getByRole("region", { name: "Needs attention" });
  await expect(attention.getByRole("listitem")).toHaveCount(1);
  await expect(attention).toContainText("Incident change alerts");
  await expect(
    attention.getByRole("link", { name: "Change trigger", exact: true }),
  ).toHaveAttribute("href", "/automations/event-2/edit");
  const active = page.getByRole("main").getByRole("region", { name: "Active" });
  await expect(active.getByRole("listitem")).toHaveCount(2);
  await screenshot(page, "automations");
  const weeklySummary = page
    .getByRole("main")
    .getByText("Weekly project summary", {
      exact: true,
    });
  const issueSummary = page
    .getByRole("main")
    .getByText("Closed issue summary", { exact: true });
  await expect(weeklySummary).toBeVisible();
  await expect(issueSummary).toBeVisible();
  await expect(page.getByLabel("Scheduled automation")).toBeVisible();
  await expect(page.getByLabel("github event automation")).toBeVisible();
  await expect(page.getByText("#project-updates").last()).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const openWeekly = page.getByRole("link", {
    name: "Open automation: Weekly project summary",
  });
  await openWeekly.click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations/scheduled-1`);
  await expect(
    page.getByRole("heading", { name: "Weekly project summary", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Automation state" }),
  ).toHaveText("active");
  await expect(
    page.getByText("Send the weekly project summary", { exact: true }),
  ).toBeVisible();
  const rail = page.getByRole("complementary", { name: "Automation details" });
  const cost = rail.getByRole("region", { name: "Cost" });
  await expect(cost).toContainText("$18.62 · 48 runs");
  await expect(cost.getByText("$4.18", { exact: true })).toBeVisible();
  // 30-day spend over 12 runs in that window.
  await expect(cost.getByText("$0.35", { exact: true })).toBeVisible();
  const recentRuns = page.getByRole("region", {
    name: "Recent runs",
    exact: true,
  });
  await expect(recentRuns.getByRole("listitem")).toHaveCount(3);
  await expect(
    recentRuns.getByRole("link", { name: /^Open completed run/ }),
  ).toHaveAttribute("href", /\/automations\/scheduled-1\/runs\?run=/);
  await expect(
    recentRuns.getByRole("link", { name: "Open conversation" }).first(),
  ).toHaveAttribute("href", "/conversations/scheduler%3Adaily-ops-digest");
  await expect(
    recentRuns.getByText("42s · $0.42", { exact: true }),
  ).toBeVisible();
  await expect(rail.getByRole("link", { name: "You" })).toHaveAttribute(
    "href",
    "/people/dev%40example.com",
  );
  await screenshot(page, "automation-page", {
    view: "desktop",
    lightTheme: true,
  });
  await page.getByRole("link", { name: "Back to automations" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
  await openWeekly.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "About pausing", exact: true })
    .click();
  const pausePopover = page.getByRole("dialog", {
    name: "About pausing",
    exact: true,
  });
  await expect(pausePopover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pausePopover).toBeHidden();
  await screenshot(page, "automation-page-mobile", {
    view: "mobile",
    lightTheme: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const deleteButton = page
    .getByRole("group", { name: "Automation actions" })
    .getByRole("button", { name: "Delete automation", exact: true });
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
  await page.getByRole("link", { name: "Back to automations" }).click();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await filterOption(page, "type", "Event").click();
  await filterOption(page, "creator", "Morgan").click();
  await expect(page).toHaveURL(/[?&]type=event(?:&|$)/);
  await expect(page).toHaveURL(/[?&]creator=dev%40example.com(?:&|$)/);
  await expect(filterOption(page, "type", "Event")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Close filters" }).click();
  await expect(
    page.getByRole("complementary", { name: "Filters" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Remove creator filter", exact: true })
    .click();
  await expect(page).toHaveURL(/[?&]type=event(?:&|$)/);
  await expect(weeklySummary).not.toBeVisible();
  await expect(issueSummary).toBeVisible();
  await expect(
    page.getByRole("main").getByText("Incident change alerts"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Actions: Incident change alerts" }),
  ).toHaveCount(0);
  await expect(page.getByText("#incident-response").last()).toBeVisible();
  await expect(page.getByLabel("pagerduty event automation")).toBeVisible();
  await page
    .getByRole("link", { name: "Open automation: Incident change alerts" })
    .click();
  // Public readers can edit, pause, and delete.
  await expect(
    page.getByRole("link", { name: "Edit automation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete automation", exact: true }),
  ).toBeVisible();
  const publicRail = page.getByRole("complementary", {
    name: "Automation details",
  });
  await expect(
    publicRail.getByText(
      /Only Avery Chen can turn on their connected accounts/,
    ),
  ).toBeVisible();
  const creatorLink = publicRail.getByRole("link", { name: "Avery Chen" });
  await expect(creatorLink).toHaveAttribute(
    "href",
    "/people/avery%40sentry.io",
  );
  await expect(
    page.getByRole("main").getByText("Memory system"),
  ).not.toBeVisible();
  await creatorLink.click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/people/avery%40sentry.io`);
  await expect(page.getByRole("heading", { name: "Avery Chen" })).toBeVisible();
});

test("restores shared Automation list and page URLs, recovers failed loads, and deletes the Automation", async ({
  page,
  dashboard,
}) => {
  const heading = page.getByRole("heading", {
    name: "Weekly project summary",
    exact: true,
  });
  const recentRuns = page.getByRole("region", {
    name: "Recent runs",
    exact: true,
  });
  const weeklySummary = page
    .getByRole("main")
    .getByText("Weekly project summary", {
      exact: true,
    });
  const openWeekly = page.getByRole("link", {
    name: "Open automation: Weekly project summary",
  });
  const backToList = page.getByRole("link", { name: "Back to automations" });
  const active = page.getByRole("main").getByRole("region", { name: "Active" });
  const deleteButton = page
    .getByRole("group", { name: "Automation actions" })
    .getByRole("button", { name: "Delete automation", exact: true });
  const confirmation = page.getByRole("alertdialog", {
    name: "Delete automation?",
    exact: true,
  });

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
  const listUrl = `${dashboard.baseURL}/automations?type=scheduled&creator=dev%40example.com`;
  await page.goto(`${listUrl}&state=invalid`);
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(filterOption(page, "state", "All")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Close filters" }).click();
  // Groups show every match at once, so there are no page controls.
  await page.goto(listUrl);
  await expect(active.getByRole("listitem")).toHaveCount(31);
  await page.reload();
  await expect(active.getByRole("listitem")).toHaveCount(31);
  // Old scope, sort, and page links fall back to every Automation.
  await page.goto(
    `${dashboard.baseURL}/automations?scope=mine&sort=title&page=2`,
  );
  await expect(
    page.getByRole("region", { name: "Needs attention" }),
  ).toContainText("Incident change alerts");
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
  await page.goto(
    listUrl.replace("/automations?", "/automations/scheduled-1?"),
  );
  await expect(
    page.getByText("Loading automation", { exact: true }),
  ).toBeAttached();
  pendingDetail.resolve();
  await expect(
    page.getByText("Automation could not be loaded.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(heading).toBeVisible();
  await expect(recentRuns.getByRole("alert")).toContainText(
    "Recent runs could not be loaded.",
  );
  await recentRuns
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(recentRuns.getByRole("listitem")).toHaveCount(3);
  await backToList.click();
  await expect(page).toHaveURL(listUrl);
  await expect(active.getByRole("listitem")).toHaveCount(31);
  await page.getByRole("button", { name: /^Filters/ }).click();
  await filterOption(page, "destination", "#project-updates").click();
  await filterOption(page, "state", "Active").click();
  await expect(page).toHaveURL(/state=active/);
  await page.getByRole("button", { name: "Close filters" }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Remove creator filter", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(filterOption(page, "creator", "Morgan")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Close filters" }).click();
  const setState = async (state: string) => {
    await page.getByRole("button", { name: /^Filters/ }).click();
    await filterOption(page, "state", state).click();
    await page.getByRole("button", { name: "Close filters" }).click();
  };
  delayList = true;
  await setState("Blocked");
  await expect(page.getByText("Updating results…")).toBeVisible();
  await expect(weeklySummary).toBeVisible();
  delayList = false;
  pendingList.resolve();
  await expect(
    page.getByText("No automations matched these filters."),
  ).toBeVisible();
  failList = true;
  // A filter not read yet, so the list cannot come from the cache.
  await setState("Paused");
  await expect(
    page.getByText("Automations could not be loaded."),
  ).toBeVisible();
  failList = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("Automations could not be loaded."),
  ).toBeHidden();
  await setState("Active");
  await expect(weeklySummary).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileFilters = page.getByRole("button", { name: /^Filters/ });
  await expect(mobileFilters).toHaveAttribute("aria-expanded", "false");
  await expect(mobileFilters).toHaveText(/Filters\s*4$/);
  await expect(
    page.getByRole("group", { name: "Filter by creator" }),
  ).toHaveCount(0);
  await mobileFilters.click();
  await expect(
    page.getByRole("dialog", { name: "Filters", exact: true }),
  ).toBeVisible();
  // The modal sheet hides the page behind it, including the trigger.
  await expect(
    page.getByRole("button", { name: /^Filters/, includeHidden: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await filterOption(page, "state", "Blocked").click();
  await expect(
    page.getByText("No automations matched these filters."),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Filters", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.reload();
  await expect(mobileFilters).toHaveText(/Filters\s*4$/);
  await mobileFilters.click();
  await expect(filterOption(page, "state", "Blocked")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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

  // Deleting the Automation returns to the list it came from.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${dashboard.baseURL}/automations/scheduled-1?type=scheduled`,
  );
  await expect(heading).toBeVisible();
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
    `${dashboard.baseURL}/automations?type=scheduled`,
  );
  await expect(
    page.getByText("Automation deleted", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Automations", exact: true }),
  ).toBeVisible();
  await expect(openWeekly).toHaveCount(0);
});

test("lists runs across automations", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/automations/runs`);

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByLabel("Search runs")).toBeVisible();
  await screenshot(page, "automations-runs");
  await expect(page.getByRole("button", { name: /^Filters/ })).toBeVisible();
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

  // Filters open beside the list and push it left.
  await page.getByRole("button", { name: /^Filters/ }).click();
  const filters = page.getByRole("complementary", { name: "Filters" });
  await expect(filters).toBeVisible();
  await filterOption(page, "status", "Failed").click();
  await expect(page).toHaveURL(/status=failed/);

  // Rows open run details in a slide-out panel over the list and filters.
  // The row link still opens the Conversation.
  const firstRow = page.locator("[data-run-id]").first();
  const runId = await firstRow.getAttribute("data-run-id");
  await expect(
    firstRow.getByRole("link", { name: "Open conversation" }),
  ).toHaveAttribute("href", /^\/conversations\//);
  await firstRow.getByRole("button").click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/runs?status=failed&run=${encodeURIComponent(runId!)}`,
  );
  const details = page.getByRole("dialog", { name: "Run details" });
  // The Runs list spans Automations, so details name the Automation.
  await expect(details.getByText("Automation", { exact: true })).toBeVisible();
  await expect(
    details.getByRole("link", { name: "Open conversation" }),
  ).toBeVisible();
  await screenshot(page, "automations-runs-filters", { view: "desktop" });
  await details.getByRole("button", { name: "Close run details" }).click();
  await expect(details).toHaveCount(0);
  await expect(filters).toBeVisible();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/runs?status=failed`,
  );
});

test("opens one automation's runs, filters by result, and redirects old history links", async ({
  page,
  dashboard,
}) => {
  await page.goto(
    `${dashboard.baseURL}/automations/scheduled-1/executions?scope=mine`,
  );
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/scheduled-1/runs?scope=mine`,
  );
  await page.goto(`${dashboard.baseURL}/automations/scheduled-1/runs`);

  await expect(
    page.getByRole("heading", { name: "Weekly project summary" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Automation navigation" })
      .getByRole("link", { name: "Runs", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Runs over time" }),
  ).toBeVisible();
  await screenshot(page, "automation-runs");
  const reportingPeriod = page.getByLabel("Reporting period");
  await expect(reportingPeriod).toHaveCount(1);
  await reportingPeriod.getByRole("button", { name: "90d" }).click();
  await expect(
    page.getByLabel("Automation executions during the last 90 days"),
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
  await expect(
    page
      .locator('[data-run-id="scheduled-1-run-1"]')
      .getByRole("link", { name: "Open conversation" }),
  ).toHaveAttribute(
    "href",
    `/conversations/${encodeURIComponent("scheduler:daily-ops-digest")}`,
  );

  // A row opens run details instead of the Conversation.
  const failedRun = page.getByRole("button", {
    name: /Ship notes for the release train/,
  });
  await failedRun.click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/scheduled-1/runs?range=90&run=scheduled-1-run-2`,
  );
  await expect(failedRun).toHaveAttribute("aria-expanded", "true");
  const details = page.getByRole("dialog", { name: "Run details" });
  await expect(
    details.getByRole("heading", { name: "Ship notes for the release train" }),
  ).toBeVisible();
  await expect(details.getByText("Automation", { exact: true })).toHaveCount(0);
  await expect(
    details.getByText("Slack rejected the result message: channel_not_found."),
  ).toBeVisible();
  await expect(
    details.getByText("Creator’s connected accounts", { exact: true }),
  ).toBeVisible();
  await expect(
    details.getByRole("link", { name: "Version 3" }),
  ).toHaveAttribute("href", "/automations/scheduled-1/versions?version=3");
  await expect(
    details.getByRole("link", { name: "Open conversation" }),
  ).toHaveAttribute(
    "href",
    `/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`,
  );
  await screenshot(page, "automation-run-details", { lightTheme: true });

  // Up and Down move the selection while details are open.
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/run=scheduled-1-run-3$/);
  await expect(
    details.getByText("No Conversation was recorded for this run."),
  ).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page).toHaveURL(/run=scheduled-1-run-1$/);
  const firstRun = page.getByRole("button", {
    name: /Weekly project summary/,
  });

  await page.getByRole("button", { name: "Close run details" }).click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/scheduled-1/runs?range=90`,
  );
  await expect(details).toBeHidden();

  // The result filter lives in the URL and explains failed runs inline.
  const result = page.getByRole("tablist", { name: "Run result" });
  await result.getByRole("tab", { name: /^Failed/ }).click();
  await expect(page).toHaveURL(/[?&]result=failed(?:&|$)/);
  await expect(failedRun).toBeVisible();
  await expect(firstRun).toHaveCount(0);
  await expect(
    page.getByText("Slack rejected the result message: channel_not_found.", {
      exact: true,
    }),
  ).toBeVisible();
  // A filter that hides the open run keeps its details.
  await result.getByRole("tab", { name: /^Completed/ }).click();
  await failedRun.waitFor({ state: "detached" });
  await page.goto(`${page.url()}&run=scheduled-1-run-2`);
  await expect(
    details.getByText("Ship notes for the release train").first(),
  ).toBeVisible();
  await expect(details.getByText(/not in the loaded runs/)).toHaveCount(0);
  await page.getByRole("button", { name: "Close run details" }).click();
  await result.getByRole("tab", { name: /^Failed/ }).click();
  await result.getByRole("tab", { name: /^All/ }).click();
  await expect(page).not.toHaveURL(/[?&]result=/);
  await expect(firstRun).toBeVisible();
});

test("pauses and resumes from the Automation page, keeps failures visible, and lets public readers pause", async ({
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
  await page.goto(`${dashboard.baseURL}/automations`);
  const attention = page.getByRole("region", { name: "Needs attention" });
  // A failed last run moves the Automation into the attention group.
  await expect(attention).toContainText("Weekly project summary");
  await expect(
    attention.getByRole("link", { name: "Open last run", exact: true }),
  ).toBeVisible();
  await screenshot(page, "automation-attention");
  await page
    .getByRole("link", { name: "Open automation: Weekly project summary" })
    .click();
  // A failed last run leads the page with one notice.
  await expect(
    page.getByText("Last run failed", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByText("The Automation changed. Try again."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Automation state" }),
  ).toHaveText("paused");
  await expect(
    page.getByText("No runs until resumed", { exact: true }),
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
  await page.getByRole("link", { name: "Back to automations" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
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
    .getByRole("link", { name: "Open automation: Incident change alerts" })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No runs yet. Results will appear here after the first run.",
      { exact: true },
    ),
  ).toBeVisible();
  // The page lists why the saved trigger cannot work.
  await expect(
    page.getByText("The plugin for this source is not enabled."),
  ).toBeVisible();
  await expect(
    page.getByText("Edit the trigger, or enable its plugin again."),
  ).toBeVisible();
  // The notice owns the fix, so it opens edit mode.
  await page.getByRole("link", { name: "Change trigger", exact: true }).click();
  await expect(page).toHaveURL(/\/automations\/event-2\/edit/);
});

test("groups automations by what needs attention on the landing page", async ({
  page,
  dashboard,
}) => {
  await mockLandingAutomationApis(page);
  await page.goto(`${dashboard.baseURL}/automations`);
  await expect(
    page.getByRole("region", { name: "Needs attention" }),
  ).toBeVisible();
  await screenshot(page, "automations-landing", { lightTheme: true });

  // Filters open in a column beside the list, and every option is visible.
  await page.getByRole("button", { name: /^Filters/ }).click();
  const filters = page.getByRole("complementary", { name: "Filters" });
  await filters
    .getByRole("group", { name: "Filter by type" })
    .getByRole("button", { name: "Event", exact: true })
    .click();
  await expect(page).toHaveURL(/[?&]type=event(?:&|$)/);
  await expect(
    page.getByRole("link", { name: "Open automation: CVE sweep" }),
  ).toHaveCount(0);
  await screenshot(page, "automations-filters");
  await filters.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]type=/);

  // A long instruction stays in the main column, clamped until expanded.
  await page.goto(`${dashboard.baseURL}/automations/post-merge-cleanup`);
  await expect(
    page.getByRole("button", { name: "Expand instruction", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "Recent runs" })
    .getByRole("img")
    .getByRole("link")
    .last()
    .hover();
  await expect(page.getByRole("tooltip")).toContainText("Duration");
  await screenshot(page, "automation-details-long-instruction", {
    view: "desktop",
  });

  await page.goto(`${dashboard.baseURL}/automations/cve-sweep`);
  await expect(
    page.getByRole("heading", { name: "CVE sweep", exact: true }),
  ).toBeVisible();
  await screenshot(page, "automation-details-failing", { lightTheme: true });

  await page.goto(`${dashboard.baseURL}/automations/streaming-oncall`);
  await expect(
    page.getByRole("heading", { name: "Streaming on-call check", exact: true }),
  ).toBeVisible();
  await screenshot(page, "automation-details-healthy");
});
