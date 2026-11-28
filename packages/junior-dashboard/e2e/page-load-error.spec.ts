import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { DASHBOARD_VERSION_HEADER } from "../src/dashboard-version";
import { screenshot } from "./screenshot";

const AUTOMATIONS_CHUNK = "**/chunks/AutomationsPage-*.js";
const FAILURE_TEXT = "This page failed to load";

/** Count the page loads of the tab, so a test can see a reload. */
function countDocumentLoads(page: Page) {
  const loads: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") loads.push(request.url());
  });
  return loads;
}

/** Fail each load of the Automations page code, as after a deploy. */
async function failAutomationsChunk(page: Page) {
  await page.route(AUTOMATIONS_CHUNK, (route) =>
    route.fulfill({ body: "Not found", status: 404 }),
  );
}

async function openAutomations(page: Page) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: /^Automations/ })
    .click();
}

test("a page whose code fails to load shows a reload, and the pane stays", async ({
  page,
  dashboard,
}) => {
  const loads = countDocumentLoads(page);
  await failAutomationsChunk(page);
  await page.goto(`${dashboard.baseURL}/inbox`);
  await openAutomations(page);

  // The server runs this tab's version, so a reload would not help.
  const failure = page.getByRole("alert").filter({ hasText: FAILURE_TEXT });
  await expect(failure).toBeVisible();
  await expect(failure.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Automations/ }),
  ).toHaveAttribute("aria-current", "page");
  expect(loads).toHaveLength(1);
  await screenshot(page, "page-load-error", { view: "desktop" });

  // Another page clears the error.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: /^Inbox/ })
    .click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/inbox`);
  await expect(failure).toHaveCount(0);

  // Reload loads the page code again.
  await openAutomations(page);
  await expect(failure).toBeVisible();
  await page.unroute(AUTOMATIONS_CHUNK);
  await failure.getByRole("button", { name: "Reload" }).click();
  await expect(
    page.getByRole("heading", { name: "Automations", exact: true }),
  ).toBeVisible();
  expect(loads).toHaveLength(2);
});

test("a page whose code is gone after a deploy reloads once to the new version", async ({
  page,
  dashboard,
}) => {
  const loads = countDocumentLoads(page);
  await failAutomationsChunk(page);
  await page.goto(`${dashboard.baseURL}/inbox`);
  // A deploy moved the server to a newer version.
  await page.route("**/api/versions*", (route) =>
    route.fulfill({
      headers: { [DASHBOARD_VERSION_HEADER]: "999.0.0" },
      json: {
        conversationDetails: {},
        conversations: "mock",
        inboxItems: "mock",
        spend: "mock",
      },
    }),
  );
  await openAutomations(page);

  // The tab reloads once. The code still fails on that version, so it
  // stops at the error instead of reloading again.
  const failure = page.getByRole("alert").filter({ hasText: FAILURE_TEXT });
  await expect(failure).toBeVisible();
  expect(loads).toEqual([
    `${dashboard.baseURL}/inbox`,
    `${dashboard.baseURL}/automations`,
  ]);
});
