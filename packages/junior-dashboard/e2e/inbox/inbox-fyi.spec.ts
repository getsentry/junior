import {
  mockReviewItems,
  pinChecks,
  pinReview,
  releaseNotes,
  rowHead,
} from "./inbox-fixture";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  // A pull request card, and the notices that are FYI.

  const card = "Pull request: Pin the release train to payments 4.2";

  test("a pull request ask shows one card, and a notice about it folds in", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockReviewItems(page, {
      open: [pinReview, pinChecks],
    });
    await page.goto(`${dashboard.baseURL}/?item=${pinReview.id}`);
    const asks = page.getByRole("region", { name: /: asks$/ });
    // The URL alone in the ask's text shows no card of its own: the one
    // card names the change, its state and branch, and its description.
    const pull = asks.getByRole("region", { name: card });
    await expect(pull).toHaveCount(1);
    await expect(pull).toHaveAttribute("data-subject-card", "");
    await expect(pull).toContainText("getsentry/payments#91");
    await expect(pull.getByText("open", { exact: true })).toBeVisible();
    await expect(pull).toContainText("release/pin-payments-4.2");
    await expect(
      asks.getByText("GitHub asks you to review #91."),
    ).toBeVisible();
    // The description shows its first lines, and opens in full.
    const more = pull.getByRole("button", {
      name: "Expand description of Pin the release train to payments 4.2",
    });
    const description = page.locator(
      `[id="${await more.getAttribute("aria-controls")}"]`,
    );
    await expect(description).toContainText("The release train read");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.click();
    await expect(
      pull.getByRole("button", {
        name: "Collapse description of Pin the release train to payments 4.2",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(description).toContainText("Merge after the 4.2 deploy");

    // The notice is a quiet line on the review, not a row or a card.
    await expect(rowHead(page, pinChecks.title)).toHaveCount(0);
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
    await rowHead(fyi, pinChecks.title).click();
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
    const actions = await mockReviewItems(page, {
      open: [pinReview, pinChecks],
    });
    // A link to the notice opens the review's row, which holds it.
    await page.goto(`${dashboard.baseURL}/?item=${pinChecks.id}`);
    const asks = page.getByRole("region", { name: /: asks$/ });
    const checks = asks.getByRole("region", { name: pinChecks.title });
    await checks.getByRole("button", { name: "Checks failed" }).click();
    await expect(checks).toContainText("The required checks failed");
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
    await mockReviewItems(page, { open: [pinReview, pinChecks] });
    await page.goto(`${dashboard.baseURL}/?item=${pinReview.id}`);
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
    await mockReviewItems(page, { open: [pinReview, releaseNotes] });
    await page.goto(`${dashboard.baseURL}/?item=${pinReview.id}`);
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
    await page.goto(`${dashboard.baseURL}/?item=${releaseNotes.id}`);
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
});
