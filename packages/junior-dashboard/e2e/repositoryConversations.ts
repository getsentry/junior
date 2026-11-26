import type { Page } from "@playwright/test";
import { mockFeedPage } from "./mock-reports";

/**
 * List two Conversations in each repository Conversations feed: "Pinned
 * conversation", which the viewer pinned, and "Unpinned conversation".
 */
export async function pinFirstRepositoryConversation(page: Page) {
  await page.route(
    /\/api\/conversations\?.*codeRepositoryId=/,
    async (route) => {
      const feed = await mockFeedPage(route);
      const first = feed.conversations[0]!;
      return route.fulfill({
        json: {
          ...feed,
          conversations: [
            {
              ...first,
              displayTitle: "Pinned conversation",
              pinnedAt: "2026-08-07T10:00:00.000Z",
            },
            {
              ...first,
              conversationId: `${first.conversationId}-unpinned`,
              displayTitle: "Unpinned conversation",
              pinnedAt: null,
            },
          ],
        },
      });
    },
  );
}

/** Open the Conversations tab of the getsentry/junior repository. */
export async function openRepositoryConversations(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/code?scope=all`);
  await page
    .getByRole("link", { name: "getsentry/junior", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Repository navigation" })
    .getByRole("link", { name: "Conversations" })
    .click();
  return page.getByRole("region", { name: "Conversations", exact: true });
}
