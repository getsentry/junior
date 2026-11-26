import type { Page } from "@playwright/test";
import { findMockConversationDetail, mockFeedPage } from "./mock-reports";

/**
 * Find a row of the open conversation `⋯` menu: a menu item, or a button of
 * the bottom sheet that the new UI shows on a phone.
 */
export function conversationMenuRow(page: Page, name: string | RegExp) {
  return page
    .getByRole("menuitem", { name, exact: true })
    .or(page.getByRole("dialog").getByRole("button", { name, exact: true }));
}

/** Switch the transcript view from the conversation `⋯` menu. */
export async function chooseTranscriptView(
  page: Page,
  view: "Conversation" | "Event log",
) {
  await page.getByRole("button", { name: "Conversation menu" }).click();
  const name = view === "Event log" ? "Open event log" : "Back to conversation";
  await conversationMenuRow(page, name).click();
}

/**
 * Make the viewer a participant of every conversation that the feed or a
 * detail read returns. Most mock conversations have other participants, and
 * only a participant can pin, archive, rename, or mark one.
 */
export async function viewAsParticipant(page: Page) {
  await page.route(
    (url) => /^\/api\/conversations(?:\/[^/]+)?$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const url = new URL(route.request().url());
      if (url.pathname === "/api/conversations") {
        const feed = await mockFeedPage(route);
        return route.fulfill({
          json: {
            ...feed,
            conversations: feed.conversations.map((conversation) => ({
              ...conversation,
              isParticipant: true,
            })),
          },
        });
      }
      const detail = await findMockConversationDetail(route);
      // Not a Conversation, such as `/api/conversations/stats`.
      if (!detail) return route.fallback();
      await route.fulfill({ json: { ...detail, isParticipant: true } });
    },
  );
}
