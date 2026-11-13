import type { Locator, Page } from "@playwright/test";

import { mockAutomationCollection } from "../src/mock-reporting/automation-collection";
import { automationReport } from "./automation-fixture";
import { expect, test } from "./test";

const SLOTS = ["dot", "title", "summary", "meta"];

async function comfortable(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("junior:density", "comfortable"),
  );
}

// The head slots of a row, in DOM order.
function slots(row: Locator) {
  return row
    .locator("[data-inbox-slot]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-inbox-slot")),
    );
}

test("a comfortable row keeps its pills under its title and people", async ({
  dashboard,
  page,
}) => {
  await comfortable(page);
  await page.goto(`${dashboard.baseURL}/`);
  const row = page
    .getByRole("region", { name: "To do" })
    .getByRole("listitem")
    .filter({ hasText: "Package release and self-update" });
  const title = row.locator('[data-inbox-slot="title"]');
  // The pills follow the title in the title column, before the summary.
  await expect(
    title.getByRole("button", { name: "Review requested #91" }),
  ).toBeVisible();
  await expect(
    title.getByRole("button", { name: "Ready to merge #2201" }),
  ).toBeVisible();
  await expect.poll(() => slots(row)).toEqual(SLOTS);
});

test("a row's summary shows its links as chips", async ({
  dashboard,
  page,
}) => {
  await comfortable(page);
  await page.goto(`${dashboard.baseURL}/`);
  const summary = page
    .getByRole("region", { name: "To do" })
    .getByRole("listitem")
    .filter({ hasText: "Package release and self-update" })
    .locator('[data-inbox-slot="summary"]');
  // A person, a Conversation and a pull request each show their chip.
  await expect(summary.getByRole("link", { name: /Morgan Lee/ })).toBeVisible();
  await expect(
    summary.getByRole("link", { name: /Investigate checkout latency/ }),
  ).toBeVisible();
  await expect(summary.getByRole("link", { name: /payments/ })).toBeVisible();
  await expect(summary).not.toContainText("https://");
});

test("Automation rows use the Conversation rows' columns", async ({
  dashboard,
  page,
}) => {
  const report = structuredClone(automationReport);
  Object.assign(report.automations[0]!, { lastRunStatus: "failed" });
  Object.assign(report.automations[1]!, {
    lastRunStatus: "blocked",
    status: "blocked",
    statusReason: "GitHub access expired.",
  });
  await page.route(/\/api\/automations(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: mockAutomationCollection(
        report,
        new URL(route.request().url()).searchParams,
      ),
    }),
  );
  await comfortable(page);
  await page.goto(`${dashboard.baseURL}/`);
  const todo = page.getByRole("region", { name: "To do" });
  const failed = todo.getByRole("button", { name: /Weekly project summary/ });
  const blocked = todo.getByRole("button", { name: /Closed issue summary/ });
  await expect.poll(() => slots(failed)).toEqual(SLOTS);
  await expect.poll(() => slots(blocked)).toEqual(SLOTS);
  // The status says what happened, not only why the row is here.
  await expect(failed.locator('[data-inbox-slot="summary"]')).toContainText(
    /^Last run failed /,
  );
  await expect(blocked.locator('[data-inbox-slot="summary"]')).toHaveText(
    "Blocked · GitHub access expired.",
  );
});
