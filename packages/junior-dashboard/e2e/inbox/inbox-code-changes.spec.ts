import type { Page } from "@playwright/test";

import { mockReviewItems, prMerge, prReview } from "./inbox-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";

// A review ask whose pull request title follows Conventional Commits, as the
// GitHub plugin parses it.
const breakingReview = {
  ...prReview,
  subject: {
    ...prReview.subject,
    title: "feat(release)!: Pin the release train (#91)",
    titleParts: {
      breaking: true,
      scope: "release",
      text: "Pin the release train",
      type: "Feature",
    },
  },
};

// A merge conflict ask has Resume choices, so its kind is a Question. Its
// state pill still names the conflict.
const conflict = {
  ...prMerge,
  id: "item-pr-conflict",
  request: {
    question: "Resolve the conflict in #57?",
    fields: [
      {
        id: "resume",
        kind: "choice" as const,
        label: "Resume",
        options: [{ label: "Resolve it" }, { label: "Leave it" }],
      },
    ],
  },
  subject: {
    ...prMerge.subject,
    id: "https://github.com/getsentry/payments/pull/57",
    title: "fix(slack): Keep thread replies in order",
    titleParts: {
      scope: "slack",
      text: "Keep thread replies in order",
      type: "Fix",
    },
    url: "https://github.com/getsentry/payments/pull/57",
  },
  title: "Merge conflict · #57",
};

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const row = (page: Page, text: string) =>
    page.locator("li[data-inbox-row]").filter({ hasText: text });

  test("a code change row leads with its title, then its type", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [breakingReview, prMerge, conflict] });
    await page.goto(`${dashboard.baseURL}/`);
    const review = row(page, "Pin the release train");
    const head = review.locator("[data-inbox-head]");
    // The state is one word before the title. The title has no type prefix,
    // and the breaking mark, the type, and the scope come after it.
    await expect(head.locator("[data-code-change-title]")).toHaveText(
      "ReviewPin the release train!Breaking changeFeaturerelease",
    );
    await expect(review.getByTitle("Review requested")).toHaveText("Review");
    await expect(review.getByTitle("Breaking change")).toBeVisible();
    // The number moves to the second line.
    await expect(head).toContainText("#91");
    await expect(head).not.toContainText("Review requested");
    await expect(head).not.toContainText("feat(release)");

    // A title with no type prefix shows as it is, with no type pill.
    const merge = row(page, "Retry checkout writes after lock timeouts");
    await expect(merge.locator("[data-code-change-title]")).toHaveText(
      "MergeRetry checkout writes after lock timeouts",
    );
    await expect(merge.locator("[data-code-change-type]")).toHaveCount(0);

    // A conflict row's state pill names the conflict, not the ask's kind.
    const conflictRow = row(page, "Keep thread replies in order");
    await expect(conflictRow.getByTitle("Merge conflict")).toHaveText(
      "Conflict",
    );
    await expect(conflictRow.getByTitle("Question")).toHaveCount(0);
    await screenshot(page, "inbox-code-change-rows", { lightTheme: true });
  });

  test("a code change row opens its pull request first", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [breakingReview] });
    await page.goto(`${dashboard.baseURL}/`);
    const review = row(page, "Pin the release train");
    // Closed, the row's hover actions open the pull request before the
    // Conversation.
    await review.locator("[data-inbox-head]").hover();
    const hoverLinks = review.locator('[data-inbox-slot="meta"] a');
    await expect(hoverLinks.first()).toHaveAccessibleName("Review on GitHub");
    await expect(hoverLinks.first()).toHaveAttribute(
      "href",
      breakingReview.subject.url,
    );
    // A click still expands the row. Its first action opens the pull
    // request in a new tab.
    await review.locator("[data-inbox-head]").click();
    await expect(review).toHaveAttribute("data-expanded", "true");
    const open = review.getByRole("link", { name: "Review on GitHub" });
    await expect(open).toHaveAttribute("href", breakingReview.subject.url);
    await expect(open).toHaveAttribute("target", "_blank");
    const actions = await review
      .locator("[data-inbox-card] :is(a, button)")
      .allInnerTexts();
    expect(actions.indexOf("Review on GitHub")).toBeLessThan(
      actions.indexOf("Open conversation"),
    );
    await screenshot(page, "inbox-code-change-open", { lightTheme: true });
  });
});
