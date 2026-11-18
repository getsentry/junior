import type { Page } from "@playwright/test";

/** Switch the transcript view from the conversation `⋯` menu. */
export async function chooseTranscriptView(
  page: Page,
  view: "Conversation" | "Event log",
) {
  await page.getByRole("button", { name: "Conversation menu" }).click();
  const name = view === "Event log" ? "Open event log" : "Back to conversation";
  await page.getByRole("menuitem", { name, exact: true }).click();
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
      const response = await route.fetch();
      if (response.status() !== 200) return route.fulfill({ response });
      const body = await response.json();
      const json = Array.isArray(body.conversations)
        ? {
            ...body,
            conversations: body.conversations.map(
              (conversation: Record<string, unknown>) => ({
                ...conversation,
                isParticipant: true,
              }),
            ),
          }
        : "isParticipant" in body
          ? { ...body, isParticipant: true }
          : body;
      await route.fulfill({ json, response });
    },
  );
}
