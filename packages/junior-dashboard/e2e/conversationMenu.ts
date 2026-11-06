import type { Page } from "@playwright/test";

/** Switch the transcript view from the conversation `⋯` menu. */
export async function chooseTranscriptView(
  page: Page,
  view: "Conversation" | "Event log",
) {
  await page.getByRole("button", { name: "Conversation menu" }).click();
  const name = view === "Event log" ? "Open event log" : "Back to conversation";
  // The mobile header back button shares the label. Menu rows show it.
  await page
    .getByRole("button", { name, exact: true })
    .filter({ hasText: name })
    .click();
}
