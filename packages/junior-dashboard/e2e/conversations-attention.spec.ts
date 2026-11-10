import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";
import { screenshot } from "./screenshot";
import { viewAsParticipant } from "./conversationMenu";

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const WAITING_CONVERSATION_ID = "slack:CQA123:1770000000.000100";

const READY_TITLE = "Ready to merge · #42";

const reviewItem = {
  assignedToEveryone: false,
  assignees: [
    {
      displayName: "Dashboard User",
      email: "dev@example.com",
      userId: "u-dev",
    },
  ],
  body: "The checkout fix is ready.",
  canAct: true,
  canTake: false,
  createdAt: "2026-08-07T08:00:00.000Z",
  id: "item-checkout-fix",
  kind: "action" as const,
  request: {
    question: "Merge the checkout fix?",
    fields: [
      {
        id: "go",
        kind: "choice",
        label: "Merge",
        options: [{ label: "Merge" }, { label: "Hold" }],
      },
    ],
  },
  status: "open" as const,
  title: "Approve the checkout fix",
  updatedAt: "2026-08-07T08:30:00.000Z",
  visibility: "public" as const,
};

/**
 * Make one conversation wait on the viewer with two open Review items: a
 * GitHub ask, then the agent's question.
 */
async function mockWaitingConversation(
  page: Page,
  waitingId = WAITING_CONVERSATION_ID,
) {
  await page.route("**/api/review-items**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/review-items/, "");
    if (path === "/waiting-conversations") {
      return route.fulfill({
        json: {
          conversations: [
            {
              conversationId: waitingId,
              items: [
                { plugin: "github", title: READY_TITLE },
                { title: reviewItem.title },
              ],
              waitingSince: reviewItem.createdAt,
            },
          ],
        },
      });
    }
    if (path === "/count") return route.fulfill({ json: { needsViewer: 2 } });
    if (path === "" || path === "/") {
      const conversationId = url.searchParams.get("conversationId");
      return route.fulfill({
        json: {
          items:
            !conversationId || conversationId === waitingId
              ? [
                  {
                    ...reviewItem,
                    addedByConversationId: waitingId,
                    conversationIds: [waitingId],
                  },
                ]
              : [],
        },
      });
    }
    return route.fulfill({ json: { error: "Not found" }, status: 404 });
  });
}

/** Label of the sidebar section that lists the first row matching `title`. */
async function sidebarSectionOf(
  sidebar: Locator,
  title: RegExp,
): Promise<string | undefined> {
  const items = await sidebar
    .locator("button[aria-expanded], a")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        heading: element.tagName === "BUTTON",
        text: element.textContent?.trim() ?? "",
      })),
    );
  let section: string | undefined;
  for (const item of items) {
    if (item.heading) section = item.text;
    else if (title.test(item.text)) return section;
  }
  return undefined;
}

/**
 * Serve versions and a feed that a test can change, so the feed poll picks
 * up an old last Message on the waiting conversation, which moves it to a
 * section of its own.
 */
async function mockChangingActivity(page: Page) {
  let movedAt: string | undefined;
  const versions = {
    conversations: "feed-1",
    reviewItems: "review-1",
    spend: "spend-1",
  };
  await page.route("**/api/versions*", (route) =>
    route.fulfill({ json: versions }),
  );
  await page.route(
    (url) => url.pathname === "/api/conversations",
    async (route) => {
      const response = await route.fetch();
      const feed = (await response.json()) as {
        conversations: { conversationId: string; lastMessageAt?: string }[];
      };
      if (movedAt) {
        for (const conversation of feed.conversations) {
          if (conversation.conversationId === WAITING_CONVERSATION_ID) {
            conversation.lastMessageAt = movedAt;
          }
        }
      }
      await route.fulfill({ json: feed, response });
    },
  );
  /** Move the row to January 2020 or back, and move the poll token. */
  return (next: boolean) => {
    movedAt = next ? "2020-01-01T00:00:00.000Z" : undefined;
    versions.conversations = `feed-${next ? 2 : 3}-${Date.now()}`;
  };
}

test.describe("conversation sections", () => {
  test("marks waiting conversations and links to them in the Inbox", async ({
    page,
    dashboard,
  }) => {
    await mockWaitingConversation(page);
    await page.goto(dashboard.baseURL);

    const sidebar = page.getByRole("navigation", {
      name: "Your conversations",
    });
    const waitingRow = sidebar.getByRole("link", {
      name: /Checkout latency triage/,
    });
    // A waiting row keeps its place in its time section, with a marker.
    await expect(
      waitingRow.getByRole("img", { name: "Waiting on you" }),
    ).toBeVisible();
    await expect(sidebar.getByText("Needs you", { exact: true })).toBeVisible();
    const section = await sidebarSectionOf(sidebar, /Checkout latency triage/);
    expect(section).toMatch(/^\w/);
    await expect(
      page.getByRole("link", { name: /^\d+ conversations? needs? you$/ }),
    ).toHaveAttribute("href", "/review?filter=needs-you&group=conversation");
    await screenshot(page, "conversations-needs-you");

    const heading = sidebar.locator("button[aria-expanded]", {
      hasText: section!,
    });
    await heading.click();
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await expect(waitingRow).toHaveCount(0);
    await screenshot(page, "conversations-sections-collapsed");

    await page.reload();
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await expect(waitingRow).toHaveCount(0);

    await heading.click();
    await expect(waitingRow).toBeVisible();
  });

  test("pinning moves a conversation to Pinned only", async ({
    page,
    dashboard,
  }) => {
    await mockWaitingConversation(page, ACTIVE_CONVERSATION_ID);
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
    );
    const sidebar = page.getByRole("navigation", {
      name: "Your conversations",
    });
    const activeRows = sidebar.getByRole("link", {
      name: /Investigate checkout latency/,
    });
    await expect(activeRows).toBeVisible();
    await expect(sidebar.getByRole("button").first()).not.toHaveText(/^Pinned/);

    // Pin from the row's hover action in the sidebar.
    const pinRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" && request.url().endsWith("/pin"),
    );
    await activeRows.hover();
    await sidebar
      .getByRole("button", { name: "Pin Investigate checkout latency" })
      .click();
    expect((await pinRequest).postDataJSON()).toEqual({ pinned: true });

    await expect(sidebar.getByRole("button").first()).toHaveText(/^Pinned/);
    // The row shows only in Pinned.
    await expect(activeRows).toHaveCount(1);
    await expect
      .poll(() => sidebarSectionOf(sidebar, /Investigate checkout latency/))
      .toMatch(/^Pinned/);
    await expect(
      activeRows.getByRole("img", { name: "Waiting on you" }),
    ).toBeVisible();
    await activeRows.hover();
    await expect(
      sidebar.getByRole("button", {
        name: "Unpin Investigate checkout latency",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await screenshot(page, "conversations-pinned", {
      lightTheme: true,
      view: "desktop",
    });

    await page.reload();
    await expect(sidebar.getByRole("button").first()).toHaveText(/^Pinned/);

    // Unpin from the conversation `⋯` menu.
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("button", { name: "Unpin", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Pin", exact: true }),
    ).toBeVisible();
    await expect(sidebar.getByRole("button").first()).not.toHaveText(/^Pinned/);
  });

  test("keeps an unread conversation in its place until marked read", async ({
    page,
    dashboard,
  }) => {
    // Only participants can mark read.
    await viewAsParticipant(page);
    await page.goto(dashboard.baseURL);

    const sidebar = page.getByRole("navigation", {
      name: "Your conversations",
    });
    const finishedRow = sidebar.getByRole("link", {
      name: /Closed issue summary/,
    });
    const unreadDot = finishedRow.getByRole("img", { name: "Unread" });
    const finishedSection = () =>
      sidebarSectionOf(sidebar, /Closed issue summary/);
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
    await expect(finishedRow).toHaveAttribute("aria-current", "page");
    await expect(unreadDot).toBeVisible();
    await expect.poll(finishedSection).toBe(home);
    await screenshot(page, "conversation-open-unread", { view: "desktop" });
    await sidebar
      .getByRole("link", { name: /Checkout latency triage/ })
      .click();
    await expect(finishedRow).not.toHaveAttribute("aria-current", "page");
    await expect(unreadDot).toBeVisible();

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
    await screenshot(page, "conversation-sidebar-context-menu", {
      lightTheme: true,
      view: "desktop",
    });
    await page.getByRole("menuitem", { name: "Mark as read" }).click();
    await expect(unreadDot).toHaveCount(0);
    await expect.poll(finishedSection).toBe(home);

    await page.reload();
    await expect(finishedRow).toBeVisible();
    await expect(unreadDot).toHaveCount(0);

    // The leading marker toggles read state too.
    const markUnread = sidebar.getByRole("button", {
      name: /^Mark Closed issue summary.* as unread$/,
    });
    await markUnread.hover();
    await screenshot(page, "conversation-sidebar-read-toggle", {
      view: "desktop",
    });
    await markUnread.click();
    await expect(unreadDot).toBeVisible();
    await expect.poll(finishedSection).toBe(home);
    await sidebar
      .getByRole("button", { name: /^Mark Closed issue summary.* as read$/ })
      .click();
    await expect(unreadDot).toHaveCount(0);

    // Reading it is an act: input in the transcript reports the rows in view.
    await markUnread.click();
    await finishedRow.click();
    await expect(unreadDot).toBeVisible();
    await page.getByLabel("Conversation transcript").hover();
    await page.mouse.wheel(0, 1);
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
    await page.goto(dashboard.baseURL);
    const sidebar = page.getByRole("navigation", {
      name: "Your conversations",
    });
    const renameRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" && request.url().endsWith("/title"),
    );
    await sidebar
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
    const renamedRow = sidebar.getByRole("link", {
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

  test("the sidebar review chip opens details at Needs you", async ({
    page,
    dashboard,
  }) => {
    // The mock waiting conversation has an expired transcript, so use one
    // with live history.
    await mockWaitingConversation(page, ACTIVE_CONVERSATION_ID);
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(WAITING_CONVERSATION_ID)}`,
    );
    const sidebar = page.getByRole("navigation", {
      name: "Your conversations",
    });
    const waitingRow = sidebar.getByRole("link", {
      name: /Investigate checkout latency/,
    });
    const chip = sidebar.getByRole("link", { name: /Ready to merge · #42/ });
    await expect(
      waitingRow.getByRole("img", { name: "Waiting on you" }),
    ).toBeVisible();
    await expect(chip).toContainText("+1 more");
    // The newest item comes from GitHub, so the chip shows its mark.
    await expect(chip.getByRole("img", { name: "GitHub" })).toBeVisible();
    await expect(chip).not.toHaveAttribute("title");
    await screenshot(page, "conversation-sidebar-review-chip", {
      lightTheme: true,
      view: "desktop",
    });
    // The tooltip lists every waiting item in full.
    await chip.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip.getByRole("listitem")).toHaveText([
      READY_TITLE,
      reviewItem.title,
    ]);
    await screenshot(page, "conversation-sidebar-review-chip-tooltip", {
      view: "desktop",
    });

    await chip.click();
    await expect(page).toHaveURL(
      (url) =>
        decodeURIComponent(url.pathname).endsWith(ACTIVE_CONVERSATION_ID) &&
        url.searchParams.get("review") === "open",
    );
    const details = page.getByRole("complementary", {
      name: "Conversation details",
      exact: true,
    });
    await expect(
      details
        .getByRole("region", { name: "Needs you" })
        .getByText("Merge the checkout fix?"),
    ).toBeVisible();

    await details
      .getByRole("button", { name: "Close conversation details" })
      .click();
    await expect(details).toHaveCount(0);
    await expect(page).not.toHaveURL(/review=/);

    // With details already open, the chip still expands the question.
    await page
      .getByRole("button", { name: "Conversation details", exact: true })
      .click();
    const question = details
      .getByRole("region", { name: "Needs you" })
      .getByText("Merge the checkout fix?");
    await expect(question).toBeHidden();
    await chip.click();
    await expect(question).toBeVisible();
    await details
      .getByRole("button", { name: "Close conversation details" })
      .click();
  });
});

test.describe("stable conversation list", () => {
  test("holds the order under the pointer and offers the new one", async ({
    page,
    dashboard,
  }) => {
    // Real versions poll interval.
    test.setTimeout(60_000);
    const setOld = await mockChangingActivity(page);
    await page.goto(dashboard.baseURL);
    const sidebar = page.getByRole("navigation", {
      name: "Your conversations",
    });
    const waitingRow = sidebar.getByRole("link", {
      name: /Checkout latency triage/,
    });
    // An open menu hides the sidebar from the accessibility tree.
    const rowSection = () =>
      sidebarSectionOf(
        page.locator('[role="navigation"][aria-label="Your conversations"]'),
        /Checkout latency triage/,
      );
    const pill = page.getByRole("button", { name: "1 updated" });
    await expect(waitingRow).toBeVisible();
    await expect.poll(rowSection).toMatch(/^(?!.*2020$)/);

    // While the pointer is on the list, the row keeps its place, and the
    // pill offers the new order.
    await waitingRow.hover();
    setOld(true);
    await expect(pill).toBeVisible({ timeout: 15_000 });
    expect(await rowSection()).not.toMatch(/2020$/);
    await screenshot(page, "conversations-list-held", {
      lightTheme: true,
      view: "desktop",
    });

    // A row menu opens outside the list, and it still holds the order.
    await waitingRow.click({ button: "right" });
    await page.getByRole("menu").hover();
    await expect(pill).toBeVisible();
    expect(await rowSection()).not.toMatch(/2020$/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // A pill applied from the keyboard lets go of focus, so the next update
    // applies with no pointer on the list.
    await page.mouse.move(1_200, 500);
    await pill.focus();
    await page.keyboard.press("Enter");
    await expect.poll(rowSection).toMatch(/2020$/);
    setOld(false);
    await expect.poll(rowSection, { timeout: 15_000 }).toMatch(/^(?!.*2020$)/);
    await expect(pill).toHaveCount(0);

    // Hold again, then apply with a click.
    await waitingRow.hover();
    setOld(true);
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await pill.click();
    await expect.poll(rowSection).toMatch(/2020$/);
    await expect(pill).toHaveCount(0);

    // Leaving the list, pointer and focus both, applies the new order.
    setOld(false);
    await expect(pill).toBeVisible({ timeout: 15_000 });
    expect(await rowSection()).toMatch(/2020$/);
    await page.mouse.move(1_200, 500);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect.poll(rowSection).toMatch(/^(?!.*2020$)/);
    await expect(pill).toHaveCount(0);
  });

  test("holds the order for a pointer on the list edge through the first load", async ({
    page,
    dashboard,
  }) => {
    // Real versions poll interval.
    test.setTimeout(60_000);
    const setOld = await mockChangingActivity(page);
    let releaseFeed!: () => void;
    const feedGate = new Promise<void>((resolve) => (releaseFeed = resolve));
    await page.route(
      (url) => url.pathname === "/api/conversations",
      async (route) => {
        await feedGate;
        await route.fallback();
      },
    );
    await page.goto(dashboard.baseURL);
    const sidebar = page.getByRole("navigation", {
      name: "Your conversations",
    });
    // The pointer comes to rest on the list's side padding while its rows
    // load.
    await page
      .locator('[data-slot="scroll-area"]')
      .first()
      .hover({ position: { x: 4, y: 120 } });
    releaseFeed();
    await expect(
      sidebar.getByRole("link", { name: /Checkout latency triage/ }),
    ).toBeVisible();

    setOld(true);
    await expect(page.getByRole("button", { name: "1 updated" })).toBeVisible({
      timeout: 15_000,
    });
    expect(
      await sidebarSectionOf(
        page.locator('[role="navigation"][aria-label="Your conversations"]'),
        /Checkout latency triage/,
      ),
    ).not.toMatch(/2020$/);
  });

  test("holds the home list order under the pointer", async ({
    page,
    dashboard,
  }) => {
    // Real versions poll interval.
    test.setTimeout(60_000);
    const setOld = await mockChangingActivity(page);
    // A narrow window with a mouse shows the home list, not the sidebar.
    await page.setViewportSize({ width: 700, height: 900 });
    await page.goto(dashboard.baseURL);
    const card = page.getByRole("link", {
      name: "Open Checkout latency triage",
    });
    const in2020 = page
      .locator('section:has([id^="conversation-section-month-2020-"])')
      .getByRole("link", { name: "Open Checkout latency triage" });
    const pill = page.getByRole("button", { name: "1 updated" });
    await expect(card).toBeVisible();
    await expect(in2020).toHaveCount(0);

    await card.hover();
    setOld(true);
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(in2020).toHaveCount(0);
    await pill.click();
    await expect(in2020).toBeVisible();
    await expect(pill).toHaveCount(0);
  });
});
