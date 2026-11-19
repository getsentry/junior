import type { Page } from "@playwright/test";
import {
  audit,
  expandRow,
  mockReviewItems,
  openRow,
  rollout,
  rowHead,
} from "./inbox-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const checkout = "Investigate checkout latency";

  /** Show or hide Details beside the chat. A wide screen opens it at first. */
  async function setDetails(page: Page, open: boolean) {
    const close = page.getByRole("button", {
      name: "Close conversation details",
    });
    const toggle = page.getByRole("button", {
      exact: true,
      name: "Conversation details",
    });
    await expect(close.or(toggle)).toBeVisible();
    if ((await close.isVisible()) !== open)
      await (open ? toggle : close).click();
    await expect(open ? close : toggle).toBeVisible();
  }

  /** Wait until `read` gives the same value twice in a row. */
  async function steady(read: () => Promise<number | string>) {
    let last: number | string | undefined;
    await expect
      .poll(async () => {
        const now = await read();
        const same = now === last;
        last = now;
        return same;
      })
      .toBe(true);
  }

  test("a row opens its Conversation, and Back or Esc restores the list", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page);
    await page.setViewportSize({ height: 560, width: 1440 });
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const list = page.getByRole("region", { name: "Conversations" });
    const scroller = list.locator(".overflow-y-auto").first();
    const head = rowHead(list, checkout);
    await expandRow(head);
    // The row opens with a height animation. A scroll during it stops short,
    // and the list keeps moving after the test reads the place.
    const opened = head.locator("xpath=ancestor::*[@data-inbox-row][1]");
    await steady(() =>
      opened.evaluate((node) => (node as HTMLElement).offsetHeight),
    );
    // The open row pushes this one below the fold, so the reader scrolls.
    const triage = list.getByRole("link", { name: /^Checkout latency triage/ });
    await triage.scrollIntoViewIfNeeded();
    // Back restores the place the reader left from, so scroll to Open and
    // read the place once it holds.
    await triage.hover();
    const row = triage.locator("xpath=ancestor::*[@data-inbox-row][1]");
    const open = row.getByRole("link", { name: "Open conversation" }).first();
    await open.scrollIntoViewIfNeeded();
    const target = await row.elementHandle();
    await steady(() =>
      scroller.evaluate(
        (node, card) =>
          `${node.scrollTop}:${(card as HTMLElement).offsetHeight}`,
        target,
      ),
    );
    const top = await scroller.evaluate((node) => node.scrollTop);
    expect(top).toBeGreaterThan(0);
    await open.click();
    await expect(page).toHaveURL(/\/conversations\/slack%3ACQA123/);
    const back = page.getByRole("link", { name: "Back to Conversations" });
    await expect(back).toBeVisible();
    // A phone view would reset the place that Back restores.
    await screenshot(page, "inbox-conversation-open", {
      lightTheme: true,
      view: "desktop",
    });

    // Back returns to the same entry, scroll position, and open row.
    await back.click();
    await expect(page).toHaveURL(/\/\?view=conversations$/);
    await expect
      .poll(() => scroller.evaluate((node) => node.scrollTop))
      .toBe(top);
    await expect(
      page.getByRole("region", { name: `${checkout}: asks` }),
    ).toBeVisible();

    // Esc goes back too, when focus is not in a text box.
    await openRow(triage);
    await expect(page).toHaveURL(/\/conversations\//);
    await setDetails(page, false);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/\?view=conversations$/);
  });

  test("the first Esc closes Details, and the second goes back", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page);
    await page.goto(`${dashboard.baseURL}/`);
    await openRow(
      page
        .getByRole("region", { name: "To do" })
        .locator("li[data-inbox-stack]")
        .filter({ hasText: "Investigate checkout latency" })
        .locator("li[data-inbox-row] [data-inbox-head]")
        .first(),
    );
    await setDetails(page, true);
    await page.locator("body").focus();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { exact: true, name: "Conversation details" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/conversations\//);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  });

  test("+ opens a new Conversation in the main area", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page);
    await page.goto(`${dashboard.baseURL}/`);
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page).toHaveURL(/\/conversations\/new$/);
    await expect(
      page.getByRole("heading", { name: "What do you need?" }),
    ).toBeVisible();
    await expect(page.getByLabel("Start a conversation")).toBeFocused();
    // The pane keeps its entries beside the composer.
    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("link", {
        name: /^Inbox/,
      }),
    ).toBeVisible();
    await screenshot(page, "inbox-new-conversation", { lightTheme: true });
    await page.getByRole("link", { name: "Back to Inbox" }).click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  });

  test("the list loads older Conversations as it scrolls", async ({
    dashboard,
    page,
  }) => {
    let firstPage = 0;
    let olderPage = 0;
    await page.route(/\/api\/conversations(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("cursor") === "older") {
        olderPage += 1;
        const response = await route.fetch({ url: url.origin + url.pathname });
        const feed = await response.json();
        const template = feed.conversations.at(-1);
        return route.fulfill({
          json: {
            ...feed,
            conversations: [
              {
                ...template,
                conversationId: "slack:COLD:1700000000.000100",
                displayTitle: "An older conversation",
                lastProgressAt: "2026-06-01T09:00:00.000Z",
                lastSeenAt: "2026-06-01T09:00:00.000Z",
                startedAt: "2026-06-01T09:00:00.000Z",
              },
            ],
            nextCursor: undefined,
          },
        });
      }
      firstPage += 1;
      const response = await route.fetch();
      return route.fulfill({
        response,
        json: { ...(await response.json()), nextCursor: "older" },
      });
    });
    await mockReviewItems(page);
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const older = page.getByRole("link", { name: /An older conversation/ });
    await expect(older).toHaveCount(0);
    expect(olderPage).toBe(0);
    const list = page.getByRole("region", { name: "Conversations" });
    // The list shows its loaded rows first, then reads the next page.
    await expect(async () => {
      await list
        .locator(".overflow-y-auto")
        .first()
        .evaluate((node) => (node.scrollTop = node.scrollHeight));
      await expect(older).toBeVisible({ timeout: 1_000 });
    }).toPass();
    expect(olderPage).toBe(1);
    expect(firstPage).toBeGreaterThan(0);

    // Another tab replaces the list. Back brings back every row that was
    // loaded, so the list returns to the same place, not a shorter one.
    const scroller = list.locator(".overflow-y-auto").first();
    const scrollTop = await scroller.evaluate((node) => node.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    const primary = page.getByRole("navigation", { name: "Primary" });
    await primary.getByRole("link", { name: /^Automations/ }).click();
    await expect(page).toHaveURL(/\/automations/);
    await page.goBack();
    await expect(page).toHaveURL(/\/\?view=conversations$/);
    await expect(older).toBeVisible();
    expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollTop);
  });

  test("a link to an ask that waits on someone else leaves the Inbox as it is", async ({
    dashboard,
    page,
  }) => {
    const other = {
      ...rollout,
      addedByConversationId: "slack:COTHER:1770000000.000100",
      rootConversationId: "slack:COTHER:1770000000.000100",
      assignees: [],
      canAct: false,
      id: "item-other",
      title: "Pick the rollout window",
    };
    await mockReviewItems(page, { open: [rollout, other] });
    await page.goto(`${dashboard.baseURL}/?item=${other.id}`);
    // The Inbox has no row for it, so the link leaves the URL.
    await expect
      .poll(() => new URL(page.url()).searchParams.has("item"))
      .toBe(false);
    await expect(page.getByRole("region", { name: "To do" })).toBeVisible();
    await expect(page.getByText(other.title)).toHaveCount(0);
  });

  test("an item link and the Inbox tab share one place", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page);
    await page.setViewportSize({ height: 560, width: 1440 });
    // An item link names the Inbox entry, so phones open the list.
    await page.goto(`${dashboard.baseURL}/?view=inbox&item=${rollout.id}`);
    await expect(page).toHaveURL(/\/\?view=inbox$/);
    const asks = page.getByRole("region", { name: `${checkout}: asks` });
    await expect(asks).toContainText(rollout.request.question);
    const scroller = page
      .getByRole("region", { name: "Inbox" })
      .locator(".overflow-y-auto")
      .first();
    await scroller.evaluate((node) => (node.scrollTop = 120));
    const top = await scroller.evaluate((node) => node.scrollTop);
    expect(top).toBeGreaterThan(0);

    // The Inbox tab opens `/`, the same list in the same place.
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox/ })
      .click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
    await expect(asks).toContainText(rollout.request.question);
    await expect
      .poll(() => scroller.evaluate((node) => node.scrollTop))
      .toBe(top);
  });

  test("a linked item past the loaded page stays after a tab switch", async ({
    dashboard,
    page,
  }) => {
    // The linked item is past the first page, so its row loads on its own.
    await mockReviewItems(page, { open: [audit, rollout], pageSize: 1 });
    await page.goto(`${dashboard.baseURL}/?view=inbox&item=${rollout.id}`);
    const linkedRow = page.locator(`li[data-inbox-row="todo:${rollout.id}"]`);
    await expect(linkedRow).toHaveAttribute("data-expanded", "true");

    const primary = page.getByRole("navigation", { name: "Primary" });
    await primary.getByRole("link", { name: /^Automations/ }).click();
    await expect(page).toHaveURL(/\/automations/);
    await primary.getByRole("link", { name: /^Inbox/ }).click();
    // `/` and `/?view=inbox` are one list with one place.
    await expect(page).toHaveURL(/\/(\?view=inbox)?$/);
    await expect(linkedRow).toHaveAttribute("data-expanded", "true");
  });

  test("an item link past the shown rows opens its row in view", async ({
    dashboard,
    page,
  }) => {
    // Newer Conversations fill the first rows the list shows, so the linked
    // Conversation renders only after the list shows more.
    await page.route(/\/api\/conversations(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      const feed = await response.json();
      const linked = feed.conversations.find(
        (conversation: { conversationId: string }) =>
          conversation.conversationId === rollout.addedByConversationId,
      );
      const newer = Array.from({ length: 40 }, (_, index) => ({
        ...linked,
        conversationId: `slack:CNEWER:${1770000000 + index}.000100`,
        displayTitle: `Newer conversation ${index + 1}`,
        pinnedAt: null,
        status: "done",
      }));
      return route.fulfill({
        response,
        json: {
          ...feed,
          conversations: [
            ...newer,
            {
              ...linked,
              lastMessageAt: "2026-06-01T09:00:00.000Z",
              lastProgressAt: "2026-06-01T09:00:00.000Z",
              pinnedAt: null,
            },
          ],
          nextCursor: undefined,
        },
      });
    });
    await mockReviewItems(page, { open: [rollout] });
    await page.goto(
      `${dashboard.baseURL}/?view=conversations&item=${rollout.id}`,
    );
    const asks = page.getByRole("region", { name: `${checkout}: asks` });
    await expect(asks).toContainText(rollout.title);
    await expect(asks).toBeInViewport();
    // The link leaves the URL only once its row is in view.
    await expect(page).toHaveURL(/\/\?view=conversations$/);
  });

  test("a failed page still lets another list show its loaded rows", async ({
    dashboard,
    page,
  }) => {
    // The lists share the feed pages, but each shows its own number of rows.
    const older = Array.from({ length: 40 }, (_, index) => index + 1);
    let oldestAttempts = 0;
    await page.route(/\/api\/conversations(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      const cursor = url.searchParams.get("cursor");
      if (cursor === "oldest") {
        oldestAttempts += 1;
        if (oldestAttempts === 1) {
          return route.fulfill({ json: { error: "Failed" }, status: 500 });
        }
      }
      if (cursor) {
        const response = await route.fetch({ url: url.origin + url.pathname });
        const feed = await response.json();
        const template = feed.conversations.at(-1);
        const row = (id: string, title: string, day: number) => ({
          ...template,
          conversationId: `slack:COLD:${id}`,
          displayTitle: title,
          lastProgressAt: `2026-06-${String(day).padStart(2, "0")}T09:00:00.000Z`,
          lastSeenAt: `2026-06-${String(day).padStart(2, "0")}T09:00:00.000Z`,
          pinnedAt: undefined,
          startedAt: `2026-06-${String(day).padStart(2, "0")}T09:00:00.000Z`,
          status: "done",
        });
        return route.fulfill({
          json:
            cursor === "older"
              ? {
                  ...feed,
                  conversations: older.map((index) =>
                    row(String(index), `Older conversation ${index}`, 28),
                  ),
                  nextCursor: "oldest",
                }
              : {
                  ...feed,
                  conversations: [row("oldest", "The oldest conversation", 1)],
                  nextCursor: undefined,
                },
        });
      }
      const response = await route.fetch();
      return route.fulfill({
        response,
        json: { ...(await response.json()), nextCursor: "older" },
      });
    });
    await mockReviewItems(page);
    const retry = page.getByRole("button", { name: "Try again" });
    const scrollToEnd = (name: string) =>
      page
        .getByRole("region", { name })
        .locator(".overflow-y-auto")
        .first()
        .evaluate((node) => (node.scrollTop = node.scrollHeight));

    // Conversations loads every page it can, until one fails.
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    await expect(async () => {
      await scrollToEnd("Conversations");
      await expect(retry).toBeVisible({ timeout: 1000 });
    }).toPass();
    expect(oldestAttempts).toBe(1);

    // The Inbox lists no Conversations, so it reads no older page, and the
    // failure does not show there.
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: /^Inbox\b/ }).click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
    await expect(page.getByRole("region", { name: "To do" })).toBeVisible();
    await scrollToEnd("Inbox");
    await expect(retry).toHaveCount(0);
    expect(oldestAttempts).toBe(1);

    // Back in Conversations, Try again loads the failed page.
    await nav.getByRole("link", { name: /^Conversations\b/ }).click();
    await expect(async () => {
      await scrollToEnd("Conversations");
      await expect(retry).toBeVisible({ timeout: 1000 });
    }).toPass();
    await retry.click();
    await expect(
      page.getByRole("link", { name: /The oldest conversation/ }),
    ).toBeVisible();
    await expect(retry).toHaveCount(0);
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { height: 844, width: 390 } });

    test("an item link opens its row in the Inbox list", async ({
      dashboard,
      page,
    }) => {
      await mockReviewItems(page);
      // Old links redirect to the item's link, which names the Inbox entry.
      await page.goto(`${dashboard.baseURL}/review?item=${rollout.id}`);
      await expect(page).toHaveURL(/\/\?view=inbox$/);
      await expect(
        page.getByRole("region", { name: `${checkout}: asks` }),
      ).toContainText(rollout.request.question);
    });

    test("entries, then a list, then a Conversation, each with Back", async ({
      dashboard,
      page,
    }) => {
      await mockReviewItems(page);
      await page.goto(`${dashboard.baseURL}/`);
      const entries = page.getByRole("navigation", { name: "Primary" });
      await expect(entries.getByRole("link", { name: /^Inbox/ })).toBeVisible();
      await screenshot(page, "inbox-phone-entries", { lightTheme: true });

      await entries.getByRole("link", { name: /^Inbox/ }).click();
      await expect(page).toHaveURL(/\/\?view=inbox$/);
      const todo = page.getByRole("region", { name: "To do" });
      await expect(
        todo.getByRole("link", { name: new RegExp(checkout) }),
      ).toBeVisible();
      await screenshot(page, "inbox-phone-list", { lightTheme: true });

      await rowHead(todo, rollout.title).click();
      const asks = page.getByRole("region", { name: `${checkout}: asks` });
      await expect(asks).toContainText(rollout.request.question);
      await asks.getByRole("link", { name: "Open conversation" }).click();
      await expect(page).toHaveURL(/\/conversations\//);
      await page.getByRole("link", { name: "Back to Inbox" }).click();
      await expect(page).toHaveURL(/\/\?view=inbox$/);
    });
  });

  test.describe("on a phone, from the entries", () => {
    test.use({ viewport: { height: 844, width: 390 } });

    test("Back from In flight returns to the entries", async ({
      dashboard,
      page,
    }) => {
      await mockReviewItems(page);
      await page.goto(`${dashboard.baseURL}/`);
      const entries = page.getByRole("navigation", { name: "Primary" });
      // A list leaves its path as the place Back returns to.
      await entries.getByRole("link", { name: /^Decisions/ }).click();
      await expect(page).toHaveURL(/\/\?view=decisions$/);
      await page
        .getByRole("link", { name: "Back to the Inbox entries" })
        .click();
      await expect(page).toHaveURL(`${dashboard.baseURL}/`);

      await page
        .getByRole("list", { name: "In flight" })
        .getByRole("link")
        .first()
        .click();
      await expect(page).toHaveURL(/\/conversations\//);
      await page.getByRole("link", { name: /^Back to / }).click();
      await expect(page).toHaveURL(`${dashboard.baseURL}/`);
    });
  });

  test.describe("on a touch phone", () => {
    test.use({ hasTouch: true, viewport: { height: 844, width: 390 } });

    test("+ focuses the composer each time, and Back into it does not", async ({
      dashboard,
      page,
    }) => {
      await mockReviewItems(page);
      await page.goto(`${dashboard.baseURL}/?view=inbox`);
      const composer = page.getByLabel("Start a conversation");
      await page.getByRole("button", { name: "New conversation" }).click();
      await expect(page).toHaveURL(/\/conversations\/new$/);
      await expect(composer).toBeFocused();

      // A browser Back into the composer is not a request to type.
      await page.getByRole("link", { name: "Back to Inbox" }).click();
      await page.goBack();
      await expect(composer).toBeVisible();
      await expect(composer).not.toBeFocused();

      // "+" asks again after the composer has shown. So does New in the
      // palette, from a page outside the Inbox that the composer replaces.
      await page.getByRole("link", { name: "Back to Inbox" }).click();
      await page.getByRole("button", { name: "New conversation" }).click();
      await expect(composer).toBeFocused();
      await page.goto(`${dashboard.baseURL}/settings`);
      await page.keyboard.press("ControlOrMeta+k");
      await page
        .getByRole("dialog", { name: "Go to conversation" })
        .getByRole("option", { name: "New conversation" })
        .click();
      await expect(page).toHaveURL(/\/conversations\/new$/);
      await expect(composer).toBeFocused();
    });
  });

  test("a click or Enter on a row opens its Conversation, and a pill expands it", async ({
    dashboard,
    page,
  }) => {
    // A Conversations row names its Conversation; an Inbox row names its
    // item.
    await mockReviewItems(page, { open: [rollout] });
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const list = page.getByRole("region", { name: "Conversations" });
    const head = rowHead(list, checkout);
    const row = head.locator("xpath=ancestor::*[@data-inbox-row][1]");
    const asks = page.getByRole("region", { name: `${checkout}: asks` });

    // The head is a link to the Conversation, not a disclosure.
    await expect(head).not.toHaveAttribute("aria-expanded");
    await head.click();
    await expect(page).toHaveURL(/\/conversations\//);
    await page.goBack();
    await head.press("Enter");
    await expect(page).toHaveURL(/\/conversations\//);
    await page.goBack();
    // A click on the head outside its link opens the Conversation too.
    await row.locator('[data-inbox-slot="dot"]').click();
    await expect(page).toHaveURL(/\/conversations\//);
    await page.goBack();
    await expect(row).not.toHaveAttribute("data-expanded");

    // Ctrl/⌘-click keeps the link: a new tab opens, and the list stays.
    const [tab] = await Promise.all([
      page.context().waitForEvent("page"),
      head.click({ modifiers: ["ControlOrMeta"] }),
    ]);
    await expect(tab).toHaveURL(/\/conversations\//);
    await tab.close();
    // So does a middle click on the head outside its link.
    const [middle] = await Promise.all([
      page.context().waitForEvent("page"),
      row.locator('[data-inbox-slot="dot"]').click({ button: "middle" }),
    ]);
    await expect(middle).toHaveURL(/\/conversations\//);
    await middle.close();
    await expect(page).toHaveURL(`${dashboard.baseURL}/?view=conversations`);

    // An ask pill expands the row in place.
    await expandRow(head);
    await expect(asks).toBeVisible();
    await expect(page).toHaveURL(`${dashboard.baseURL}/?view=conversations`);
    await asks.getByRole("link", { name: "Open conversation" }).click();
    await expect(page).toHaveURL(/\/conversations\//);
    await page.goBack();
    await openRow(head);
    await expect(page).toHaveURL(/\/conversations\//);
  });

  test("a row keeps its height under the pointer, and a click opens its Conversation", async ({
    dashboard,
    page,
  }) => {
    await page.clock.install();
    await mockReviewItems(page);
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const list = page.getByRole("region", { name: "Conversations" });
    const head = rowHead(list, checkout);
    const row = head.locator("xpath=ancestor::*[@data-inbox-row][1]");
    await expect(head).toBeVisible();
    const height = () =>
      row.evaluate((node) => (node as HTMLElement).offsetHeight);
    const before = await height();
    await head.hover();
    await page.clock.runFor(1000);
    expect(await height()).toBe(before);
    await head.click();
    await expect(page).toHaveURL(/\/conversations\//);
    await page.goBack();
    await expect(row).not.toHaveAttribute("data-expanded");
  });

  test("Open conversation shows the row's ask, far back in the transcript", async ({
    dashboard,
    page,
  }) => {
    const conversationId = "internal:question-qa";
    const ask = "Approve the payments-v42 rollout";
    // Long replies after the ask put it far above the latest message, where
    // the transcript opens.
    await page.route(
      (url) =>
        url.pathname ===
        `/api/conversations/${encodeURIComponent(conversationId)}`,
      async (route) => {
        const response = await route.fetch();
        const report = await response.json();
        if (!Array.isArray(report.events)) return route.fulfill({ response });
        const last = report.events.at(-1);
        const later = Array.from({ length: 40 }, (_, index) => ({
          createdAt: last.createdAt,
          data: {
            messageId: `qa-later-${index}`,
            role: "assistant",
            text: `Canary check ${index + 1}. ${"Error rate and latency hold steady across every region. ".repeat(6)}`,
            type: "message",
          },
          seq: last.seq + 1 + index,
        }));
        // The reader has read them all, so the transcript opens at the latest.
        await route.fulfill({
          response,
          json: {
            ...report,
            events: [...report.events, ...later],
            lastSeenAt: last.createdAt,
          },
        });
      },
    );
    // The mark is brief, so count every time a record gets it.
    await page.addInitScript(() => {
      const marks = { count: 0 };
      Object.assign(window, { askMarks: marks });
      new MutationObserver((changes) => {
        marks.count += changes.filter((change) =>
          (change.target as Element).hasAttribute("data-highlighted"),
        ).length;
      }).observe(document, {
        attributeFilter: ["data-highlighted"],
        subtree: true,
      });
    });
    await page.goto(`${dashboard.baseURL}/`);
    const row = page
      .getByRole("region", { name: "To do" })
      .locator("[data-inbox-row]")
      .filter({ hasText: "Roll out payments-v42" })
      .first();
    await row.hover();
    await row.getByRole("link", { name: "Open conversation" }).first().click();
    await expect(page).toHaveURL(
      new RegExp(`/conversations/${encodeURIComponent(conversationId)}$`),
    );
    const record = page
      .getByLabel("Conversation transcript")
      .locator("[data-review-item-ask]")
      .filter({ hasText: ask });
    // The record gets its mark once it scrolls into view. The transcript can
    // render from the top before it opens at the latest, so check the place
    // after the mark.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { askMarks?: { count: number } }).askMarks
              ?.count ?? 0,
        ),
      )
      .toBeGreaterThan(0);
    await expect(record).toBeInViewport();
  });
});
