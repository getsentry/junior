/** The Inbox lists' pages: next pages, To do's own paging, and failed pages. */
import type { Page } from "@playwright/test";
import { NOW_MS } from "../../src/mock-reporting/fixtures";
import { holdRequests } from "../harness";
import {
  answered,
  license,
  mockInboxItems,
  mockViewerCodeChanges,
  prMerge,
  prReady,
  prReview,
  pullRequestSubject,
  rowHead,
} from "./inbox-fixture";
import { expect, test } from "../test";
import { mockFeedPage } from "../mock-reports";
import { scrollListUntil, scrollToLastStatus } from "./scroll-until";

// A GitHub notice about a pull request that waits on no one, so Code has a
// Waiting on others pile. An agent's notice that cites one is not on Code.
const prNotice = {
  ...prReady,
  subject: pullRequestSubject({
    id: "acme/payments#42",
    kind: "github:pull_request",
    title: "fix(payments): Retry declined webhooks",
    url: "https://github.com/acme/payments/pull/42",
  }),
};

test.describe("new UI", () => {
  test("the asks and Done load their next pages at the end of the list", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, {
      open: [prReview, prMerge, prNotice],
      pageSize: 1,
    });
    // No code changes, so the asks are the whole list and its end shows.
    await mockViewerCodeChanges(page, []);
    const cursors: string[] = [];
    page.on("request", (request) => {
      const cursor = new URL(request.url()).searchParams.get("cursor");
      if (request.url().includes("/api/inbox-items?") && cursor)
        cursors.push(cursor);
    });
    await page.goto(`${dashboard.baseURL}/code`);
    // Each PR is on its own page; the list loads the next as its end shows.
    await expect(
      page.locator("section[aria-label] section[aria-label]"),
    ).toHaveText([/^Waiting on you/, /^Waiting on others/]);
    await expect(page.getByText("Loading more…")).toHaveCount(0);

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Done", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /Digest skipped/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /initech license entry/ }),
    ).toBeVisible();
    expect(cursors).toEqual(expect.arrayContaining(["1", "2"]));
  });

  test("Code · Mine lists every open change, past the first page", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [] });
    // The server lists the longest idle first, so the freshest come last.
    await mockViewerCodeChanges(page, [
      ...Array.from({ length: 100 }, (_, index) => ({
        idleDays: 3 + index / 100,
        number: 1000 + index,
        title: `Older change ${index + 1}`,
      })).reverse(),
      ...Array.from({ length: 5 }, (_, index) => ({
        idleDays: 0,
        number: 2000 + index,
        title: `Fresh change ${index + 1}`,
      })),
    ]);
    await page.goto(`${dashboard.baseURL}/code`);
    const others = page
      .getByRole("region", { name: "Waiting on others" })
      .getByRole("listitem");
    await expect(others).toHaveCount(105);
    await expect(others.first()).toHaveText(/Fresh change/);
  });

  test("Code · Mine reads every page of asks, so each finds its change", async ({
    dashboard,
    page,
  }) => {
    // The ask for #91 is on the second page of asks.
    await mockInboxItems(page, {
      open: [prMerge, { ...prReview, createdAt: "2026-08-01T00:00:00.000Z" }],
      pageSize: 1,
    });
    // Enough changes that the end of the list stays out of view.
    await mockViewerCodeChanges(page, [
      ...Array.from({ length: 40 }, (_, index) => ({
        idleDays: 0.5,
        number: 3000 + index,
        title: `Other change ${index + 1}`,
      })),
      { idleDays: 1, number: 91, title: "Pin the release train" },
    ]);
    await page.goto(`${dashboard.baseURL}/code`);
    await expect(
      page
        .getByRole("region", { name: "Waiting on you" })
        .getByRole("listitem", { name: "Pin the release train" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Waiting on others" })
        .getByRole("listitem", { name: "Pin the release train" }),
    ).toHaveCount(0);
  });

  test("To do lists its rows while the count is pending or failed", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [license] });
    const todo = page.getByRole("region", { name: "To do" });
    const row = todo.getByRole("link", { name: new RegExp(license.title) });
    // A failed count leaves the badge without a number, not To do empty.
    await page.route("**/api/inbox-items/count**", (route) =>
      route.fulfill({ json: { error: "Failed" }, status: 500 }),
    );
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expect(row).toBeVisible();
    // A count that never answers does the same.
    await page.unroute("**/api/inbox-items/count**");
    await holdRequests(page, "**/api/inbox-items/count**");
    await page.reload();
    await expect(row).toBeVisible();
  });

  test("a failed next page waits for Try again", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, {
      open: [prReview, prMerge, prNotice],
      pageSize: 1,
    });
    // No code changes, so the asks are the whole list and its end shows.
    await mockViewerCodeChanges(page, []);
    let attempts = 0;
    await page.route(/\/api\/inbox-items\?.*cursor=1(?:&|$)/, (route) => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({ json: { error: "Failed" }, status: 500 })
        : route.fallback();
    });
    await page.goto(`${dashboard.baseURL}/code`);
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(page.getByText("Could not load more.")).toBeVisible();
    // Two frames later, the list has not asked again on its own.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    expect(attempts).toBe(1);
    await retry.click();
    // The retried page loads, and the pages after it load on their own.
    await expect(
      page.locator("section[aria-label] section[aria-label]"),
    ).toHaveText([/^Waiting on you/, /^Waiting on others/]);
    await expect(retry).toHaveCount(0);
  });

  test("To do loads its next asks at its own end", async ({
    dashboard,
    page,
  }) => {
    // Each ask is in its own Conversation, so the stream below To do is long
    // and its end stays out of view.
    const asks = Array.from({ length: 30 }, (_, index) => ({
      ...license,
      owner: {
        id: `slack:CTODO:17700${String(index).padStart(5, "0")}.000100`,
        kind: "conversation",
      },
      rootConversationId: `slack:CTODO:17700${String(index).padStart(5, "0")}.000100`,
      conversationIds: [],
      createdAt: new Date(NOW_MS - index * 60_000).toISOString(),
      id: `item-todo-${index}`,
      title: `Approve rollout step ${index}`,
    }));
    await mockInboxItems(page, { open: asks, pageSize: 10 });
    await page.goto(`${dashboard.baseURL}/inbox`);
    const rows = page
      .getByRole("region", { name: "To do" })
      .locator("[data-inbox-row]");
    await expect(rows).toHaveCount(10);
    // Its end loads the next page while it shows fewer than its count.
    await scrollListUntil(() => scrollToTodoEnd(page), rows, rows.nth(29));
    await expect(rows).toHaveCount(30);
  });

  /** 30 old notices, each in its own Conversation, and one new ask. */
  function askBehindNotices() {
    const notices = Array.from({ length: 30 }, (_, index) => ({
      ...prReady,
      owner: {
        id: `slack:CNOTE:17700${String(index).padStart(5, "0")}.000100`,
        kind: "conversation",
      },
      rootConversationId: `slack:CNOTE:17700${String(index).padStart(5, "0")}.000100`,
      conversationIds: [],
      createdAt: new Date(NOW_MS - (60 - index) * 3_600_000).toISOString(),
      id: `item-notice-${index}`,
      subject: { id: `item-notice-${index}`, kind: "question" },
      title: `Deploy note ${index}`,
    }));
    const ask = {
      ...license,
      owner: { id: "slack:CASK:1770000000.000100", kind: "conversation" },
      rootConversationId: "slack:CASK:1770000000.000100",
      conversationIds: [],
      createdAt: new Date(NOW_MS - 60_000).toISOString(),
    };
    return { ask, notices };
  }

  /** Later pages of the Inbox item list never load. */
  async function holdLaterInboxItemPages(page: Page) {
    await holdRequests(page, /\/api\/inbox-items\?.*cursor=/);
  }

  test("To do's first page holds the new ask behind older notices", async ({
    dashboard,
    page,
  }) => {
    const { ask, notices } = askBehindNotices();
    await mockInboxItems(page, { open: [...notices, ask], pageSize: 25 });
    await holdLaterInboxItemPages(page);
    await page.goto(`${dashboard.baseURL}/inbox`);
    const rows = page
      .getByRole("region", { name: "To do" })
      .locator("[data-inbox-row]");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(ask.title);
  });

  test("a collapsed To do loads its first page, so it expands with its rows", async ({
    dashboard,
    page,
  }) => {
    const { ask, notices } = askBehindNotices();
    await mockInboxItems(page, { open: [...notices, ask], pageSize: 25 });
    await holdLaterInboxItemPages(page);
    await page.goto(`${dashboard.baseURL}/inbox`);
    const todo = page.getByRole("region", { name: "To do" });
    await todo.getByRole("button", { name: /^To do/ }).click();
    await expect(todo.locator("[data-inbox-row]")).toHaveCount(0);

    // First-page reads only. Later pages are held, so an expanded row can
    // come only from the first page.
    const reads: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (/\/api\/inbox-items\?/.test(url) && !url.includes("cursor="))
        reads.push(url);
    });
    await page.reload();
    // The first page is in: the newest notice on it shows below To do.
    await expect(
      page.locator("[data-inbox-row]").filter({ hasText: "Deploy note 29" }),
    ).toBeVisible();
    const collapsed = page.getByRole("button", {
      expanded: false,
      name: /^To do/,
    });
    await expect(collapsed).toBeVisible();
    const readsBefore = reads.length;
    await collapsed.click();
    await expect(todo.locator("[data-inbox-row]")).toContainText(ask.title);
    expect(reads).toHaveLength(readsBefore);
  });

  test("To do pages to its end when the count or the Automations fail", async ({
    dashboard,
    page,
  }) => {
    const asks = Array.from({ length: 30 }, (_, index) => ({
      ...license,
      owner: {
        id: `slack:CTODO:17700${String(index).padStart(5, "0")}.000100`,
        kind: "conversation",
      },
      rootConversationId: `slack:CTODO:17700${String(index).padStart(5, "0")}.000100`,
      conversationIds: [],
      createdAt: new Date(NOW_MS - index * 60_000).toISOString(),
      id: `item-todo-${index}`,
      title: `Approve rollout step ${index}`,
    }));
    await mockInboxItems(page, { open: asks, pageSize: 10 });
    // The count only feeds the badge, so its failure cannot stop To do.
    await page.route("**/api/inbox-items/count**", (route) =>
      route.fulfill({ json: { error: "Count failed" }, status: 500 }),
    );
    await page.route(/\/api\/automations\?scope=attention/, (route) =>
      route.fulfill({ json: { error: "Automations failed" }, status: 500 }),
    );
    await page.goto(`${dashboard.baseURL}/inbox`);
    const rows = page
      .getByRole("region", { name: "To do" })
      .locator("[data-inbox-row]");
    await expect(rows).toHaveCount(10);
    await scrollListUntil(() => scrollToTodoEnd(page), rows, rows.nth(29));
    await expect(rows).toHaveCount(30);
  });

  test("Done shows Try again when its first read fails", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page);
    let fail = true;
    await page.route(/\/api\/inbox-items\?.*status=done/, async (route) => {
      if (!fail) return route.fallback();
      fail = false;
      return route.fulfill({ json: { error: "Read failed" }, status: 500 });
    });
    await page.goto(`${dashboard.baseURL}/inbox?view=done`);
    await expect(page.getByText("Could not load Done.")).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByRole("button", { name: new RegExp(answered.title) }),
    ).toBeVisible();
  });

  test("the entry counts cover the asks past the loaded pages", async ({
    dashboard,
    page,
  }) => {
    // Each ask is in its own Conversation, and only the first page loads.
    const decisions = Array.from({ length: 12 }, (_, index) => ({
      ...license,
      owner: {
        id: `slack:CCOUNT:17700${String(index).padStart(5, "0")}.000100`,
        kind: "conversation",
      },
      rootConversationId: `slack:CCOUNT:17700${String(index).padStart(5, "0")}.000100`,
      conversationIds: [],
      createdAt: new Date(NOW_MS - index * 60_000).toISOString(),
      id: `item-decision-${index}`,
      title: `Approve rollout step ${index}`,
    }));
    const prs = [prMerge, prReview].map((item, index) => ({
      ...item,
      createdAt: new Date(NOW_MS - (20 + index) * 60_000).toISOString(),
    }));
    const asleep = decisions.at(-1)!;
    // A row on a later page sleeps until tomorrow.
    await mockInboxItems(page, {
      open: [...decisions, ...prs],
      pageSize: 2,
      snoozes: [
        {
          conversationId: asleep.owner.id,
          untilMs: NOW_MS + 86_400_000,
        },
      ],
    });
    await holdLaterInboxItemPages(page);
    await page.goto(`${dashboard.baseURL}/inbox`);
    const nav = page.getByRole("navigation", { name: "Primary" });
    const filters = page.getByRole("navigation", { name: "Asks to show" });
    await expect(
      page.getByRole("region", { name: "To do" }).locator("[data-inbox-row]"),
    ).toHaveCount(2);
    // The server counts every page, and leaves out the snoozed row.
    await expect(filters.getByRole("link", { name: /^Decisions/ })).toHaveText(
      /^Decisions\s*11$/,
    );
    await expect(filters.getByRole("link", { name: /^PRs/ })).toHaveText(
      /^PRs\s*2$/,
    );
    await expect(nav.getByRole("link", { name: /^Snoozed/ })).toHaveText(
      /^Snoozed\s*1$/,
    );
  });

  test("a linked ask from a later page counts once", async ({
    dashboard,
    page,
  }) => {
    const decisions = questionsByPage();
    await mockInboxItems(page, {
      automations: () => 0,
      open: decisions,
      pageSize: 2,
    });
    await holdLaterInboxItemPages(page);
    const linked = decisions[5]!;
    await page.goto(`${dashboard.baseURL}/inbox?item=${linked.id}`);
    const todo = page.getByRole("region", { name: "To do" });
    await expect(rowHead(todo, linked.title)).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary" });
    const filters = page.getByRole("navigation", { name: "Asks to show" });
    await expect(filters.getByRole("link", { name: /^Decisions/ })).toHaveText(
      /^Decisions\s*12$/,
    );
    await expect(
      nav.getByRole("link", { name: /^Inbox/ }),
    ).toHaveAccessibleName("Inbox, 12 waiting");
  });

  test("the Automations entry counts from the server while its list fails", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { automations: () => 3, open: [license] });
    await page.route(/\/api\/automations\?scope=attention/, (route) =>
      route.fulfill({ json: { error: "Automations failed" }, status: 500 }),
    );
    await page.goto(`${dashboard.baseURL}/inbox`);
    const nav = page.getByRole("navigation", { name: "Primary" });
    // The same server count as the badge, not the list that failed to load.
    await expect(nav.getByRole("link", { name: /^Automations/ })).toHaveText(
      /^Automations\s*3$/,
    );
  });

  test("an Inbox with only done Conversations lists none of them, and reads no older page", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { automations: () => 0, open: [] });
    let olderReads = 0;
    await page.route(/\/api\/conversations(\?|$)/, async (route) => {
      if (new URL(route.request().url()).searchParams.has("cursor")) {
        olderReads += 1;
      }
      const body = await mockFeedPage(route);
      const done = body.conversations.filter(
        (conversation) =>
          !conversation.pinnedAt &&
          !conversation.turnActive &&
          !conversation.latestTurnFailed,
      );
      await route.fulfill({
        json: { ...body, conversations: done, nextCursor: "older" },
      });
    });
    await page.goto(`${dashboard.baseURL}/inbox`);
    const inbox = page.getByRole("region", { exact: true, name: "Inbox" });
    await expect(inbox.getByText("Nothing left here")).toBeVisible();
    await inbox
      .locator("[data-inbox-scroll]")
      .evaluate((node) => (node.scrollTop = node.scrollHeight));
    await expect(inbox.locator("[data-inbox-row]")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "In flight" })).toHaveCount(0);
    expect(olderReads).toBe(0);

    // Conversations still lists them. Their summaries read the cards of
    // their links.
    const cardsRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/objects",
    );
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    await expect(
      page
        .getByRole("region", { exact: true, name: "Conversations" })
        .locator("[data-inbox-row]")
        .first(),
    ).toBeVisible();
    await cardsRead;
  });

  test("a Conversations state filter pages on before it says none match", async ({
    dashboard,
    page,
  }) => {
    // The first page holds no running Conversation; the next page does.
    let releaseOlder = () => {};
    const olderHeld = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    await page.route(/\/api\/conversations(\?|$)/, async (route) => {
      const url = new URL(route.request().url());
      const older = url.searchParams.has("cursor");
      // Both pages split the mock's first page.
      url.searchParams.delete("cursor");
      const body = await mockFeedPage(route, url);
      const running = (conversation: {
        treeState?: string;
        turnActive?: boolean;
      }) =>
        conversation.treeState === "working" ||
        Boolean(conversation.turnActive);
      if (older) await olderHeld;
      await route.fulfill({
        json: {
          ...body,
          conversations: body.conversations.filter(
            (conversation: { treeState?: string; turnActive?: boolean }) =>
              older ? running(conversation) : !running(conversation),
          ),
          nextCursor: older ? undefined : "older",
        },
      });
    });
    const older = page.waitForRequest((request) =>
      /\/api\/conversations\?.*cursor=/.test(request.url()),
    );
    await page.goto(
      `${dashboard.baseURL}/inbox?view=conversations&state=working`,
    );
    const list = page.getByRole("region", {
      exact: true,
      name: "Conversations",
    });
    await older;
    await expect(list.getByText("No conversations match")).toHaveCount(0);
    releaseOlder();
    await expect(rowHead(list, "Investigate checkout latency")).toBeVisible();
    await expect(list.getByText("No conversations match")).toHaveCount(0);
  });

  /** Twelve questions, each in its own Conversation, two to a page. */
  function questionsByPage() {
    return Array.from({ length: 12 }, (_, index) => ({
      ...license,
      owner: {
        id: `slack:CPAGE:17700${String(index).padStart(5, "0")}.000100`,
        kind: "conversation",
      },
      rootConversationId: `slack:CPAGE:17700${String(index).padStart(5, "0")}.000100`,
      conversationIds: [],
      createdAt: new Date(NOW_MS - index * 60_000).toISOString(),
      id: `item-question-${index}`,
      title: `Approve rollout step ${index}`,
    }));
  }

  /**
   * Bring the end of To do into view: the status line after its rows, which
   * asks for the next page. The last row can show while that line does not.
   */
  async function scrollToTodoEnd(page: Page) {
    await scrollToLastStatus(page.getByRole("region", { name: "To do" }));
  }
});
