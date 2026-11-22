import { mockInboxItems, rowHead } from "./inbox-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const checkout = "Investigate checkout latency";

  test("In flight lists running and pinned Conversations, and the Inbox lists neither", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page);
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
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

    await inFlight.getByRole("link", { name: new RegExp(checkout) }).click();
    await expect(page).toHaveURL(/\/conversations\/slack%3ACQA123/);
  });

  test("In flight shows every pin past five running Conversations, and Show all lists the rest", async ({
    dashboard,
    page,
  }) => {
    await page.route(/\/api\/conversations(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      const feed = await response.json();
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
        response,
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
              pinPosition: 0,
              status: "working",
            }),
            conversation(7, "Idle pin", {
              pinnedAt: "2026-08-07T10:00:00.000Z",
              pinPosition: 1,
              status: "done",
            }),
          ],
          nextCursor: undefined,
        },
      });
    });
    await mockInboxItems(page, { open: [] });
    await page.goto(`${dashboard.baseURL}/`);
    const inFlight = page.getByRole("list", { name: "In flight" });
    // Pins always show. Running Conversations fill the rows left, up to five.
    await expect(
      inFlight.getByRole("link", { name: /Running pin/ }),
    ).toBeVisible();
    await expect(
      inFlight.getByRole("link", { name: /Idle pin/ }),
    ).toBeVisible();
    await expect(inFlight.getByRole("listitem")).toHaveCount(5);

    // Show all lists every in-flight row in place, in the same order.
    const showAll = page.getByRole("button", { name: "Show all" });
    await expect(showAll).toHaveAttribute("aria-expanded", "false");
    await showAll.click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
    await expect(inFlight.getByRole("listitem")).toHaveText([
      ...Array.from(
        { length: 6 },
        (_, index) => new RegExp(`Running conversation ${index + 1}`),
      ),
      /Running pin/,
      /Idle pin/,
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
    await inFlight.getByRole("link", { name: /Idle pin/ }).focus();
    await page.keyboard.press("Alt+ArrowUp");
    expect((await save).request().postDataJSON()).toEqual({
      conversationIds: [7, 6].map(
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
          // Stored order Alpha, Bravo, Charlie. Charlie runs, so In flight
          // shows it first.
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
    await page.goto(`${dashboard.baseURL}/`);
    const inFlight = page.getByRole("list", { name: "In flight" });
    await expect(inFlight.getByRole("listitem")).toHaveText([
      /Charlie pin/,
      /Alpha pin/,
      /Bravo pin/,
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
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const inFlight = page.getByRole("list", { name: "In flight" });
    await expect(inFlight.getByRole("listitem")).toHaveCount(4);
    const pinned = page.getByRole("region", { name: "Pinned" });
    await expect(pinned.locator("[data-inbox-row]")).toHaveCount(4);

    const save = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/api/conversations/pin-order"),
    );
    await rowHead(pinned, "Old pin 2").focus();
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
    const save = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/api/conversations/pin-order"),
    );
    await bravo.dragTo(running, { steps: 10 });
    expect((await save).request().postDataJSON()).toEqual({
      conversationIds: [
        "slack:CPINS:1770000001.000100",
        "slack:CPINS:1770000000.000100",
      ],
    });
  });
});
