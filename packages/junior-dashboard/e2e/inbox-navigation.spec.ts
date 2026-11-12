import type { Page } from "@playwright/test";
import {
  audit,
  mockReviewItems,
  openRow,
  rollout,
  rowHead,
} from "./inbox-fixture";
import { screenshot } from "./screenshot";
import { expect, test } from "./test";

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
  if ((await close.isVisible()) !== open) await (open ? toggle : close).click();
  await expect(open ? close : toggle).toBeVisible();
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
  await rowHead(list, checkout).click();
  // The open row pushes this one below the fold, so the reader scrolls.
  const triage = list.getByRole("link", { name: /^Checkout latency triage/ });
  await triage.scrollIntoViewIfNeeded();
  const top = await scroller.evaluate((node) => node.scrollTop);
  expect(top).toBeGreaterThan(0);
  await openRow(triage);
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
      .getByRole("region", { name: "Today" })
      .getByRole("link", { name: /^Checkout latency triage/ }),
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
    page.getByRole("navigation", { name: "Inbox" }).getByRole("link", {
      name: /^Inbox/,
    }),
  ).toBeVisible();
  await screenshot(page, "inbox-new-conversation", { lightTheme: true });
  await page.getByRole("link", { name: "Back to Inbox" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
});

test("In flight lists running and pinned Conversations", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/`);
  const inFlight = page.getByRole("list", { name: "In flight" });
  await expect(
    inFlight.getByRole("link", { name: new RegExp(checkout) }),
  ).toBeVisible();

  // A pin from a row joins In flight.
  const today = page.getByRole("region", { name: "Today" });
  await today.getByRole("link", { name: /^Roll out payments-v42/ }).hover();
  await today
    .getByRole("button", { name: "Pin Roll out payments-v42" })
    .click();
  await expect(
    inFlight.getByRole("link", { name: /Roll out payments-v42/ }),
  ).toBeVisible();
  await screenshot(page, "inbox-in-flight", { view: "desktop" });

  await inFlight.getByRole("link", { name: new RegExp(checkout) }).click();
  await expect(page).toHaveURL(/\/conversations\/slack%3ACQA123/);
  await page.getByRole("link", { name: "Show all" }).click();
  await expect(page).toHaveURL(/\/\?view=conversations$/);
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
  await expect(asks).toContainText(rollout.title);
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
  await expect(asks).toContainText(rollout.title);
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
  const asks = page.getByRole("region", { name: `${checkout}: asks` });
  await expect(asks).toContainText(rollout.title);

  const primary = page.getByRole("navigation", { name: "Primary" });
  await primary.getByRole("link", { name: /^Automations/ }).click();
  await expect(page).toHaveURL(/\/automations/);
  await primary.getByRole("link", { name: /^Inbox/ }).click();
  // `/` and `/?view=inbox` are one list with one place.
  await expect(page).toHaveURL(/\/(\?view=inbox)?$/);
  await expect(asks).toContainText(rollout.title);
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
      status: "completed",
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

test("In flight shows every pin past five running Conversations", async ({
  dashboard,
  page,
}) => {
  await page.route(/\/api\/conversations(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const feed = await response.json();
    const conversation = (
      index: number,
      displayTitle: string,
      fields: { pinnedAt: string | null; pinPosition?: number; status: string },
    ) => ({
      ...feed.conversations[0],
      conversationId: `slack:CFLIGHT:${1770000000 + index}.000100`,
      displayTitle,
      ...fields,
    });
    return route.fulfill({
      response,
      json: {
        ...feed,
        conversations: [
          ...Array.from({ length: 6 }, (_, index) =>
            conversation(index, `Running conversation ${index + 1}`, {
              pinnedAt: null,
              status: "active",
            }),
          ),
          conversation(6, "Running pin", {
            pinnedAt: "2026-08-07T10:00:00.000Z",
            pinPosition: 0,
            status: "active",
          }),
          conversation(7, "Idle pin", {
            pinnedAt: "2026-08-07T10:00:00.000Z",
            pinPosition: 1,
            status: "completed",
          }),
        ],
        nextCursor: undefined,
      },
    });
  });
  await mockReviewItems(page, { open: [] });
  await page.goto(`${dashboard.baseURL}/`);
  const inFlight = page.getByRole("list", { name: "In flight" });
  // Pins always show. Running Conversations fill the rows left, up to five.
  await expect(
    inFlight.getByRole("link", { name: /Running pin/ }),
  ).toBeVisible();
  await expect(inFlight.getByRole("link", { name: /Idle pin/ })).toBeVisible();
  await expect(inFlight.getByRole("listitem")).toHaveCount(5);
  await expect(page.getByRole("link", { name: "Show all" })).toBeVisible();
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
        status: "completed",
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

  // The Inbox shows its first rows. The failure does not stop the rows
  // that are already loaded from showing as the reader scrolls.
  await page
    .getByRole("navigation", { name: "Inbox" })
    .getByRole("link", { name: /^Inbox\b/ })
    .click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  const last = page.getByRole("link", { name: /Older conversation 40\b/ });
  await expect(async () => {
    await scrollToEnd("Inbox");
    await expect(last).toBeVisible({ timeout: 1000 });
  }).toPass();
  // Once they all show, Try again loads the failed page.
  await expect(async () => {
    await scrollToEnd("Inbox");
    await expect(retry).toBeVisible({ timeout: 1000 });
  }).toPass();
  expect(oldestAttempts).toBe(1);
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
    ).toContainText(rollout.title);
  });

  test("entries, then a list, then a Conversation, each with Back", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page);
    await page.goto(`${dashboard.baseURL}/`);
    const entries = page.getByRole("navigation", { name: "Inbox" });
    await expect(entries.getByRole("link", { name: /^Inbox/ })).toBeVisible();
    await screenshot(page, "inbox-phone-entries", { lightTheme: true });

    await entries.getByRole("link", { name: /^Inbox/ }).click();
    await expect(page).toHaveURL(/\/\?view=inbox$/);
    const todo = page.getByRole("region", { name: "To do" });
    await expect(
      todo.getByRole("link", { name: new RegExp(checkout) }),
    ).toBeVisible();
    await screenshot(page, "inbox-phone-list", { lightTheme: true });

    await rowHead(todo, checkout).click();
    const asks = page.getByRole("region", { name: `${checkout}: asks` });
    await expect(asks).toContainText(rollout.title);
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
    const entries = page.getByRole("navigation", { name: "Inbox" });
    // A list leaves its path as the place Back returns to.
    await entries.getByRole("link", { name: /^Decisions/ }).click();
    await expect(page).toHaveURL(/\/\?view=decisions$/);
    await page.getByRole("link", { name: "Back to the Inbox entries" }).click();
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

test("a click expands a row in place, and Open opens its Conversation", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/`);
  const todo = page.getByRole("region", { name: "To do" });
  const head = rowHead(todo, checkout);
  const asks = page.getByRole("region", { name: `${checkout}: asks` });

  await head.click();
  await expect(asks).toBeVisible();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await head.click();
  await expect(asks).toHaveCount(0);
  // Enter toggles it too.
  await head.press("Enter");
  await expect(asks).toBeVisible();

  // Ctrl/⌘-click keeps the link: a new tab opens, and the list stays.
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    head.click({ modifiers: ["ControlOrMeta"] }),
  ]);
  await expect(tab).toHaveURL(/\/conversations\//);
  await tab.close();
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await expect(asks).toBeVisible();

  await asks.getByRole("link", { name: "Open conversation" }).click();
  await expect(page).toHaveURL(/\/conversations\//);
  await page.goBack();
  await openRow(head);
  await expect(page).toHaveURL(/\/conversations\//);
});

test("a drag in In flight moves only that pin in the stored order", async ({
  dashboard,
  page,
}) => {
  await page.route(/\/api\/conversations(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const feed = await response.json();
    const pin = (index: number, displayTitle: string, status: string) => ({
      ...feed.conversations[0],
      conversationId: `slack:CPINS:${1770000000 + index}.000100`,
      displayTitle,
      isParticipant: true,
      pinnedAt: "2026-08-07T10:00:00.000Z",
      pinPosition: index,
      status,
    });
    return route.fulfill({
      response,
      json: {
        ...feed,
        // Stored order Alpha, Bravo, Charlie. Charlie runs, so In flight
        // shows it first.
        conversations: [
          pin(0, "Alpha pin", "completed"),
          pin(1, "Bravo pin", "completed"),
          pin(2, "Charlie pin", "active"),
        ],
        nextCursor: undefined,
      },
    });
  });
  await mockReviewItems(page, { open: [] });
  await page.goto(`${dashboard.baseURL}/`);
  const inFlight = page.getByRole("list", { name: "In flight" });
  await expect(inFlight.getByRole("listitem")).toHaveText([
    /Charlie pin/,
    /Alpha pin/,
    /Bravo pin/,
  ]);
  const save = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().includes("/api/conversations/pin-order"),
  );
  await inFlight.getByRole("link", { name: /Bravo pin/ }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  expect((await save).postDataJSON()).toEqual({
    conversationIds: [
      "slack:CPINS:1770000001.000100",
      "slack:CPINS:1770000000.000100",
      "slack:CPINS:1770000002.000100",
    ],
  });
});

test("every pin shows on the first feed page, and a reorder saves them all", async ({
  dashboard,
  page,
}) => {
  // The server's first feed page has every pin, before the page by activity
  // (`readConversationFeedFromSql`). Here the pins are idle for weeks, and
  // more pages follow.
  await page.route(/\/api\/conversations(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const feed = await response.json();
    const row = (index: number, displayTitle: string, pinned: boolean) => ({
      ...feed.conversations[0],
      conversationId: `slack:CFEED:${1770000000 + index}.000100`,
      displayTitle,
      isParticipant: true,
      lastMessageAt: pinned
        ? "2026-07-01T10:00:00.000Z"
        : "2026-08-07T10:00:00.000Z",
      pinnedAt: pinned ? "2026-07-01T10:00:00.000Z" : null,
      pinPosition: pinned ? index : undefined,
      status: "completed",
    });
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return route.fulfill({
      response,
      json: cursor
        ? { ...feed, conversations: [], nextCursor: undefined }
        : {
            ...feed,
            conversations: [
              ...Array.from({ length: 4 }, (_, index) =>
                row(index, `Old pin ${index + 1}`, true),
              ),
              row(4, "Recent conversation", false),
            ],
            nextCursor: "page-2",
          },
    });
  });
  await mockReviewItems(page, { open: [] });
  await page.goto(`${dashboard.baseURL}/?view=conversations`);
  const inFlight = page.getByRole("list", { name: "In flight" });
  await expect(inFlight.getByRole("listitem")).toHaveCount(4);
  const pinned = page.getByRole("region", { name: "Pinned" });
  await expect(pinned.locator("[data-inbox-row]")).toHaveCount(4);

  const save = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().includes("/api/conversations/pin-order"),
  );
  await rowHead(pinned, "Old pin 2").focus();
  await page.keyboard.press("Alt+ArrowUp");
  expect((await save).postDataJSON()).toEqual({
    conversationIds: [1, 0, 2, 3].map(
      (index) => `slack:CFEED:${1770000000 + index}.000100`,
    ),
  });
});

test("only pins drag in In flight", async ({ dashboard, page }) => {
  await page.route(/\/api\/conversations(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const feed = await response.json();
    const row = (index: number, displayTitle: string, pinned: boolean) => ({
      ...feed.conversations[0],
      conversationId: `slack:CPINS:${1770000000 + index}.000100`,
      displayTitle,
      isParticipant: true,
      pinnedAt: pinned ? "2026-08-07T10:00:00.000Z" : null,
      pinPosition: pinned ? index : undefined,
      status: pinned ? "completed" : "active",
    });
    return route.fulfill({
      response,
      json: {
        ...feed,
        conversations: [
          row(0, "Alpha pin", true),
          row(1, "Bravo pin", true),
          row(2, "Delta run", false),
        ],
        nextCursor: undefined,
      },
    });
  });
  await mockReviewItems(page, { open: [] });
  const saves: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      request.url().includes("/api/conversations/pin-order")
    )
      saves.push(request.postDataJSON());
  });
  await page.goto(`${dashboard.baseURL}/`);
  const inFlight = page.getByRole("list", { name: "In flight" });
  // The running Conversation that is not pinned shows first.
  await expect(inFlight.getByRole("listitem")).toHaveText([
    /Delta run/,
    /Alpha pin/,
    /Bravo pin/,
  ]);
  const running = inFlight.getByRole("link", { name: /Delta run/ });
  const alpha = inFlight.getByRole("link", { name: /Alpha pin/ });
  const bravo = inFlight.getByRole("link", { name: /Bravo pin/ });
  // A row that is not a pin offers no reorder keys, and a drag of it saves
  // nothing and moves nothing.
  await expect(running).not.toHaveAttribute("aria-keyshortcuts");
  await expect(alpha).toHaveAttribute(
    "aria-keyshortcuts",
    "Alt+ArrowUp Alt+ArrowDown",
  );
  await running.dragTo(bravo, { steps: 10 });
  await expect(inFlight.getByRole("listitem")).toHaveText([
    /Delta run/,
    /Alpha pin/,
    /Bravo pin/,
  ]);
  expect(saves).toEqual([]);
  // A pin dropped on the running row lands on the nearest pin instead.
  const save = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().includes("/api/conversations/pin-order"),
  );
  await bravo.dragTo(running, { steps: 10 });
  expect((await save).postDataJSON()).toEqual({
    conversationIds: [
      "slack:CPINS:1770000001.000100",
      "slack:CPINS:1770000000.000100",
    ],
  });
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
          (window as unknown as { askMarks: { count: number } }).askMarks.count,
      ),
    )
    .toBeGreaterThan(0);
  await expect(record).toBeInViewport();
});
