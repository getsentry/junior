import { mockInboxItems, rowHead } from "./inbox-fixture";
import { expect, test } from "../test";

// Pins in In flight keep the viewer's order: only pins drag, and a drag
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
    await page.goto(`${dashboard.baseURL}/?view=conversations&pinned=1`);
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
