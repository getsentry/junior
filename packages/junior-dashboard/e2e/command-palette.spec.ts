import { CONVERSATION_DETAIL_VERSION_HEADER } from "@sentry/junior/api/schema";
import type { Page } from "@playwright/test";

import { expect, test } from "./test";

const CHECKOUT_TRIAGE_ID = "slack:CQA123:1770000000.000100";
const CLOSED_ISSUE_ID = "agent-dispatch:event-1";

const question = {
  addedByConversationId: CLOSED_ISSUE_ID,
  assignedToEveryone: false,
  assignees: [
    {
      displayName: "Dashboard User",
      email: "dev@example.com",
      userId: "u-dev",
    },
  ],
  body: "The rollback is ready.",
  canAct: true,
  canTake: false,
  conversationIds: [CLOSED_ISSUE_ID],
  createdAt: "2026-08-07T08:00:00.000Z",
  id: "item-rollback",
  kind: "action" as const,
  request: {
    question: "Roll back payments-v42?",
    fields: [
      {
        id: "go",
        kind: "choice",
        label: "Rollback",
        options: [{ label: "Roll back" }, { label: "Hold" }],
      },
    ],
  },
  status: "open" as const,
  title: "Approve the payments-v42 rollback",
  updatedAt: "2026-08-07T08:30:00.000Z",
  visibility: "public" as const,
};

/**
 * Make the viewer a participant, so the Conversation has a reply box. With
 * `reviewItemId`, Junior added that Review item last.
 */
async function routeAsParticipant(
  page: Page,
  conversationId: string,
  reviewItemId?: string,
) {
  await page.route(
    `**/api/conversations/${encodeURIComponent(conversationId)}*`,
    async (route) => {
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          [CONVERSATION_DETAIL_VERSION_HEADER]: "",
        },
      });
      const detail = await response.json();
      const last = detail.events.at(-1);
      const events = reviewItemId
        ? [
            ...detail.events,
            {
              createdAt: last.createdAt,
              data: {
                calls: [
                  {
                    name: "addReviewItem",
                    output: { item: { id: reviewItemId } },
                    status: "completed",
                    toolCallId: "add-review-item",
                  },
                ],
                type: "tool_calls",
              },
              seq: last.seq + 1,
            },
          ]
        : detail.events;
      await route.fulfill({
        response,
        json: { ...detail, events, isParticipant: true },
      });
    },
  );
}

test("switches conversations from the command palette without a server search", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  // Rows must not wait on the server search.
  await page.route(/\/api\/conversations\?q=/, (route) => route.abort());
  await routeAsParticipant(page, CHECKOUT_TRIAGE_ID);
  await page.goto(dashboard.baseURL);

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  const input = palette.getByRole("combobox");
  await expect(input).toBeFocused();
  await expect(palette.getByRole("group", { name: "Recent" })).toBeVisible();

  // Scattered letters match.
  await input.fill("chk tri");
  const results = palette.getByRole("group", { name: "Conversations" });
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(
    results.getByRole("option", { name: /Checkout latency triage/ }),
  ).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");

  await expect(palette).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Checkout latency triage" }),
  ).toBeVisible();
  // The reader switched to talk there, so the reply box takes focus.
  await expect(
    page.getByRole("textbox", { name: "Continue this conversation" }),
  ).toBeFocused();

  // The open conversation is not a row, so Enter switches away from it.
  await page.getByRole("button", { name: "Go to conversation" }).click();
  await expect(input).toBeFocused();
  await expect(
    palette.getByRole("option", { name: /Checkout latency triage/ }),
  ).toHaveCount(0);
  // A typo still matches.
  await input.fill("chekcout");
  await expect(
    palette.getByRole("option", { name: /Investigate checkout latency/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
});

test("a palette switch leaves the reply box hidden while Junior waits for an answer", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await routeAsParticipant(page, CLOSED_ISSUE_ID, question.id);
  // The question loads after the reply box shows.
  let releaseQuestion = () => {};
  const questionHeld = new Promise<void>((resolve) => {
    releaseQuestion = resolve;
  });
  await page.route(`**/api/review-items/${question.id}`, async (route) => {
    await questionHeld;
    await route.fulfill({ json: question });
  });
  await page.goto(dashboard.baseURL);

  await page.keyboard.press("ControlOrMeta+k");
  const input = page
    .getByRole("dialog", { name: "Go to conversation" })
    .getByRole("combobox");
  await input.fill("closed issue");
  await input.press("Enter");
  const composer = page.getByLabel("Continue this conversation");
  await expect(composer).toBeVisible();

  // Focus would keep the reply box shown, so the reader answers the question.
  releaseQuestion();
  await expect(composer).toBeHidden();
});

test("jumps to a page from the command palette", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto(dashboard.baseURL);

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  const input = palette.getByRole("combobox");
  await expect(palette.getByRole("group", { name: "Recent" })).toBeVisible();
  // The highlighted recent conversation still matches "co" loosely, but the
  // page whose name starts with it ranks first and takes Enter.
  await input.fill("co");
  await input.press("Enter");

  await expect(page).toHaveURL(/\/code$/);
  await expect(palette).toHaveCount(0);
});
