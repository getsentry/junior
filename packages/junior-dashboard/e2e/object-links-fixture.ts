/** The mock release Conversation and its object links, for link specs. */
import type { Page } from "@playwright/test";
import { expect } from "./test";

// The mock release Conversation saves Annotations for these pull requests,
// and its last reply links to them.
export const CONVERSATION_ID = "slack:CQA456:1770021600.000600";

export const DOC_URL =
  "https://docs.google.com/document/d/1MockReleaseChecklist_0123456789/edit";

// The mock viewer is not a participant of the release Conversation. Make
// them one, so the cards can attach.
export async function viewAsParticipant(
  page: Page,
  extraAnnotations: unknown[] = [],
): Promise<void> {
  await page.route(
    (url) =>
      url.pathname ===
      `/api/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
    async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      await route.fulfill({
        json: {
          ...detail,
          // Linked work lists the newest Annotation first.
          annotations: [...extraAnnotations, ...(detail.annotations ?? [])],
          isParticipant: true,
        },
        response,
      });
    },
  );
}

// Resolved links render again when their cards arrive, which drops an
// earlier hover. Wait for all of them before a hover.
export async function waitForResolvedLinks(page: Page): Promise<void> {
  for (const name of [
    /Release 4\.2 checklist/,
    /Release 4\.2 go\/no-go/,
    /Release 4\.2 metrics\.pdf/,
    /Release 4\.2 assets/,
    /#proj-release/,
    /Checkout 4\.2 launch demo/,
  ]) {
    await expect(page.getByRole("link", { name }).first()).toBeVisible();
  }
}
