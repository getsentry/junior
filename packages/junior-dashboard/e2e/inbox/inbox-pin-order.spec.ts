import type { Page } from "@playwright/test";

import { mobile } from "../screenshot";
import { expect, test } from "../test";
import { holdTouch } from "./browserMenu";
import { mockInboxItems, rowHead } from "./inbox-fixture";

const PIN_TITLES = ["Alpha pin", "Bravo pin", "Charlie pin"];
const pinId = (index: number) => `slack:CPINS:${1770000000 + index}.000100`;

/**
 * Serve three idle pins in In flight, and keep the order that a reorder
 * saves, so the feed refetch after the save shows it.
 */
async function servePins(page: Page) {
  let order = PIN_TITLES.map((_, index) => pinId(index));
  await page.route("**/api/conversations/pin-order", (route) => {
    order = route.request().postDataJSON().conversationIds;
    return route.fulfill({ json: { conversationIds: order } });
  });
  await page.route(/\/api\/conversations(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const feed = await response.json();
    return route.fulfill({
      response,
      json: {
        ...feed,
        conversations: PIN_TITLES.map((displayTitle, index) => {
          const conversationId = pinId(index);
          return {
            ...feed.conversations[0],
            conversationId,
            displayTitle,
            isParticipant: true,
            pinnedAt: "2026-08-07T10:00:00.000Z",
            pinPosition: order.indexOf(conversationId),
            status: "done",
            turnActive: false,
          };
        }),
        nextCursor: undefined,
      },
    });
  });
  await mockInboxItems(page, { open: [] });
}

// Pins in In flight keep the viewer's order, above every busy row: only
// pins drag, and a drag, Alt+ArrowUp or Alt+ArrowDown, or the row menu
// saves that order.
// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
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
        turnActive: status === "working",
      });
      return route.fulfill({
        response,
        json: {
          ...feed,
          // Stored order Alpha, Bravo, Charlie. Charlie runs, and still
          // keeps its place.
          conversations: [
            pin(0, "Alpha pin", "done"),
            pin(1, "Bravo pin", "done"),
            pin(2, "Charlie pin", "working"),
          ],
          nextCursor: undefined,
        },
      });
    });
    await mockInboxItems(page, { open: [] });
    await page.goto(`${dashboard.baseURL}/inbox`);
    const inFlight = page.getByRole("list", { name: "In flight" });
    await expect(inFlight.getByRole("listitem")).toHaveText([
      /Alpha pin/,
      /Bravo pin/,
      /Charlie pin/,
    ]);
    // Every row shows, so there is nothing to expand.
    await expect(page.getByRole("button", { name: "Show all" })).toHaveCount(0);
    const save = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/api/conversations/pin-order"),
    );
    await inFlight.getByRole("link", { name: /Bravo pin/ }).focus();
    await page.keyboard.press("Alt+ArrowUp");
    expect((await save).request().postDataJSON()).toEqual({
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
        status: "done",
        turnActive: false,
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
    await mockInboxItems(page, { open: [] });
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations&pinned=1`);
    const inFlight = page.getByRole("list", { name: "In flight" });
    await expect(inFlight.getByRole("listitem")).toHaveCount(4);
    // Pinned lists every pin, and no other row.
    const pinned = page.getByRole("region", {
      exact: true,
      name: "Conversations",
    });
    await expect(pinned.locator("[data-inbox-row]")).toHaveCount(4);
    await expect(rowHead(pinned, "Recent conversation")).toHaveCount(0);

    const save = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/api/conversations/pin-order"),
    );
    await inFlight.getByRole("link", { name: /Old pin 2/ }).focus();
    await page.keyboard.press("Alt+ArrowUp");
    expect((await save).request().postDataJSON()).toEqual({
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
        status: pinned ? "done" : "working",
        turnActive: !pinned,
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
    await mockInboxItems(page, { open: [] });
    const saves: unknown[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        request.url().includes("/api/conversations/pin-order")
      )
        saves.push(request.postDataJSON());
    });
    await page.goto(`${dashboard.baseURL}/inbox`);
    const inFlight = page.getByRole("list", { name: "In flight" });
    // The running Conversation that is not pinned shows after the pins.
    await expect(inFlight.getByRole("listitem")).toHaveText([
      /Alpha pin/,
      /Bravo pin/,
      /Delta run/,
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
      /Alpha pin/,
      /Bravo pin/,
      /Delta run/,
    ]);
    expect(saves).toEqual([]);
    // A pin dropped on the running row lands on the nearest pin instead.
    const save = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/api/conversations/pin-order"),
    );
    await alpha.dragTo(running, { steps: 10 });
    expect((await save).request().postDataJSON()).toEqual({
      conversationIds: [
        "slack:CPINS:1770000001.000100",
        "slack:CPINS:1770000000.000100",
      ],
    });
  });

  test("the row menu moves a pin in In flight", async ({ dashboard, page }) => {
    await servePins(page);
    await page.goto(`${dashboard.baseURL}/inbox`);
    const inFlight = page.getByRole("list", { name: "In flight" });
    const rows = inFlight.getByRole("listitem");
    await expect(rows).toHaveText([/Alpha pin/, /Bravo pin/, /Charlie pin/]);
    const menu = page.getByRole("menu");

    // The first pin cannot move up.
    await inFlight
      .getByRole("link", { name: /Alpha pin/ })
      .click({ button: "right" });
    await expect(
      menu.getByRole("menuitem", { name: "Move up" }),
    ).toBeDisabled();
    await menu.getByRole("menuitem", { name: "Move down" }).click();
    await expect(rows).toHaveText([/Bravo pin/, /Alpha pin/, /Charlie pin/]);

    // The last pin cannot move down. The `⋯` menu has the same rows.
    await inFlight.getByRole("link", { name: /Charlie pin/ }).hover();
    await inFlight
      .getByRole("button", { name: "Open menu for Charlie pin" })
      .click();
    await expect(
      menu.getByRole("menuitem", { name: "Move down" }),
    ).toBeDisabled();
    await menu.getByRole("menuitem", { name: "Move up" }).click();
    await expect(rows).toHaveText([/Bravo pin/, /Charlie pin/, /Alpha pin/]);
  });

  test.describe("on a touch phone", () => {
    test.use({
      hasTouch: true,
      viewport: { height: mobile.height, width: mobile.width },
    });

    test("a long press on a pin opens the menu that moves it", async ({
      dashboard,
      page,
    }) => {
      await servePins(page);
      await page.goto(`${dashboard.baseURL}/inbox`);
      const inFlight = page.getByRole("list", { name: "In flight" });
      const rows = inFlight.getByRole("listitem");
      await expect(rows).toHaveText([/Alpha pin/, /Bravo pin/, /Charlie pin/]);
      const menu = page.getByRole("menu");

      // A finger held past the long press delay opens the row menu. Lift it
      // at once: emulated touch adds a mouse click to the lift, and the menu
      // closes on one that comes long after it opened.
      const lift = await holdTouch(
        page,
        inFlight.getByRole("link", { name: /Charlie pin/ }),
        { x: 40, y: 8 },
      );
      await expect(menu).toBeVisible();
      await lift();
      // The last pin cannot move down.
      await expect(
        menu.getByRole("menuitem", { name: "Move down" }),
      ).toBeDisabled();
      await menu.getByRole("menuitem", { name: "Move up" }).tap();
      await expect(rows).toHaveText([/Alpha pin/, /Charlie pin/, /Bravo pin/]);
    });
  });
});
