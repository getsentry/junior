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
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(documentRequests).toEqual([]);

  await page.goto(`${dashboard.baseURL}/tasks/list?range=7#history`);
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/automations/list?range=7#history`,
  );

  await page.goto(dashboard.baseURL);
  await page.getByRole("link", { name: "Automations" }).click();

  await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
  await expect(page.getByLabel("Automations navigation")).toBeVisible();
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
  await expect(
    page.getByText("Weekly project summary", { exact: true }),
  ).not.toBeVisible();
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
  await expect(page.getByLabel("Reporting period")).toHaveCount(0);
  await expect(page.getByText("2 automations")).toBeVisible();
  await expect(
    page.getByText("Weekly project summary", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Closed issue summary", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search automations").fill("closed issue");
  await expect(
    page.getByText("Weekly project summary", { exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByText("Closed issue summary", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search automations").fill("");
  await expect(
    page.getByText("Weekly project summary", { exact: true }),
  ).toBeVisible();
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
    `${dashboard.baseURL}/automations/scheduled-1?range=7`,
  );
  const details = page.getByRole("dialog", { name: "Weekly project summary" });
  await expect(details).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("hidden");
  const closeAutomationDetails = details.getByRole("button", {
    name: "Close automation details",
  });
  await expect(closeAutomationDetails).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(closeAutomationDetails).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeAutomationDetails).toBeFocused();
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
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations/list?range=7`);
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");
  await expect(automationDetailsTrigger).toBeFocused();
  const actions = page.getByRole("button", {
    name: "Actions: Weekly project summary",
  });
  await actions.focus();
  await page.keyboard.press("Enter");
  const deleteItem = page.getByRole("menuitem", {
    name: "Delete",
    exact: true,
  });
  await expect(deleteItem).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await expect(deleteItem).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(deleteItem).toBeFocused();
  const deletePath = "/api/automations/scheduled/scheduled-1";
  await page.route(`**${deletePath}`, (route) =>
    route.fulfill({ status: 500, json: { error: "Delete failed" } }),
  );
  page.once("dialog", (dialog) => dialog.accept());
  const deletion = page.waitForRequest(
    (request) =>
      request.url().endsWith(deletePath) && request.method() === "DELETE",
  );
  await deleteItem.click();
  await deletion;
  await expect(
    page.getByText("The automation could not be deleted. Try again."),
  ).toBeVisible();
  await expect(actions).toBeEnabled();
  await expect(page.getByText("Incident change alerts")).not.toBeVisible();
  await page.getByRole("button", { name: "event", exact: true }).click();
  await expect(
    page.getByText("Weekly project summary", { exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByText("Closed issue summary", { exact: true }),
  ).toBeVisible();
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
  const publicDetails = page.getByRole("dialog");
  await expect(publicDetails).toBeVisible();
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
});

test("lists runs across automations", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/automations/runs`);

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByLabel("Search runs")).toBeVisible();
  await screenshot(page, "automations-runs");
  await expect(page.getByRole("group", { name: "Type" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Status" })).toBeVisible();
  await expect(
    page.getByText("Weekly project summary", { exact: true }).first(),
  ).toBeVisible();
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
  await page.goto(
    `${dashboard.baseURL}/automations/scheduled/scheduled-1/executions`,
  );

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
