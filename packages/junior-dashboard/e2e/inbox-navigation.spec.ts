import type { Page } from "@playwright/test";
import { mockReviewItems, rollout } from "./inbox-fixture";
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
});

test.describe("on a phone", () => {
  test.use({ viewport: { height: 844, width: 390 } });

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
