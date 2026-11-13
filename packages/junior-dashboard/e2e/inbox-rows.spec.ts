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

test("a row's summary shows its links as titled links", async ({
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
  // A person shows a chip. A Conversation and a pull request show their
  // titles as plain links.
  await expect(summary.getByRole("link", { name: /Morgan Lee/ })).toBeVisible();
  await expect(
    summary.getByRole("link", { name: "Investigate checkout latency" }),
  ).toBeVisible();
  await expect(
    summary
      .getByRole("link", { name: /^Pin the release train to payments 4\.2/ })
      .first(),
  ).toBeVisible();
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

// The first To do row, and its hover card once the pointer rests on it.
async function restOnFirstRow(page: Page) {
  const row = page
    .getByRole("region", { name: "To do" })
    .locator("li[data-inbox-row]")
    .first();
  await row.hover();
  return { card: row.locator(":scope > [data-hover-card]"), row };
}

// Longer than the hover delay, so a card that would show has shown. The
// tests drive the page clock, so the delay passes at once.
const PAST_HOVER_DELAY_MS = 600;

test("Expand on hover is off when the viewer turns it off", async ({
  dashboard,
  page,
}) => {
  await page.clock.install();
  await page.goto(`${dashboard.baseURL}/`);
  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page
    .getByRole("menuitemradio", { name: "Expand on hover: Off" })
    .click();
  await page.keyboard.press("Escape");
  await page.reload();
  const { card } = await restOnFirstRow(page);
  await page.clock.runFor(PAST_HOVER_DELAY_MS);
  await expect(card).toHaveCount(0);
});

test("a compact row floats a comfortable card after the hover delay", async ({
  dashboard,
  page,
}) => {
  await page.clock.install();
  await page.goto(`${dashboard.baseURL}/`);
  const { card, row } = await restOnFirstRow(page);
  await page.clock.runFor(PAST_HOVER_DELAY_MS);
  await expect(card).toHaveCount(1);
  // The card shows the comfortable layout, and the row under it keeps its
  // compact one, so no row below it moves. The pointer and keyboard pass
  // through the card to the row.
  await expect(card.locator('[data-inbox-slot="summary"]')).toHaveCount(1);
  await expect(
    row.locator(':scope > :not([data-hover-card]) [data-inbox-slot="summary"]'),
  ).toHaveCount(0);
  await expect(card).toHaveAttribute("aria-hidden", "true");
  await expect(card).toHaveAttribute("inert", "");
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);
});

test("Compact only leaves comfortable rows alone, and Everywhere expands them", async ({
  dashboard,
  page,
}) => {
  await comfortable(page);
  await page.clock.install();
  await page.goto(`${dashboard.baseURL}/`);
  let { card } = await restOnFirstRow(page);
  await page.clock.runFor(PAST_HOVER_DELAY_MS);
  await expect(card).toHaveCount(0);

  await page.evaluate(() =>
    localStorage.setItem("junior:hover-expand", "everywhere"),
  );
  await page.reload();
  ({ card } = await restOnFirstRow(page));
  await page.clock.runFor(PAST_HOVER_DELAY_MS);
  await expect(card).toHaveCount(1);
});

test("rows never expand on hover under reduced motion", async ({
  dashboard,
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto(`${dashboard.baseURL}/`);
  const { card } = await restOnFirstRow(page);
  await page.clock.runFor(PAST_HOVER_DELAY_MS);
  await expect(card).toHaveCount(0);
});

test("the hover card shows linked work as quiet cards", async ({
  dashboard,
  page,
}) => {
  await page.clock.install();
  await page.goto(`${dashboard.baseURL}/`);
  const row = page
    .getByRole("region", { name: "To do" })
    .locator("li[data-inbox-row]")
    .filter({ hasText: "Package release and self-update" })
    .first();
  await row.hover();
  await page.clock.runFor(PAST_HOVER_DELAY_MS);
  // The same cards as comfortable rows: no icon, and a line in each one's
  // status color.
  const cards = row
    // The card is aria-hidden, so find its parts by attribute.
    .locator(':scope > [data-hover-card] [aria-label="Linked work"]')
    .locator("[data-linked-work-card]");
  await expect(cards).toHaveCount(3);
  await expect(cards.locator("svg")).toHaveCount(0);
  await expect(cards.locator("[data-status-tone]")).toHaveCount(3);
});

test("an expanded review row shows its pull request's title once", async ({
  dashboard,
  page,
}) => {
  await page.goto(`${dashboard.baseURL}/`);
  const row = page
    .getByRole("region", { name: "To do" })
    .locator("li[data-inbox-row]")
    .filter({ hasText: "Package release and self-update" })
    .first();
  const head = row.locator('a[aria-controls^="inbox-row-"]').first();
  await head.click();
  const panel = page.locator(
    `[id="${await head.getAttribute("aria-controls")}"]`,
  );
  const card = panel.getByRole("region", {
    name: "Pull request: Pin the release train to payments 4.2",
  });
  await expect(card).toHaveCount(1);
  // The card carries the title. The item's text names the pull request by
  // number only.
  await expect(panel.getByText("GitHub asks you to review #91.")).toBeVisible();
  // The card's own description may quote it, so match the title alone.
  await expect(
    panel.getByText(/^Pin the release train to payments 4\.2( \(#91\))?$/),
  ).toHaveCount(1);
});
