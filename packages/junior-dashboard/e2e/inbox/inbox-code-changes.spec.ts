import type { Locator, Page } from "@playwright/test";

import {
  expandRow,
  mockInboxItems,
  prMerge,
  prReview,
  pullRequestSubject,
  rowHead,
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

// A merge conflict ask has its kind's Resume action. Its state pill names
// the conflict.
const conflict = {
  ...prMerge,
  id: "item-pr-conflict",
  subject: {
    ...pullRequestSubject({
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
    actions: [{ id: "resume", label: "Keep fixing" }],
  },
  title: "Merge conflict · #57",
};

test.describe("new UI", () => {
  const row = (page: Page, text: string) =>
    page.locator("li[data-inbox-row]").filter({ hasText: text });

  test("a code change row leads with its title, then its type", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [breakingReview, prMerge, conflict] });
    await page.goto(`${dashboard.baseURL}/inbox`);
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

  test("a merge conflict card runs its kind's Keep fixing", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockInboxItems(page, { open: [conflict] });
    await page.goto(`${dashboard.baseURL}/inbox`);
    const conflictRow = row(page, "Keep thread replies in order");
    await expandRow(rowHead(page, "Keep thread replies in order"));
    await conflictRow
      .getByRole("button", { exact: true, name: "Keep fixing" })
      .click();
    await expect(conflictRow).toHaveCount(0);
    expect(actions).toEqual([
      { body: { action: "done", id: "resume" }, id: conflict.id },
    ]);
  });

  test("a merge conflict card from before kind actions shows one Resume", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, {
      open: [
        {
          ...conflict,
          request: {
            question: conflict.body,
            fields: [
              {
                id: "choice",
                kind: "choice",
                label: conflict.title,
                options: [{ label: "Resume" }],
              },
            ],
          },
        },
      ],
    });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expandRow(rowHead(page, "Keep thread replies in order"));
    await expect(
      row(page, "Keep thread replies in order").getByRole("button", {
        exact: true,
        name: "Resume",
      }),
    ).toHaveCount(1);
    await expect(
      row(page, "Keep thread replies in order").getByRole("button", {
        name: "Keep fixing",
      }),
    ).toHaveCount(0);
  });

  test("a code change row opens its pull request first", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [breakingReview] });
    await page.goto(`${dashboard.baseURL}/inbox`);
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
