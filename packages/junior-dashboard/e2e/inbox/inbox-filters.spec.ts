import type { Page } from "@playwright/test";

import {
  license,
  migration,
  mockInboxItems,
  prMerge,
  prReady,
  prReview,
  pullRequestSubject,
  rollout,
  todoForYou,
} from "./inbox-fixture";
import { mobile, screenshot } from "../screenshot";
import { expect, test } from "../test";

// The Inbox filters its asks by type, and each filter counts the asks that
// wait on the viewer.
// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  // An Other ask: an action with no question, no pull request, and no
  // To-do.
  const other = {
    ...migration,
    id: "item-other",
    request: undefined,
    title: "Rotate the staging deploy keys",
  };
  // A question that cites a pull request is a Decision, not a PR.
  const citesPr = {
    ...rollout,
    id: "item-cites-pr",
    subject: pullRequestSubject({
      id: "item-cites-pr",
      kind: "question",
      title: "Pin the release train",
      url: "https://github.com/getsentry/payments/pull/91",
    }),
    title: "Ship the release train today?",
  };

  function typeFilter(page: Page, label: string) {
    return page
      .getByRole("navigation", { name: "Asks to show" })
      .getByRole("link", { name: new RegExp(`^${label}`) });
  }

  function typeFilters(page: Page) {
    return page
      .getByRole("navigation", { name: "Asks to show" })
      .getByRole("link");
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
      open: [
        rollout,
        license,
        migration,
        prMerge,
        prReview,
        todoForYou,
        other,
        citesPr,
      ],
    });
    await page.goto(`${dashboard.baseURL}/inbox`);
    // Pull requests counts a code change's own asks, and a pull request ask
    // with a question is not also a Decision. A question that cites a pull
    // request is a Decision. A To-do counts in To-dos, not in Other. All,
    // the default, is at the right edge.
    await expect(typeFilters(page)).toHaveText([
      /^Other\s*1$/,
      /^PRs\s*2$/,
      /^Decisions\s*4$/,
      /^To-dos\s*1$/,
      /^Pinned$/,
      /^All\s*8$/,
    ]);
    // Tab moves through the tabs in their order on screen.
    const tabs = typeFilters(page);
    await tabs.first().focus();
    for (let index = 1; index < (await tabs.count()); index += 1) {
      await page.keyboard.press("Tab");
      await expect(tabs.nth(index)).toBeFocused();
    }
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox, 8 waiting");
    await expect(typeFilter(page, "All")).toHaveAttribute(
      "aria-current",
      "page",
    );

    await typeFilter(page, "PRs").click();
    await expect(page).toHaveURL(/[?&]type=prs/);
    const todoList = page.getByRole("region", { name: "To do" });
    const todoRows = todoList.getByRole("listitem");
    // Each pull request ask is a row, headed by its pull request.
    await expect(todoRows).toHaveText([
      new RegExp(prReview.subject.object.title),
      new RegExp(prMerge.subject.object.title),
    ]);

    await page.reload();
    await expect(typeFilter(page, "PRs")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(todoRows).toHaveText([
      new RegExp(prReview.subject.object.title),
      new RegExp(prMerge.subject.object.title),
    ]);
    // The filters do not change the Inbox count.
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox, 8 waiting");

    await typeFilter(page, "To-dos").click();
    await expect(page).toHaveURL(/[?&]type=todos/);
    await expect(todoRows).toHaveCount(1);
    await expect(todoList).toContainText(todoForYou.title);
    await expect(todoList).not.toContainText(other.title);

    await typeFilter(page, "Other").click();
    await expect(page).toHaveURL(/[?&]type=other/);
    await expect(todoRows).toHaveCount(1);
    await expect(todoList).toContainText(other.title);
    await expect(todoList).not.toContainText(todoForYou.title);
    await expect(todoList).not.toContainText(prReview.subject.object.title);

    // Pinned is a tab of the same control, so it turns the type off, and a
    // type turns Pinned off.
    await typeFilter(page, "Pinned").click();
    await expect(page).toHaveURL(/[?&]pinned=1/);
    await expect(page).not.toHaveURL(/[?&]type=/);
    await expect(typeFilter(page, "Pinned")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(typeFilter(page, "Other")).not.toHaveAttribute("aria-current");
    await typeFilter(page, "PRs").click();
    await expect(page).toHaveURL(/[?&]type=prs/);
    await expect(page).not.toHaveURL(/[?&]pinned=/);
  });

  test("a type with no asks hides, but All shows", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, {
      automations: () => 0,
      open: [rollout, license],
    });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expect(typeFilters(page)).toHaveText([
      /^Decisions\s*2$/,
      /^Pinned$/,
      /^All\s*2$/,
    ]);
  });

  test("an agent notice that cites a pull request is not under PRs", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, {
      automations: () => 0,
      open: [prReview, prReady],
    });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expect(page.getByText(prReady.title)).toBeVisible();

    await typeFilter(page, "PRs").click();
    await expect(page).toHaveURL(/[?&]type=prs/);
    await expect(
      page
        .getByRole("region", { name: "To do" })
        .getByRole("listitem")
        .filter({ hasText: prReview.subject.object.title }),
    ).not.toHaveCount(0);
    await expect(page.getByText(prReady.title)).toHaveCount(0);
  });

  test("on a phone every tab fits one row of the header, also with a two-digit count on each type", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(mobile);
    // Ten asks of each type.
    const tenOf = <Item extends { id: string }>(item: Item) =>
      Array.from({ length: 10 }, (_, index) => ({
        ...item,
        id: `${item.id}-${index}`,
      }));
    await mockInboxItems(page, {
      automations: () => 0,
      open: [rollout, prMerge, todoForYou, other].flatMap(tenOf),
    });
    // On a phone, `/inbox` lists the entries; the Inbox has its own page.
    await page.goto(`${dashboard.baseURL}/inbox?view=inbox`);
    const tabs = typeFilters(page);
    await expect(tabs).toHaveText([
      /^Other\s*10$/,
      /^PRs\s*10$/,
      /^Decisions\s*10$/,
      /^To-dos\s*10$/,
      /^Pinned$/,
      /^All\s*40$/,
    ]);
    await expect(
      page.getByRole("heading", { exact: true, name: "Inbox" }),
    ).toBeInViewport({ ratio: 1 });
    // Each type shows only its icon and count; the name stays for screen
    // readers.
    await expect(tabs.first()).toHaveAccessibleName(/^Other/);
    // The row does not wrap, so a tab that does not fit leaves the screen.
    for (const tab of await tabs.all()) {
      await expect(tab).toBeInViewport({ ratio: 1 });
    }
    await screenshot(page, "inbox-type-filters", { lightTheme: true });
  });

  test("a link to an ask that a filter hides shows its row and clears the filter", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, {
      automations: () => 0,
      open: [prMerge, prReview, other],
    });
    await page.goto(
      `${dashboard.baseURL}/inbox?type=prs&pinned=1&item=${other.id}`,
    );
    const todoList = page.getByRole("region", { name: "To do" });
    await expect(
      // The innermost row: a stack row also holds the ask.
      todoList.getByRole("listitem").filter({ hasText: other.title }).last(),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/[?&](item|type|pinned)=/);
    await expect(typeFilter(page, "All")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
