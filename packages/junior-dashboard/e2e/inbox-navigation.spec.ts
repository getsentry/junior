import type { Page } from "@playwright/test";
import { audit, mockReviewItems, rollout } from "./inbox-fixture";
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
  await page.getByRole("button", { name: `Show asks in ${checkout}` }).click();
  // The open row pushes this one below the fold, so the reader scrolls.
  const triage = list.getByRole("link", { name: /^Checkout latency triage/ });
  await triage.scrollIntoViewIfNeeded();
  const top = await scroller.evaluate((node) => node.scrollTop);
  expect(top).toBeGreaterThan(0);
  await triage.click();
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
  await triage.click();
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
  await page
    .getByRole("region", { name: "Today" })
    .getByRole("link", { name: /^Checkout latency triage/ })
    .click();
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
  await list
    .locator(".overflow-y-auto")
    .first()
    .evaluate((node) => (node.scrollTop = node.scrollHeight));
  await expect(older).toBeVisible();
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

    await page
      .getByRole("button", { name: `Show asks in ${checkout}` })
      .click();
    await expect(
      page.getByRole("region", { name: `${checkout}: asks` }),
    ).toContainText(rollout.title);
    await todo.getByRole("link", { name: new RegExp(checkout) }).click();
    await expect(page).toHaveURL(/\/conversations\//);
    await page.getByRole("link", { name: "Back to Inbox" }).click();
    await expect(page).toHaveURL(/\/\?view=inbox$/);
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
