import { waitForOutlineRead } from "../harness";
import { mockInboxItems } from "./inbox-fixture";
import { desktop, screenshot } from "../screenshot";
import { expect, test } from "../test";
import { mockFeedPage } from "../mock-reports";

test.describe("new UI", () => {
  const checkout = "Investigate checkout latency";

  test("In flight lists running and pinned Conversations, and the Inbox lists neither", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page);
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    const inFlight = page.getByRole("list", { name: "In flight" });
    await expect(
      inFlight.getByRole("link", { name: new RegExp(checkout) }),
    ).toBeVisible();

    // A pin from a row joins In flight.
    const list = page.getByRole("region", {
      exact: true,
      name: "Conversations",
    });
    await list.getByRole("link", { name: /^Roll out payments-v42/ }).hover();
    await list
      .getByRole("button", { name: "Pin Roll out payments-v42" })
      .click();
    const pinned = inFlight.getByRole("link", {
      name: /Roll out payments-v42/,
    });
    await expect(pinned).toBeVisible();
    // Its pin leads the row and stays on hover, while the `⋯` shows on
    // the right.
    const pin = inFlight
      .getByRole("listitem")
      .filter({
        has: page.getByRole("link", { name: /Roll out payments-v42/ }),
      })
      .getByRole("img", { name: "Pinned" });
    await expect(pin).toHaveCount(1);
    await expect(pin).toBeVisible();
    // The shot keeps the pointer only at its own size.
    await page.setViewportSize(desktop);
    await pinned.hover();
    await expect(
      inFlight.getByRole("button", {
        name: /^Open menu for Roll out payments-v42/,
      }),
    ).toBeVisible();
    await expect(pin).toBeVisible();
    await screenshot(page, "inbox-in-flight-hover", {
      lightTheme: true,
      target: inFlight,
      view: "desktop",
    });
    // A right-click on an In flight row opens its Conversation menu.
    const menu = page.getByRole("menu");
    await pinned.click({ button: "right" });
    await expect(menu.getByRole("menuitem", { name: "Unpin" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/inbox?view=conversations`,
    );
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    // On hover, its `⋯` opens the same menu.
    await pinned.hover();
    await inFlight
      .getByRole("button", {
        name: /^Open menu for Roll out payments-v42/,
      })
      .click();
    await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // The Inbox lists what needs the viewer. A pinned or running
    // Conversation shows only in In flight.
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox/ })
      .click();
    const inbox = page.getByRole("region", { exact: true, name: "Inbox" });
    await expect(inbox.getByRole("region", { name: "To do" })).toBeVisible();
    await expect(
      inbox.getByRole("link", { name: /^Roll out payments-v42/ }),
    ).toHaveCount(0);
    await expect(pinned).toBeVisible();
    await screenshot(page, "inbox-in-flight", { view: "desktop" });

    const outlineRead = waitForOutlineRead(
      page,
      "slack:CQA123:1770003600.000200",
    );
    await inFlight.getByRole("link", { name: new RegExp(checkout) }).click();
    await expect(page).toHaveURL(/\/conversations\/slack%3ACQA123/);
    await outlineRead;
  });

  test("In flight shows every pin first, in the stored order, and Show all lists the rest", async ({
    dashboard,
    page,
  }) => {
    await page.route(/\/api\/conversations(\?.*)?$/, async (route) => {
      const feed = await mockFeedPage(route);
      const conversation = (
        index: number,
        displayTitle: string,
        fields: {
          pinnedAt: string | null;
          pinPosition?: number;
          status: string;
          turnActive?: boolean;
        },
      ) => ({
        ...feed.conversations[0],
        conversationId: `slack:CFLIGHT:${1770000000 + index}.000100`,
        displayTitle,
        turnActive: fields.status === "working",
        ...fields,
      });
      return route.fulfill({
        json: {
          ...feed,
          conversations: [
            ...Array.from({ length: 6 }, (_, index) =>
              conversation(index, `Running conversation ${index + 1}`, {
                pinnedAt: null,
                // An open action item reads `needs_input` while a Turn
                // runs. It still runs, so it is in flight.
                ...(index === 0
                  ? { status: "needs_input", turnActive: true }
                  : { status: "working" }),
              }),
            ),
            conversation(6, "Running pin", {
              pinnedAt: "2026-08-07T10:00:00.000Z",
              pinPosition: 1,
              status: "working",
            }),
            conversation(7, "Idle pin", {
              pinnedAt: "2026-08-07T10:00:00.000Z",
              pinPosition: 0,
              status: "done",
            }),
          ],
          nextCursor: undefined,
        },
      });
    });
    await mockInboxItems(page, { open: [] });
    await page.goto(`${dashboard.baseURL}/inbox`);
    const inFlight = page.getByRole("list", { name: "In flight" });
    // Pins show first, in the stored order, whether they run or not.
    // Running Conversations fill the rows left, up to five.
    await expect(inFlight.getByRole("listitem")).toHaveText([
      /Idle pin/,
      /Running pin/,
      /Running conversation 1/,
      /Running conversation 2/,
      /Running conversation 3/,
    ]);

    // Show all lists every in-flight row in place, in the same order.
    const showAll = page.getByRole("button", { name: "Show all" });
    await expect(showAll).toHaveAttribute("aria-expanded", "false");
    await showAll.click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/inbox`);
    await expect(inFlight.getByRole("listitem")).toHaveText([
      /Idle pin/,
      /Running pin/,
      ...Array.from(
        { length: 6 },
        (_, index) => new RegExp(`Running conversation ${index + 1}`),
      ),
    ]);
    const showFewer = page.getByRole("button", { name: "Show fewer" });
    await expect(showFewer).toHaveAttribute("aria-expanded", "true");
    await screenshot(page, "inbox-in-flight-expanded", { lightTheme: true });

    // A pin still drags while the list is expanded.
    const save = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/api/conversations/pin-order"),
    );
    await inFlight.getByRole("link", { name: /Running pin/ }).focus();
    await page.keyboard.press("Alt+ArrowUp");
    expect((await save).request().postDataJSON()).toEqual({
      conversationIds: [6, 7].map(
        (index) => `slack:CFLIGHT:${1770000000 + index}.000100`,
      ),
    });

    // The list stays expanded when a row opens its Conversation.
    await inFlight
      .getByRole("link", { name: /Running conversation 6/ })
      .click();
    await expect(page).toHaveURL(/\/conversations\/slack%3ACFLIGHT/);
    await expect(inFlight.getByRole("listitem")).toHaveCount(8);

    await showFewer.click();
    await expect(inFlight.getByRole("listitem")).toHaveCount(5);
    await expect(showAll).toHaveAttribute("aria-expanded", "false");
  });
});
