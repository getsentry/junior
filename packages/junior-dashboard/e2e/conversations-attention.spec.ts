import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";
import { screenshot } from "./screenshot";
import { viewAsParticipant } from "./conversationMenu";

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";

/** The Conversations bundle, which lists every Conversation with its menu. */
function conversationsList(page: Page): Locator {
  return page.getByRole("region", { name: "Conversations", exact: true });
}

/** Label of the list section that holds the first row matching `title`. */
async function sectionOf(
  list: Locator,
  title: RegExp,
): Promise<string | undefined> {
  return list
    .locator("section[aria-label]")
    .filter({ has: list.page().getByRole("link", { name: title }) })
    .first()
    .getAttribute("aria-label");
}

test.describe("conversation rows", () => {
  test("pinning moves a conversation to Pinned and In flight", async ({
    page,
    dashboard,
  }) => {
    await viewAsParticipant(page);
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const list = conversationsList(page);
    const row = list.getByRole("link", {
      name: /^Investigate checkout latency/,
    });
    await expect(row).toBeVisible();
    await expect
      .poll(() => sectionOf(list, /^Investigate checkout/))
      .not.toBe("Pinned");

    // Pin from the row's hover action.
    const pinRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" && request.url().endsWith("/pin"),
    );
    await row.hover();
    await list
      .getByRole("button", { name: "Pin Investigate checkout latency" })
      .click();
    expect((await pinRequest).postDataJSON()).toEqual({ pinned: true });

    // The row shows only in Pinned, and In flight lists it.
    await expect(row).toHaveCount(1);
    await expect
      .poll(() => sectionOf(list, /^Investigate checkout/))
      .toBe("Pinned");
    await expect(
      page
        .getByRole("list", { name: "In flight" })
        .getByRole("link", { name: /Investigate checkout latency/ }),
    ).toBeVisible();
    await row.hover();
    await expect(
      list.getByRole("button", { name: "Unpin Investigate checkout latency" }),
    ).toHaveAttribute("aria-pressed", "true");
    await screenshot(page, "conversations-pinned", {
      lightTheme: true,
      view: "desktop",
    });

    // Unpin from the conversation `⋯` menu.
    await row.click();
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("button", { name: "Unpin", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Pin", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "Back to Conversations" }).click();
    await expect(row).toBeVisible();
    await expect
      .poll(() => sectionOf(list, /^Investigate checkout/))
      .not.toBe("Pinned");
  });

  test("keeps an unread conversation in its place until marked read", async ({
    page,
    dashboard,
  }) => {
    // Only participants can mark read.
    await viewAsParticipant(page);
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const list = conversationsList(page);
    const finishedRow = list.getByRole("link", {
      name: /Closed issue summary/,
    });
    const unreadDot = finishedRow.getByLabel("Unread");
    const finishedSection = () => sectionOf(list, /Closed issue summary/);
    await expect(finishedRow).toBeVisible();
    await expect(unreadDot).toHaveCount(0);
    // Unread does not move a row.
    await expect.poll(finishedSection).toMatch(/^\w/);
    const home = await finishedSection();

    const unreadRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" && request.url().endsWith("/unread"),
    );
    await finishedRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mark as unread" }).click();
    expect((await unreadRequest).postDataJSON()).toEqual({ unread: true });
    await expect(unreadDot).toBeVisible();
    await expect.poll(finishedSection).toBe(home);

    // The server keeps it, so a reload or another device sees it too.
    await page.reload();
    await expect(unreadDot).toBeVisible();

    // Opening it is not an act on it, so it stays unread and in place.
    await finishedRow.click();
    await expect(
      page.getByRole("heading", { name: "Closed issue summary" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Back to Conversations" }).click();
    await expect(unreadDot).toBeVisible();
    await expect.poll(finishedSection).toBe(home);

    await finishedRow.click({ button: "right" });
    // The row menu shows the rows of the `⋯` menu, in the same order.
    await expect(page.getByRole("menuitem")).toHaveText([
      "Share",
      "Copy as Markdown",
      "Open event log",
      "Mark as read",
      "Pin",
      "Rename",
      "Subscribe",
      "Archive",
    ]);
    await screenshot(page, "conversation-row-context-menu", {
      lightTheme: true,
      view: "desktop",
    });
    await page.getByRole("menuitem", { name: "Mark as read" }).click();
    await expect(unreadDot).toHaveCount(0);
    await expect.poll(finishedSection).toBe(home);

    // The read toggle beside the title marks it too.
    const markUnread = list.getByRole("button", {
      name: /^Mark Closed issue summary.* as unread$/,
    });
    await finishedRow.hover();
    await markUnread.click();
    await expect(unreadDot).toBeVisible();
    await expect.poll(finishedSection).toBe(home);
    await list
      .getByRole("button", { name: /^Mark Closed issue summary.* as read$/ })
      .click();
    await expect(unreadDot).toHaveCount(0);

    // Reading it is an act: input in the transcript reports the rows in view.
    await finishedRow.hover();
    await markUnread.click();
    await expect(unreadDot).toBeVisible();
    await finishedRow.click();
    await page.getByLabel("Conversation transcript").hover();
    await page.mouse.wheel(0, 1);
    await page.getByRole("link", { name: "Back to Conversations" }).click();
    await expect(unreadDot).toHaveCount(0);
    await expect.poll(finishedSection).toBe(home);
  });

  test("marks a conversation read or unread from its menu on mobile", async ({
    page,
    dashboard,
  }) => {
    // Below 768px there is no sidebar, so the conversation menu is the way.
    await page.setViewportSize({ height: 844, width: 390 });
    // Only participants can mark read. Make the viewer one of this mock.
    await page.route(
      /\/api\/conversations\/agent-dispatch%3Aevent-1(?:\?.*)?$/,
      async (route) => {
        const response = await route.fetch();
        if (response.status() !== 200) return route.fulfill({ response });
        const detail = await response.json();
        await route.fulfill({
          response,
          json: { ...detail, isParticipant: true },
        });
      },
    );
    // A deep link, so the menu cannot lean on a loaded feed row.
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("agent-dispatch:event-1")}`,
    );
    await expect(
      page.getByRole("heading", { name: "Closed issue summary" }),
    ).toBeVisible();

    const menu = page.getByRole("button", { name: "Conversation menu" });
    const requests: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() === "PATCH" && request.url().endsWith("/unread")) {
        requests.push(request.postDataJSON());
      }
    });
    // The menu stays open, like Pin, so the label flips in place.
    await menu.click();
    await expect(
      page.getByRole("button", { name: "Mark as unread" }),
    ).toBeVisible();
    await screenshot(page, "conversation-menu-mark-unread", { view: "mobile" });
    await page.getByRole("button", { name: "Mark as unread" }).click();
    await page.getByRole("button", { name: "Mark as read" }).click();
    await expect(
      page.getByRole("button", { name: "Mark as unread" }),
    ).toBeVisible();
    expect(requests).toEqual([{ unread: true }, { unread: false }]);
  });

  test("renames a conversation from the row menu", async ({
    page,
    dashboard,
  }) => {
    await viewAsParticipant(page);
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const list = conversationsList(page);
    const renameRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" && request.url().endsWith("/title"),
    );
    await list
      .getByRole("link", { name: /Closed issue summary/ })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const titleInput = page.getByRole("textbox", { name: "Title" });
    await expect(titleInput).toBeFocused();
    await expect(titleInput).toHaveValue("Closed issue summary");
    await titleInput.fill("  Closed issue follow-up ");
    await page.getByRole("button", { name: "Save" }).click();
    expect((await renameRequest).postDataJSON()).toEqual({
      title: "Closed issue follow-up",
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const renamedRow = list.getByRole("link", {
      name: /Closed issue follow-up/,
    });
    await expect(renamedRow).toBeVisible();

    await page.reload();
    await expect(renamedRow).toBeVisible();

    // The `⋯` menu renames too.
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
    );
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Investigate checkout latency",
    );
  });
});
