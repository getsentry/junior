import type { Locator, Page } from "@playwright/test";

import { mockAutomationCollection } from "../../src/mock-reporting/automation-collection";
import { automationReport } from "./automation-fixture";
import { expandRow } from "./inbox-fixture";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
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
    // #2201 has no preview image, so its ask keeps its pill.
    await expect(
      title.getByRole("button", { name: /^Ready to merge #2201/ }),
    ).toBeVisible();
    // #91 has one: its image card carries the ask's icon, so it has no pill.
    // The icon is a button that does the pill's job.
    await expect(
      title.getByRole("button", { name: /^Review requested #91/ }),
    ).toHaveCount(0);
    await expect(
      row.locator('[data-image-tile="work"]').getByRole("button", {
        name: "Review requested #91: Pin the release train to payments 4.2",
      }),
    ).toBeVisible();
    await expect.poll(() => slots(row)).toEqual(SLOTS);
  });

  test("a row's pills name each kind in words, and name a change once", async ({
    dashboard,
    page,
  }) => {
    await page.goto(`${dashboard.baseURL}/`);
    const row = page
      .getByRole("region", { name: "To do" })
      .getByRole("listitem")
      .filter({ hasText: "Package release and self-update" });
    // Each pull request ask says its kind in short words, then names its
    // change by title and number.
    const review = row.getByRole("button", {
      name: "Review requested #91: Pin the release train to payments 4.2",
    });
    const ready = row.getByRole("button", {
      name: "Ready to merge #2201: Update the package to 0.288.0",
    });
    await expect(review).toHaveText(
      "ReviewPin the release train to payments 4.2#91",
    );
    await expect(ready).toHaveText(
      "Ready to mergeUpdate the package to 0.288.0#2201",
    );
    await expect(review.locator("[data-ask-kind]")).toHaveAttribute(
      "data-ask-kind",
      "Review requested",
    );
    await expect(ready.locator("[data-ask-kind]")).toHaveAttribute(
      "data-ask-kind",
      "Ready to merge",
    );
    // An FYI says so in words too.
    const fyi = row.getByRole("button", { name: "FYI", exact: true });
    await expect(fyi).toHaveText("FYI");
    // The changes the pills name get no chip of their own.
    await expect(row.locator("[data-linked-work-chip]")).toHaveText([
      "Return 429 before parsing oversized envelopes#44",
    ]);

    // Pull requests mark their asks the same way.
    await page.goto(`${dashboard.baseURL}/?view=prs`);
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: "Review requested · #91" })
        .locator('[data-ask-kind="Review requested"]')
        .first(),
    ).toBeVisible();
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
    await expect(
      summary.getByRole("link", { name: /Morgan Lee/ }),
    ).toBeVisible();
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

  const SENTAUR = "Triage Sentaur GoCD deployment failures";

  function sentaurRow(page: Page): Locator {
    return page
      .locator("li[data-inbox-row]")
      .filter({ hasText: SENTAUR })
      .first();
  }

  test("a row's title has its own line, and its summary sits under it, clamped", async ({
    dashboard,
    page,
  }) => {
    await comfortable(page);
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const row = sentaurRow(page);
    await row.scrollIntoViewIfNeeded();
    await expect.poll(() => slots(row)).toEqual(SLOTS);
    // The summary spans the title's column and the meta's, under the title.
    const summary = row.locator('[data-inbox-slot="summary"]');
    await expect(summary).toHaveClass(/\bcol-span-2\b/);
    await expect(summary).toHaveClass(/\brow-start-2\b/);
    await expect(summary.locator("[data-summary-lines]")).toHaveAttribute(
      "data-summary-lines",
      "2",
    );
    // The Brief's running marker sits on the title, as the dot does.
    await expect(
      row
        .locator('[data-inbox-slot="title"]')
        .getByRole("img", { name: /^Brief: / }),
    ).toBeVisible();
    await expect(summary.getByRole("img", { name: /^Brief: / })).toHaveCount(0);
    // Compact rows clamp it to one line. A new page has no comfortable
    // density script.
    const compact = await page.context().newPage();
    await compact.goto(`${dashboard.baseURL}/?view=conversations`);
    await compact.evaluate(() =>
      localStorage.setItem("junior:density", "compact"),
    );
    await compact.reload();
    await sentaurRow(compact).scrollIntoViewIfNeeded();
    await expect(
      sentaurRow(compact).locator(
        '[data-inbox-slot="summary"] [data-summary-lines]',
      ),
    ).toHaveAttribute("data-summary-lines", "1");
  });

  test("a row's actions sit beside its time and pin, and never hide them", async ({
    dashboard,
    page,
  }) => {
    await comfortable(page);
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const row = sentaurRow(page);
    await row.scrollIntoViewIfNeeded();
    const meta = row.locator('[data-inbox-slot="meta"]').first();
    await row.locator("a[data-inbox-head]").first().hover();
    // The actions take their own room in the meta's cell, so they cover
    // neither the title nor the summary, and the state stays in view.
    await meta.getByRole("button", { name: /^Pin Triage Sentaur/ }).click();
    await expect(meta.getByRole("img", { name: "Pinned" })).toBeVisible();
    await expect(meta.getByText("1d")).toBeVisible();
    await expect(meta.getByRole("button", { name: /^Unpin / })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // With the pointer on the row's own Threads, the row keeps its state.
    await row.getByRole("link", { name: /Read the canary agent logs/ }).hover();
    await expect(meta.getByRole("img", { name: "Pinned" })).toBeVisible();
    await expect(meta.getByText("1d")).toBeVisible();
  });

  test("an ask shown on an image card expands its row, as its pill would", async ({
    dashboard,
    page,
  }) => {
    await comfortable(page);
    await page.goto(`${dashboard.baseURL}/`);
    const row = page
      .getByRole("region", { name: "To do" })
      .locator("li[data-inbox-row]")
      .filter({ hasText: "Package release and self-update" })
      .first();
    await row.locator('[data-image-tile="work"] button[data-ask-pill]').click();
    await expect(row).toHaveAttribute("data-expanded", "true");
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  });

  test("one cap and one ranking cover every kind of linked work", async ({
    dashboard,
    page,
  }) => {
    await comfortable(page);
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const row = sentaurRow(page);
    await row.scrollIntoViewIfNeeded();
    const work = row.getByRole("group", { name: "Linked work" });
    const lines = work.locator("[data-linked-work-card]");
    // 6 pull requests and 9 Linear issues share 3 lines and one "+12 more",
    // with no separate row of Linear ids.
    await expect(lines).toHaveCount(3);
    await expect(work.locator("[data-linked-work-chip]")).toHaveCount(0);
    await work.getByRole("button", { name: "+12 more" }).click();
    // Titled work has a line each, Linear issues too. Issues saved with no
    // title share one line of ids.
    await expect(lines).toHaveCount(9);
    await expect(
      lines.filter({ hasText: "Grow the GoCD agent pool" }),
    ).toContainText("DI-2877");
    await expect(
      work.locator("[data-linked-work-chip]").filter({ hasText: "DI-2874" }),
    ).not.toHaveCount(0);
    await expect(lines.filter({ hasText: "DI-2874" })).toHaveCount(0);
    // A repo that isn't the row's main one gives way before the title, and
    // the tooltip names it in full.
    const other = lines.filter({ has: page.locator("[data-work-repo]") });
    await expect(other.first()).toBeVisible();
    await expect(other.first()).toHaveAttribute(
      "title",
      /getsentry|devinfra-deployment-service#|sentaur#/,
    );
    // Each pull request's icon names its state.
    for (const state of ["open", "draft", "merged", "closed"]) {
      await expect(
        lines.getByRole("img", { name: new RegExp(state, "i") }).first(),
      ).toBeAttached();
    }
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
    await expandRow(row.locator("a[data-inbox-head]").first());
    const panel = row.getByRole("region", { name: /: asks$/ });
    const card = panel.getByRole("region", {
      name: "Pull request: Pin the release train to payments 4.2",
    });
    await expect(card).toHaveCount(1);
    // The card carries the title. The item's text names the pull request by
    // number only.
    await expect(
      panel.getByText("GitHub asks you to review #91."),
    ).toBeVisible();
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
      {
        key: "SEC-2172",
        label: "SEC-2172",
        objectType: "task",
        status: "open",
      },
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
      await expandRow(row.locator("a[data-inbox-head]").first());
      const linked = row.getByRole("group", { name: "Linked work" }).last();
      // Each item names itself, its number in its status color, on one
      // line.
      await expect(
        linked.locator("[data-linked-work-chip]").first(),
      ).toHaveText("SEC-2172");
      // The rest folds away: +N on the line, or one "+N more".
      await expect(
        linked
          .locator("[data-linked-work-overflow], [data-linked-work-more]")
          .first(),
      ).toBeVisible();
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
    await attention
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
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

  test("an Automations card gives a failed run's error as its reason", async ({
    dashboard,
    page,
  }) => {
    const report = structuredClone(automationReport);
    Object.assign(
      report.automations.find((automation) => automation.id === "scheduled-1")!,
      { lastRunStatus: "failed" },
    );
    await page.route(/\/api\/automations(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: mockAutomationCollection(
          report,
          new URL(route.request().url()).searchParams,
        ),
      }),
    );
    const error = "Slack rejected the result message: channel_not_found.";
    await page.route("**/api/automations/scheduled-1/executions", (route) =>
      route.fulfill({
        json: {
          executionDays: [],
          executions: [
            {
              error,
              executedAt: "2026-08-06T16:00:00.000Z",
              executionId: "scheduled-1-run-1",
              status: "failed",
            },
          ],
          truncated: false,
        },
      }),
    );
    await page.goto(`${dashboard.baseURL}/automations`);
    await page
      .getByRole("region", { exact: true, name: "To do" })
      .getByRole("button", { name: /Weekly project summary/ })
      .click();
    const details = page.getByRole("region", {
      name: "Weekly project summary: attention",
    });
    // The header and Last run say that it failed; Why says what failed.
    const why = details.getByRole("definition").first();
    await expect(details.getByRole("term").first()).toHaveText("Why");
    await expect(why).toHaveText(error);
  });
});
