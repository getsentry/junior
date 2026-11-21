import type { Locator, Page } from "@playwright/test";
import { CONTENT_VERSION_HEADER } from "@sentry/junior/api/schema";

import { mockAutomationCollection } from "../../src/mock-reporting/automation-collection";
import { automationReport } from "./automation-fixture";
import {
  automationAlert,
  expandRow,
  failedRunAlert,
  license,
  mockInboxItems,
  rowHead,
} from "./inbox-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";

// The mock Conversation whose asks include a release review and notes.
const RELEASE_CONVERSATION_ID = "slack:CQA456:1770021600.000600";

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
    // The Inbox stacks this Conversation's asks. Its Conversation row, with
    // every ask, shows in Conversations.
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const row = page
      .getByRole("region", { name: "Conversations" })
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
    // The Inbox stacks this Conversation's asks. Its Conversation row, with
    // every ask, shows in Conversations.
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const row = page
      .getByRole("region", { name: "Conversations" })
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
    // The changes the pills name get no chip of their own. A chip shows
    // its number, and names its title, which shows on hover.
    const chip = row.getByRole("link", {
      name: "Return 429 before parsing oversized envelopes #44",
    });
    await expect(row.locator("[data-linked-work-chip]")).toHaveCount(1);
    await expect(chip).toHaveAttribute("data-linked-work-chip", "");
    await chip.hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Return 429 before parsing oversized envelopes",
    );

    // An FYI says so in words too. To do leaves it out, so Conversations
    // shows it.
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const fyi = page
      .getByRole("listitem")
      .filter({ hasText: "Package release and self-update" })
      .getByRole("button", { name: "FYI", exact: true });
    await expect(fyi).toHaveAttribute("title", "FYI");
    await expect(fyi).toHaveText("FYI");

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

  test("a Conversations row's summary shows its links as chips and titles", async ({
    dashboard,
    page,
  }) => {
    await comfortable(page);
    // Inbox rows name one item each, so a Conversations row shows the
    // summary.
    await mockInboxItems(page, {
      open: [
        {
          ...license,
          owner: { id: RELEASE_CONVERSATION_ID, kind: "conversation" },
          rootConversationId: RELEASE_CONVERSATION_ID,
        },
      ],
    });
    // The preview holds only the first 400 chars of the message, so give
    // the row a short one with a mention and a pull request.
    await page.route(
      (url) => url.pathname === "/api/conversations",
      async (route) => {
        const response = await route.fetch();
        const feed = (await response.json()) as {
          conversations: Array<{
            conversationId: string;
            activityPreview?: { text: string };
          }>;
        };
        for (const row of feed.conversations) {
          if (
            row.conversationId === RELEASE_CONVERSATION_ID &&
            row.activityPreview
          ) {
            row.activityPreview.text =
              "<@U123> asks for a review of https://github.com/getsentry/payments/pull/91";
          }
        }
        await route.fulfill({ json: feed, response });
      },
    );
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const summary = page
      .getByRole("region", { name: "Conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Package release and self-update" })
      .locator('[data-inbox-slot="summary"]');
    // A person shows a chip. A pull request shows its title as a plain
    // link, also past the closed row's clamp.
    await expect(
      summary.getByRole("link", { name: /Morgan Lee/ }).first(),
    ).toBeVisible();
    await expect(
      summary
        .getByRole("link", { name: /^Pin the release train to payments 4\.2/ })
        .first(),
    ).toBeVisible();
  });

  test("a row's summary keeps its paragraphs and line breaks", async ({
    dashboard,
    page,
  }) => {
    await comfortable(page);
    // In the Inbox, its two asks stack as rows; Conversations keeps the
    // Conversation row and its summary.
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const row = page
      .locator("li[data-inbox-row]")
      .filter({ hasText: "Package release and self-update" })
      .first();
    const paragraphs = row
      .locator('[data-inbox-slot="summary"]')
      .getByRole("paragraph");
    // The message's first paragraph keeps its line break.
    await expect(paragraphs.first()).toHaveText(
      /^Released the package\.\nOpened the update pull request/,
      { useInnerText: true },
    );
    // The open row shows each paragraph on its own.
    await expandRow(row.locator("[data-inbox-head]"));
    await expect(paragraphs.nth(1)).toHaveText(
      "Pin the release train to payments 4.2 (#91)",
    );
    await expect(paragraphs.nth(2)).toHaveText(/^Deployment is ready\./);
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

  test("a title that does not fit fades out, and one that fits does not", async ({
    dashboard,
    page,
  }) => {
    const long = `Package release and self-update${", with every step it took to ship".repeat(8)}`;
    await page.route(
      (url) => url.pathname === "/api/conversations",
      async (route) => {
        const response = await route.fetch();
        const feed = (await response.json()) as {
          conversations: Array<{ displayTitle: string }>;
        };
        for (const row of feed.conversations) {
          if (row.displayTitle === "Package release and self-update")
            row.displayTitle = long;
        }
        await route.fulfill({ json: feed, response });
      },
    );
    await comfortable(page);
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const title = (text: string) =>
      page
        .locator("li[data-inbox-row] [data-inbox-head]")
        .getByText(text, { exact: true })
        .first();
    await expect(title(long)).toHaveAttribute("data-overflow");
    await expect(title(SENTAUR)).toBeVisible();
    await expect(title(SENTAUR)).not.toHaveAttribute("data-overflow");
  });

  const CHECKOUT = "Investigate checkout latency";

  test("an In flight title that grows past its column fades", async ({
    dashboard,
    page,
  }) => {
    const long = `${CHECKOUT}${", then the p99 regression in the EU region".repeat(4)}`;
    let grown = false;
    let baseline = false;
    await page.route(
      (url) => url.pathname === "/api/conversations",
      async (route) => {
        // Request the full page because this test changes it.
        const response = await route.fetch({
          headers: {
            ...route.request().headers(),
            [CONTENT_VERSION_HEADER]: "",
          },
        });
        const feed = (await response.json()) as {
          conversations: Array<{ displayTitle: string }>;
        };
        for (const row of feed.conversations) {
          if (grown && row.displayTitle === CHECKOUT) row.displayTitle = long;
        }
        await route.fulfill({ json: feed, response });
      },
    );
    // The versions poll refreshes the feed once its token moves. Its first
    // answer is only the baseline, so that one must be the short token.
    await page.route("**/api/versions*", async (route) => {
      const response = await route.fetch();
      const versions = (await response.json()) as { conversations: string };
      const moved = grown;
      await route.fulfill({
        json: {
          ...versions,
          conversations: `${versions.conversations}${moved ? " title:grown" : ""}`,
        },
        response,
      });
      if (!moved) baseline = true;
    });
    await page.goto(`${dashboard.baseURL}/`);
    const inFlight = page.getByRole("list", { name: "In flight" });
    const title = (text: string) => inFlight.getByText(text, { exact: true });
    await expect(title(CHECKOUT)).toBeVisible();
    await expect(title(CHECKOUT)).not.toHaveAttribute("data-overflow");
    // A refetch makes the title longer. Its box keeps the column's width.
    await expect.poll(() => baseline).toBe(true);
    grown = true;
    await expect(title(long)).toHaveAttribute("data-overflow", "", {
      timeout: 15_000,
    });
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
    // The Inbox stacks this Conversation's asks. Its Conversation row, with
    // every ask, shows in Conversations.
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const row = page
      .getByRole("region", { name: "Conversations" })
      .locator("li[data-inbox-row]")
      .filter({ hasText: "Package release and self-update" })
      .first();
    await row.locator('[data-image-tile="work"] button[data-ask-pill]').click();
    await expect(row).toHaveAttribute("data-expanded", "true");
    await expect(page).toHaveURL(`${dashboard.baseURL}/?view=conversations`);
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
    // The Automations page lists the Automations of the Inbox's alerts.
    await mockInboxItems(page, {
      open: [
        automationAlert("scheduled-1", "Weekly project summary"),
        automationAlert("event-1", "Closed issue summary"),
      ],
    });
    await comfortable(page);
    await page.goto(`${dashboard.baseURL}/automations`);
    const todo = page.getByRole("region", { exact: true, name: "To do" });
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
    // The Inbox stacks this Conversation's asks. Its Conversation row, with
    // every ask, shows in Conversations.
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const row = page
      .getByRole("region", { name: "Conversations" })
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

  test("Dismiss closes an Automation alert on the server", async ({
    dashboard,
    page,
  }) => {
    const alert = automationAlert("event-1", "Closed issue summary");
    const actions = await mockInboxItems(page, { open: [alert, license] });
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    const head = rowHead(todo, alert.title);
    await head.hover();
    await head
      .locator("xpath=ancestor::*[@data-inbox-row][1]")
      .getByRole("button", { exact: true, name: "Dismiss" })
      .click();
    await expect(rowHead(todo, alert.title)).toHaveCount(0);
    expect(actions).toEqual([{ body: { action: "dismiss" }, id: alert.id }]);
    // The server closed it, so it stays closed in a new page.
    await page.reload();
    await expect(rowHead(todo, license.title)).toBeVisible();
    await expect(rowHead(todo, alert.title)).toHaveCount(0);
  });

  test("a failed-run alert sends Run again to the server", async ({
    dashboard,
    page,
  }) => {
    const alert = failedRunAlert("scheduled-1", "Weekly project summary");
    const actions = await mockInboxItems(page, { open: [alert, license] });
    const automation = {
      ...automationReport.automations.find(({ id }) => id === "scheduled-1")!,
      lastRunStatus: "failed" as const,
    };
    await page.route("**/api/automations/scheduled-1", (route) =>
      route.fulfill({ json: automation }),
    );
    await page.route("**/api/automations/scheduled-1/executions", (route) =>
      route.fulfill({
        json: {
          executionDays: [],
          executions: [
            {
              error: "Slack rejected the result message: channel_not_found.",
              executedAt: "2026-08-06T16:00:00.000Z",
              executionId: "scheduled-1-run-1",
              status: "failed",
            },
          ],
          truncated: false,
        },
      }),
    );
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    await expandRow(rowHead(todo, alert.title));
    await expect(todo.getByRole("button", { name: "Pause" })).toBeVisible();
    // Core takes the step and reads no words, so there is no Other….
    await expect(todo.getByRole("button", { name: "Other…" })).toHaveCount(0);
    await expect(
      todo.getByText("Slack rejected the result message: channel_not_found."),
    ).toBeVisible();
    await screenshot(page, "inbox-automation-alert-failed-run", {
      lightTheme: true,
    });
    await todo.getByRole("button", { name: "Run again" }).click();
    await expect(rowHead(todo, alert.title)).toHaveCount(0);
    expect(actions).toEqual([
      {
        body: { action: "submit", answer: { values: { step: ["Run again"] } } },
        id: alert.id,
      },
    ]);
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
    await mockInboxItems(page, {
      open: [automationAlert("scheduled-1", "Weekly project summary")],
    });
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
