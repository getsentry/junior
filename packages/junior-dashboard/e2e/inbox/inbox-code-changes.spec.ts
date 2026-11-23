import type { Locator, Page } from "@playwright/test";

import {
  mockInboxItems,
  prMerge,
  prReview,
  pullRequestSubject,
} from "./inbox-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";

// A review ask whose pull request title follows Conventional Commits, as the
// GitHub plugin parses it.
const breakingReview = {
  ...prReview,
  subject: pullRequestSubject({
    kind: prReview.subject.kind,
    label: prReview.subject.label,
    resource: prReview.subject.resource,
    title: "feat(release)!: Pin the release train (#91)",
    titleParts: {
      breaking: true,
      scope: "release",
      text: "Pin the release train",
      type: "Feature",
    },
    url: prReview.subject.url,
  }),
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
  subject: pullRequestSubject({
    kind: "github:merge_conflict",
    label: "Merge conflict",
    resource: prMerge.subject.resource,
    title: "fix(slack): Keep thread replies in order",
    titleParts: {
      scope: "slack",
      text: "Keep thread replies in order",
      type: "Fix",
    },
    url: "https://github.com/getsentry/payments/pull/57",
  }),
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
    await mockInboxItems(page, { open: [breakingReview, prMerge, conflict] });
    await page.goto(`${dashboard.baseURL}/`);
    const review = row(page, "Pin the release train");
    const head = review.locator("[data-inbox-head]");
    // The state is one word before the title. The title has no type prefix,
    // One muted "type/scope" tag comes after it, with the breaking mark.
    await expect(head.locator("[data-code-change-title]")).toHaveText(
      "ReviewPin the release trainfeature/release breaking",
    );
    await expect(head.locator("[data-code-change-type]")).toHaveText(
      "feature/release breaking",
    );
    await expect(review.getByTitle("Review requested")).toHaveText("Review");
    await expect(review.getByTitle("Breaking change")).toBeVisible();
    // The number moves to the second line.
    await expect(head).toContainText("#91");
    await expect(head).not.toContainText("Review requested");
    await expect(head).not.toContainText("feat(release)");

    // A title with no type prefix shows as it is, with no type tag.
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
    await mockInboxItems(page, { open: [breakingReview] });
    await page.goto(`${dashboard.baseURL}/`);
    const review = row(page, "Pin the release train");
    // Closed, the row's hover actions end with the pull request, after
    // Dismiss and Snooze.
    await review.locator("[data-inbox-head]").hover();
    const hover = await actionNames(
      review.locator('[data-inbox-slot="meta"] :is(a, button)'),
    );
    expect(hover[0]).toBe("Dismiss");
    expect(hover.at(-1)).toBe("Review on GitHub");
    expect(hover).not.toContain("Open conversation");
    await expect(
      review.locator('[data-inbox-slot="meta"] a').last(),
    ).toHaveAttribute("href", breakingReview.subject.url);
    // A click still expands the row. Its main action opens the pull
    // request in a new tab, at the end of the line: Dismiss, Snooze, the
    // Conversation, then Review.
    await review.locator("[data-inbox-head]").click();
    await expect(review).toHaveAttribute("data-expanded", "true");
    const open = review.getByRole("link", { name: "Review on GitHub" });
    await expect(open).toHaveAttribute("href", breakingReview.subject.url);
    await expect(open).toHaveAttribute("target", "_blank");
    const conversation = review.getByRole("link", {
      name: "Open conversation",
    });
    await expect(conversation).toHaveText("Conversation");
    const actions = await actionNames(
      review.locator("[data-inbox-card] :is(a, button)"),
    );
    const order = ["Dismiss", "Open conversation", "Review on GitHub"].map(
      (name) => actions.indexOf(name),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(actions.at(-1)).toBe("Review on GitHub");
    await screenshot(page, "inbox-code-change-open", { lightTheme: true });
  });
});

/** The accessible names of `actions`, in page order. */
async function actionNames(actions: Locator): Promise<string[]> {
  return actions.evaluateAll((nodes) =>
    nodes.map(
      (node) =>
        node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "",
    ),
  );
}
