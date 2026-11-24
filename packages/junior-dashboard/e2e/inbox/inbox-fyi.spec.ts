import type { Page } from "@playwright/test";
import { NOW_MS } from "../../src/mock-reporting/fixtures";
import {
  mockInboxItems,
  pinChecks,
  pinReview,
  releaseNotes,
  rowHead,
  viewer,
} from "./inbox-fixture";
import { desktop, mobile, screenshot } from "../screenshot";
import { expect, test } from "../test";

// A dashboard Conversation's reply notice. It stores a short preview; its
// Turn's message holds the reply in full.
const replyConversationId = "local:web:reply-notice-qa";
const replyTurnId = "turn-reply-notice";
const replyNotice = {
  addedByTurnId: replyTurnId,
  assignedToEveryone: false,
  assignees: [viewer],
  body: "The deploy finished. Checkout p95 is back to 210 ms, and the…",
  canAct: true,
  canTake: false,
  conversationIds: [replyConversationId],
  createdAt: "2026-08-07T09:40:00.000Z",
  id: "item-reply-notice",
  kind: "notice" as const,
  owner: { id: replyConversationId, kind: "conversation" },
  replyNotice: true as const,
  rootConversationId: replyConversationId,
  status: "open" as const,
  title: "Roll back payments-v42",
  updatedAt: "2026-08-07T09:40:00.000Z",
  visibility: "private" as const,
};
const replyText = [
  "The deploy finished. Checkout p95 is back to 210 ms, and the error rate is flat.",
  ...Array.from(
    { length: 12 },
    (_, index) => `Region ${index + 1} is on payments-v41 and healthy.`,
  ),
  "I left the payments-v42 tag in place, so a fix can ship on top of it.",
].join("\n\n");

/** Serve the reply notice's Turn, or fail its read. */
async function mockReplyTurn(page: Page, options: { fail?: boolean } = {}) {
  const event = (seq: number, data: Record<string, unknown>) => ({
    createdAt: new Date(NOW_MS - (60 - seq) * 1000).toISOString(),
    data,
    seq,
  });
  await page.route(
    `**/api/conversations/${encodeURIComponent(replyConversationId)}/events?*`,
    (route) => {
      if (options.fail) return route.fulfill({ status: 500 });
      return route.fulfill({
        json: {
          eventHistory: { status: "available" },
          events: [
            event(1, {
              state: "started",
              turnId: replyTurnId,
              type: "turn_lifecycle",
            }),
            event(2, {
              messageId: "m-reply",
              role: "assistant",
              text: replyText,
              type: "message",
            }),
            event(3, {
              state: "succeeded",
              turnId: replyTurnId,
              type: "turn_lifecycle",
            }),
          ],
          generatedAt: new Date(NOW_MS).toISOString(),
        },
      });
    },
  );
}

test.describe("new UI", () => {
  // A pull request card, and the notices that are FYI.

  const card = "Pull request: Pin the release train to payments 4.2";

  test("a pull request ask keeps text that says more than its head", async ({
    dashboard,
    page,
  }) => {
    const rereview = {
      ...pinReview,
      body: "#91 has new commits since you requested changes.\n\nhttps://github.com/getsentry/payments/pull/91",
    };
    await mockInboxItems(page, { open: [rereview] });
    await page.goto(`${dashboard.baseURL}/inbox?item=${rereview.id}`);
    const asks = page.getByRole("region", { name: /: asks$/ });
    await expect(asks.getByRole("region", { name: card })).toHaveCount(1);
    await expect(
      asks.getByText("#91 has new commits since you requested changes."),
    ).toBeVisible();
  });

  test("a pull request row and its card show the change as GitHub has it now", async ({
    dashboard,
    page,
  }) => {
    // The release Conversation saved this change at 48 lines. Someone else
    // pushed since, so GitHub has a bigger change that conflicts.
    await mockInboxItems(page, { open: [pinReview] });
    await page.route("**/api/objects?**", (route) =>
      route.fulfill({
        json: {
          objects: [
            {
              object: {
                displayType: "Pull request",
                facts: {
                  type: "code_change",
                  additions: 1204,
                  changedFiles: 12,
                  deletions: 340,
                  mergeable: false,
                  sourceBranch: "release/pin-payments-4.2",
                },
                key: "getsentry/payments#91",
                kind: "object",
                label: "getsentry/payments#91",
                objectType: "code_change",
                plugin: "github",
                status: "open",
                title: "Pin the release train to payments 4.2",
                url: pinReview.subject.url,
              },
              url: pinReview.subject.url,
            },
          ],
        },
      }),
    );
    await page.goto(`${dashboard.baseURL}/inbox?item=${pinReview.id}`);
    await expect(rowHead(page, "Pin the release train")).toHaveAccessibleName(
      /1,204 lines added, 340 removed, 12 files changed/,
    );
    await expect(
      rowHead(page, "Pin the release train"),
    ).not.toHaveAccessibleName(/48 lines added/);
    const asks = page.getByRole("region", { name: /: asks$/ });
    await expect(asks.getByText("Merge conflict")).toBeVisible();
    // The head gives the size, so the card does not say it again.
    await expect(
      asks.getByRole("region", { name: card }).getByText(/lines added/),
    ).toHaveCount(0);
  });

  test("a pull request ask shows one card, and a notice about it folds in", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockInboxItems(page, {
      open: [pinReview, pinChecks],
    });
    await page.goto(`${dashboard.baseURL}/inbox?item=${pinReview.id}`);
    const asks = page.getByRole("region", { name: /: asks$/ });
    // The URL alone in the ask's text shows no card of its own: the one
    // card names the change, its state and branch, and its description.
    const pull = asks.getByRole("region", { name: card });
    await expect(pull).toHaveCount(1);
    await expect(pull).toHaveAttribute("data-subject-card", "");
    await expect(pull).toContainText("getsentry/payments#91");
    // The row's head names the change, so the card links by its reference
    // and does not say its title again.
    await expect(
      pull.getByRole("link", { name: /getsentry\/payments#91/ }),
    ).toBeVisible();
    await expect(
      pull.getByRole("link", { name: /Pin the release train/ }),
    ).toHaveCount(0);
    await expect(pull.getByText("open", { exact: true })).toBeVisible();
    await expect(pull).toContainText("release/pin-payments-4.2");
    // The head gives the change's size, so the card does not say it again.
    await expect(rowHead(page, "Pin the release train")).toHaveAccessibleName(
      /48 lines added, 9 removed, 3 files changed/,
    );
    await expect(pull.getByText(/lines added/)).toHaveCount(0);
    // The head says the state and #91, so the plugin's text that
    // says the same shows in Slack only.
    await expect(asks.getByText("GitHub asks you to review #91.")).toHaveCount(
      0,
    );
    // The description shows its first lines, and opens in full.
    const more = pull.getByRole("button", {
      name: "Show more of the description of Pin the release train to payments 4.2",
    });
    const description = page.locator(
      `[id="${await more.getAttribute("aria-controls")}"]`,
    );
    await expect(description).toContainText("The release train read");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.click();
    await expect(
      pull.getByRole("button", {
        name: "Show less of the description of Pin the release train to payments 4.2",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(description).toContainText("Merge after the 4.2 deploy");

    // The pull request's live card says that it conflicts: a quiet line on
    // the review, not an item.
    await expect(asks.getByText("Merge conflict")).toBeVisible();
    // The notice is a quiet line on the review, not a row or a card.
    await expect(
      page.locator("[data-code-change-state]", { hasText: "Checks failed" }),
    ).toHaveCount(0);
    await expect(page.getByRole("region", { name: "FYI" })).toHaveCount(0);
    const checks = asks.locator("[data-folded-notice]");
    await expect(checks).toHaveText("Checks failed");
    await expect(page.getByRole("region", { name: card })).toHaveCount(1);
    // The row's Dismiss closes the review only.
    await asks.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect
      .poll(() => actions.map((action) => action.id))
      .toEqual([pinReview.id]);
    // The notice stays open, alone in the FYI list, with the same card.
    const fyi = page.getByRole("region", { name: "FYI" });
    await rowHead(fyi, "Pin the release train").click();
    const notice = fyi.getByRole("region", { name: /: asks$/ });
    await expect(notice.getByRole("region", { name: card })).toHaveAttribute(
      "data-subject-card",
      "",
    );
    await expect(notice.getByRole("region", { name: card })).toContainText(
      "release/pin-payments-4.2",
    );
  });

  test("a folded notice opens to its text and its own Dismiss", async ({
    dashboard,
    page,
  }) => {
    const notice = {
      ...pinChecks,
      body: `${pinChecks.body}\n\n<@U0MOCKADA> owns the flaky suite.`,
      mentions: [{ fullName: "Ada Lovelace", slackUserId: "U0MOCKADA" }],
    };
    const actions = await mockInboxItems(page, {
      open: [pinReview, notice],
    });
    // A link to the notice opens the review's row, which holds it.
    await page.goto(`${dashboard.baseURL}/inbox?item=${pinChecks.id}`);
    const asks = page.getByRole("region", { name: /: asks$/ });
    const checks = asks.getByRole("region", { name: pinChecks.title });
    await checks.getByRole("button", { name: "Checks failed" }).click();
    await expect(checks).toContainText("The required checks failed");
    await expect(checks).toContainText("Ada Lovelace owns the flaky suite.");
    await expect(checks).not.toContainText("U0MOCKADA");
    await checks.getByRole("button", { name: "Dismiss" }).click();
    await expect
      .poll(() => actions.map((action) => action.id))
      .toEqual([pinChecks.id]);
    await expect(asks.getByRole("region", { name: card })).toBeVisible();
  });

  test("a snoozed ask sleeps with the newer notice folded into it", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [pinReview, pinChecks] });
    await page.goto(`${dashboard.baseURL}/inbox?item=${pinReview.id}`);
    const todo = page.getByRole("region", { name: "To do" });
    const asks = todo.getByRole("region", { name: /: asks$/ });
    await asks.getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "3 hours" }).click();
    // The row leaves To do, and its notice does not move to FYI.
    await expect(rowHead(todo, "Package release and self-update")).toHaveCount(
      0,
    );
    await expect(page.getByRole("region", { name: "FYI" })).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Snoozed/ })
      .click();
    await expect(
      rowHead(page, "Package release and self-update"),
    ).toBeVisible();
  });

  test("a lone notice is FYI: out of To do and its count, and it snoozes", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [pinReview, releaseNotes] });
    await page.goto(`${dashboard.baseURL}/inbox?item=${pinReview.id}`);
    // Its Conversation's row in To do holds the ask only.
    const todo = page.getByRole("region", { name: "To do" });
    await expect(todo.getByRole("region", { name: /: asks$/ })).toBeVisible();
    await expect(todo.getByText(releaseNotes.title)).toHaveCount(0);
    await expect(todo.getByText("1", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { name: "Inbox, 1 waiting" }),
    ).toBeVisible();
    // The FYI list has it, and the Inbox stream does not repeat it.
    const fyi = page.getByRole("region", { name: "FYI" });
    await expect(rowHead(fyi, releaseNotes.title)).toBeVisible();
    await expect(page.getByText(releaseNotes.title)).toHaveCount(1);

    // A link to it opens its FYI row, which has Dismiss and Snooze.
    await page.goto(`${dashboard.baseURL}/inbox?item=${releaseNotes.id}`);
    const row = fyi.locator('[data-inbox-row^="fyi:"]');
    await expect(row).toHaveAttribute("data-expanded", "true");
    await expect(
      row.getByRole("button", { name: "Dismiss", exact: true }),
    ).toBeVisible();
    await row.getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "3 hours" }).click();
    // Only the notice sleeps, not the ask in its Conversation.
    await expect(fyi).toHaveCount(0);
    await expect(
      rowHead(todo, "Package release and self-update"),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Snoozed/ })
      .click();
    await expect(
      rowHead(page, "Package release and self-update"),
    ).toBeVisible();
  });

  for (const view of [desktop, mobile]) {
    test(`a reply notice shows the reply in full and opens it in its Conversation (${view.name})`, async ({
      dashboard,
      page,
    }) => {
      await page.setViewportSize(view);
      const actions = await mockInboxItems(page, { open: [replyNotice] });
      await mockReplyTurn(page);
      await page.goto(`${dashboard.baseURL}/inbox?item=${replyNotice.id}`);
      const card = page
        .getByRole("region", { name: "FYI" })
        .getByRole("region", { name: replyNotice.title, exact: true });
      // The reply from its Turn takes the place of the stored preview.
      await expect(card).toContainText("the error rate is flat.");
      await expect(card).not.toContainText(replyNotice.body);
      await expect(
        card.getByRole("region", { name: "Junior's message" }),
      ).toHaveCount(0);
      const more = card.getByRole("button", {
        name: `Expand ${replyNotice.title}`,
      });
      await expect(more).toHaveAttribute("aria-expanded", "false");
      // The one Conversation link is the card's main action. It opens the
      // reply.
      const open = card.getByRole("link", { name: "Open conversation" });
      await expect(open).toHaveCount(1);
      await expect(open).toHaveText("Conversation");
      await expect(open).toHaveAttribute(
        "href",
        `/conversations/${encodeURIComponent(replyConversationId)}?message=m-reply`,
      );
      await expect(card.getByRole("button", { name: "Snooze" })).toBeVisible();
      await screenshot(page, "inbox-reply-notice", {
        lightTheme: true,
        view: view.name,
      });
      await more.click();
      await expect(card).toContainText("ship on top of it.");
      // Dismiss is for a reply that the card said enough of.
      await card.getByRole("button", { name: "Dismiss", exact: true }).click();
      await expect
        .poll(() => actions.map((action) => action.id))
        .toEqual([replyNotice.id]);
    });
  }

  test("a reply notice whose Turn read fails shows its preview and opens its Conversation", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [replyNotice] });
    await mockReplyTurn(page, { fail: true });
    await page.goto(`${dashboard.baseURL}/inbox?item=${replyNotice.id}`);
    const card = page
      .getByRole("region", { name: "FYI" })
      .getByRole("region", { name: replyNotice.title, exact: true });
    await expect(card).toContainText(replyNotice.body);
    await expect(
      card.getByRole("link", { name: "Open conversation" }),
    ).toHaveAttribute(
      "href",
      `/conversations/${encodeURIComponent(replyConversationId)}?ask=${replyNotice.id}`,
    );
  });
});
