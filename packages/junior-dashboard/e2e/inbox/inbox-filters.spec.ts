import type { Page } from "@playwright/test";

import {
  license,
  migration,
  mockInboxItems,
  prMerge,
  prReview,
  rollout,
} from "./inbox-fixture";
import { expect, test } from "../test";

// The Inbox filters its asks by type, and each filter counts the asks that
// wait on the viewer.
// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  // A To-do: an action with no question and no pull request.
  const todo = {
    ...migration,
    id: "item-todo",
    request: undefined,
    title: "Rotate the staging deploy keys",
  };

  function typeFilter(page: Page, label: string) {
    return page
      .getByRole("navigation", { name: "Asks to show" })
      .getByRole("link", { name: new RegExp(`^${label}`) });
  }

  function inboxTab(page: Page) {
    return page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox/ });
  }

  test("the type counts add up to All and the Inbox count, and a type keeps through a reload", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, {
      automations: () => 0,
      open: [rollout, license, migration, prMerge, prReview, todo],
    });
    await page.goto(`${dashboard.baseURL}/`);
    // Pull requests counts each ask, and a pull request ask with a question
    // is not also a Decision.
    await expect(typeFilter(page, "All")).toHaveText(/^All\s*6$/);
    await expect(typeFilter(page, "PRs")).toHaveText(/^PRs\s*2$/);
    await expect(typeFilter(page, "Decisions")).toHaveText(/^Decisions\s*3$/);
    await expect(typeFilter(page, "Other")).toHaveText(/^Other\s*1$/);
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox, 6 waiting");
    await expect(typeFilter(page, "All")).toHaveAttribute(
      "aria-current",
      "page",
    );

    await typeFilter(page, "PRs").click();
    await expect(page).toHaveURL(/[?&]type=prs/);
    const todoList = page.getByRole("region", { name: "To do" });
    const todoRows = todoList.locator("[data-inbox-row]");
    // Each pull request ask is a row, headed by its pull request.
    await expect(todoRows).toHaveText([
      new RegExp(prReview.subject.title),
      new RegExp(prMerge.subject.title),
    ]);

    await page.reload();
    await expect(typeFilter(page, "PRs")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(todoRows).toHaveText([
      new RegExp(prReview.subject.title),
      new RegExp(prMerge.subject.title),
    ]);
    // The filters do not change the Inbox count.
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox, 6 waiting");

    await typeFilter(page, "Other").click();
    await expect(page).toHaveURL(/[?&]type=other/);
    await expect(todoRows).toHaveCount(1);
    await expect(todoList).toContainText(todo.title);
    await expect(todoList).not.toContainText(prReview.subject.title);
  });

  test("a type with no asks hides, but All shows", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, {
      automations: () => 0,
      open: [rollout, license],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const filters = page
      .getByRole("navigation", { name: "Asks to show" })
      .getByRole("link");
    await expect(filters).toHaveText([/^All\s*2$/, /^Decisions\s*2$/]);
  });
});
