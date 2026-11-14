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
  ).toBeAttached();
  // The pills keep to one line in the narrow title column: those that do
  // not fit show as +N.
  await expect(title.locator("[data-pill-overflow]")).toHaveText(/^\+\d+$/);
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

test("rows show many linked work items as one quiet line, not an icon strip", async ({
  dashboard,
  page,
}) => {
  // 35 pull requests and an issue, saved with no title or URL, as older
  // plugins wrote them.
  const work = [
    { key: "SEC-2172", label: "SEC-2172", objectType: "task", status: "open" },
    ...Array.from({ length: 35 }, (_, index) => ({
      key: `getsentry/sentry#${1000 + index}`,
      label: "sentry",
      objectType: "code_change",
      status: "open",
    })),
  ];
  await page.route(
    (url) => url.pathname === "/api/conversations",
    async (route) => {
      const response = await route.fetch();
      const feed = (await response.json()) as {
        conversations: Array<{
          displayTitle: string;
          sidebarAnnotations?: unknown[];
        }>;
      };
      for (const row of feed.conversations) {
        if (row.displayTitle === "Package release and self-update")
          row.sidebarAnnotations = work;
      }
      await route.fulfill({ json: feed, response });
    },
  );
  for (const density of ["comfortable", "compact"] as const) {
    await page.addInitScript(
      (value) => localStorage.setItem("junior:density", value),
      density,
    );
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const row = page
      .locator("[data-inbox-row]")
      .filter({ hasText: "Package release and self-update" })
      .first();
    await row.locator('a[aria-controls^="inbox-row-"]').first().click();
    const linked = row.getByRole("group", { name: "Linked work" }).last();
    // Each item names itself, its number in its status color, and the rest
    // become +N on the same line.
    await expect(linked.locator("[data-linked-work-chip]").first()).toHaveText(
      "SEC-2172",
    );
    await expect(linked.locator("[data-linked-work-overflow]")).toBeVisible();
    await expect(row.getByLabel(/^Linked work, newest first/)).toHaveCount(0);
  }
});

test("Dismiss and Snooze put an Automation alert away until it changes or wakes", async ({
  dashboard,
  page,
}) => {
  const report = structuredClone(automationReport);
  const blocked = report.automations[1]!;
  Object.assign(blocked, {
    lastRunAt: "2026-01-01T10:00:00.000Z",
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
  await page.clock.install();
  await page.goto(`${dashboard.baseURL}/`);
  const todo = page.getByRole("region", { name: "To do" });
  const head = todo.getByRole("button", { name: /Closed issue summary/ });
  const attention = page.getByRole("region", {
    name: `${blocked.title}: attention`,
  });

  await head.click();
  await attention.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(head).toHaveCount(0);
  await page.reload();
  await expect(todo).toBeVisible();
  await expect(head).toHaveCount(0);

  // A newer failure on the same Automation is a new alert, so it shows.
  Object.assign(blocked, {
    lastRunAt: "2026-01-01T11:00:00.000Z",
    statusReason: "GitHub access expired again.",
  });
  await page.reload();
  await expect(head).toBeVisible();

  // Snooze hides it until its time.
  await head.click();
  await attention.getByRole("button", { name: "Snooze" }).click();
  await page.getByRole("button", { name: "3 hours" }).click();
  await expect(head).toHaveCount(0);
  await page.clock.runFor(3 * 60 * 60 * 1000 + 1000);
  await expect(head).toBeVisible();
});
