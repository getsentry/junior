import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { screenshot } from "./screenshot";

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const WAITING_CONVERSATION_ID = "slack:CQA123:1770000000.000100";

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

/** Make one conversation wait on the viewer with two open Review items. */
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
              count: 2,
              title: reviewItem.title,
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

test.describe("conversation sections", () => {
  test("puts waiting conversations in Needs attention first", async ({
    page,
    dashboard,
  }) => {
    await mockWaitingConversation(page);
    await page.goto(dashboard.baseURL);

    const sidebar = page.getByRole("navigation", {
      name: "Your conversations",
    });
    const attention = sidebar.getByRole("button", { name: "Needs attention" });
    const waitingRow = sidebar.getByRole("link", {
      name: /Checkout latency triage/,
    });
    await expect(sidebar.getByRole("button").first()).toHaveText(
      /^Needs attention/,
    );
    await expect(sidebar.getByRole("link").first()).toHaveAccessibleName(
      /Checkout latency triage/,
    );
    await expect(
      waitingRow.getByRole("img", { name: "Waiting on you" }),
    ).toBeVisible();
    await screenshot(page, "conversations-needs-attention");

    await attention.click();
    await expect(attention).toHaveAttribute("aria-expanded", "false");
    await expect(waitingRow).toHaveCount(0);
    await screenshot(page, "conversations-sections-collapsed");

    await page.reload();
    await expect(attention).toHaveAttribute("aria-expanded", "false");
    await expect(waitingRow).toHaveCount(0);

    await attention.click();
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
    const sectionButtons = sidebar.getByRole("button", {
      name: /^(Pinned|Needs attention)/,
    });
    const activeRows = sidebar.getByRole("link", {
      name: /Investigate checkout latency/,
    });
    await expect(sidebar.getByRole("button").first()).toHaveText(
      /^Needs attention/,
    );

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
    // Pinned wins over Needs attention, so the section is gone.
    await expect(sectionButtons).toHaveCount(1);
    await expect(activeRows).toHaveCount(1);
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
    await expect(sidebar.getByRole("button").first()).toHaveText(
      /^Needs attention/,
    );
  });

  test("keeps an unread conversation in Needs attention until marked read", async ({
    page,
    dashboard,
  }) => {
    await page.goto(dashboard.baseURL);

    const sidebar = page.getByRole("navigation", {
      name: "Your conversations",
    });
    const finishedRow = sidebar.getByRole("link", {
      name: /Closed issue summary/,
    });
    const unreadDot = finishedRow.getByRole("img", { name: "Unread" });
    await expect(finishedRow).toBeVisible();
    await expect(unreadDot).toHaveCount(0);

    const unreadRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" && request.url().endsWith("/unread"),
    );
    await finishedRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mark as unread" }).click();
    expect((await unreadRequest).postDataJSON()).toEqual({ unread: true });
    await expect(unreadDot).toBeVisible();
    await expect(sidebar.getByRole("button").first()).toHaveText(
      /^Needs attention/,
    );
    await expect(sidebar.getByRole("link").first()).toHaveAccessibleName(
      /Closed issue summary/,
    );

    // The server keeps it, so a reload or another device sees it too.
    await page.reload();
    await expect(unreadDot).toBeVisible();

    // Opening it is not an act on it, so it stays unread and in place.
    await finishedRow.click();
    await expect(finishedRow).toHaveAttribute("aria-current", "page");
    await expect(unreadDot).toBeVisible();
    await expect(sidebar.getByRole("link").first()).toHaveAccessibleName(
      /Closed issue summary/,
    );
    await screenshot(page, "conversation-open-unread", { view: "desktop" });
    await sidebar
      .getByRole("link", { name: /Checkout latency triage/ })
      .click();
    await expect(finishedRow).not.toHaveAttribute("aria-current", "page");
    await expect(unreadDot).toBeVisible();

    await finishedRow.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText([
      "Mark as read",
      "Pin",
      "Archive",
    ]);
    await screenshot(page, "conversation-sidebar-context-menu", {
      lightTheme: true,
      view: "desktop",
    });
    await page.getByRole("menuitem", { name: "Mark as read" }).click();
    await expect(unreadDot).toHaveCount(0);
    await expect(sidebar.getByRole("button").first()).not.toHaveText(
      /^Needs attention/,
    );

    await page.reload();
    await expect(finishedRow).toBeVisible();
    await expect(unreadDot).toHaveCount(0);
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
    await page.getByRole("button", { name: "Mark as unread" }).click();
    await page.getByRole("button", { name: "Mark as read" }).click();
    await expect(
      page.getByRole("button", { name: "Mark as unread" }),
    ).toBeVisible();
    expect(requests).toEqual([{ unread: true }, { unread: false }]);
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
    const chip = sidebar.getByRole("link", {
      name: /Approve the checkout fix/,
    });
    await expect(sidebar.getByRole("button").first()).toHaveText(
      /^Needs attention/,
    );
    await expect(
      waitingRow.getByRole("img", { name: "Waiting on you" }),
    ).toBeVisible();
    await expect(chip).toContainText("+1 more");
    await screenshot(page, "conversation-sidebar-review-chip", {
      lightTheme: true,
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

    const attention = sidebar.getByRole("button", { name: "Needs attention" });
    await attention.click();
    await expect(attention).toHaveAttribute("aria-expanded", "false");
    await expect(waitingRow).toHaveCount(0);
  });
});
