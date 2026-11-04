import type { Page } from "@playwright/test";

/** Switch the transcript view from the conversation `⋯` menu. */
export async function chooseTranscriptView(
  page: Page,
  view: "Conversation" | "Event log",
) {
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await page
    .getByRole("button", {
      name: view === "Event log" ? "Open event log" : "Back to conversation",
      exact: true,
    })
    .click();
}
