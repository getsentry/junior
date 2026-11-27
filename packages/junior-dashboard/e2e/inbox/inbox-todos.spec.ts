import type { Page } from "@playwright/test";

import {
  conversationId,
  expandRow,
  mockInboxItems,
  rollout,
  rowHead,
  todoForYou,
} from "./inbox-fixture";
import { desktop, screenshot } from "../screenshot";
import { expect, test } from "../test";

test.describe("new UI", () => {
  const checkout = "Investigate checkout latency";
  const todo = (page: Page) => page.getByRole("region", { name: "To do" });
  // The To-do's row: the innermost list item with its link, also when it
  // sits in a stack.
  const rowOf = (page: Page) =>
    todo(page)
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: todoForYou.title }) })
      .last();
  // Its own actions, in order: Dismiss, Snooze, then Done, the main one.
  const ownActions = (scope: ReturnType<typeof rowOf>) =>
    scope.getByRole("button", { name: /^(Dismiss|Snooze|Done|Mark done)$/ });
  const inboxTab = (page: Page) =>
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox/ });

  test("a To-do for the viewer waits in To do, and Mark done closes it", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockInboxItems(page, {
      automations: () => 0,
      open: [todoForYou],
    });
    await page.goto(`${dashboard.baseURL}/inbox?view=inbox`);
    // It needs the viewer, so it counts in the tab.
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox, 1 waiting");
    await expandRow(rowHead(todo(page), checkout));
    const card = rowOf(page).getByRole("region", { name: todoForYou.title });
    await expect(
      card.getByText("Check the deploy calendar before the next release."),
    ).toBeVisible();
    await screenshot(page, "inbox-todo-for-you", { lightTheme: true });
    await expect(ownActions(card)).toHaveText([
      "Dismiss",
      "Snooze",
      "Mark done",
    ]);
    await card.getByRole("button", { exact: true, name: "Mark done" }).click();

    await expect(rowOf(page)).toHaveCount(0);
    expect(actions).toEqual([{ body: { action: "done" }, id: todoForYou.id }]);
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox");
  });

  test("Dismiss drops a To-do", async ({ dashboard, page }) => {
    const actions = await mockInboxItems(page, {
      automations: () => 0,
      open: [todoForYou],
    });
    await page.goto(`${dashboard.baseURL}/inbox?view=inbox`);
    await expandRow(rowHead(todo(page), checkout));
    await rowOf(page)
      .getByRole("region", { name: todoForYou.title })
      .getByRole("button", { exact: true, name: "Dismiss" })
      .click();

    await expect(rowOf(page)).toHaveCount(0);
    expect(actions).toEqual([
      { body: { action: "dismiss" }, id: todoForYou.id },
    ]);
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox");
  });

  test("a To-do row's quick actions are Dismiss, Snooze, and Done", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockInboxItems(page, { open: [todoForYou] });
    // The shot keeps the pointer on the row, so it needs no resize.
    await page.setViewportSize(desktop);
    await page.goto(`${dashboard.baseURL}/inbox`);
    await rowHead(todo(page), checkout).hover();
    await expect(ownActions(rowOf(page))).toHaveText([
      "Dismiss",
      "Snooze",
      "Done",
    ]);
    await screenshot(page, "inbox-todo-row-actions", {
      hover: true,
      lightTheme: true,
      view: "desktop",
    });
    await rowOf(page)
      .getByRole("button", { exact: true, name: "Done" })
      .click();
    await expect(rowOf(page)).toHaveCount(0);
    expect(actions).toEqual([{ body: { action: "done" }, id: todoForYou.id }]);
  });

  test("Open on a To-do row goes to its Conversation", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [todoForYou] });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expandRow(rowHead(todo(page), checkout));
    await rowOf(page)
      .getByRole("link", { name: "Open conversation" })
      .first()
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/conversations/${encodeURIComponent(conversationId)}`),
    );
  });

  test("Snooze puts a To-do away", async ({ dashboard, page }) => {
    await mockInboxItems(page, { automations: () => 0, open: [todoForYou] });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expandRow(rowHead(todo(page), checkout));
    await rowOf(page)
      .getByRole("button", { exact: true, name: "Snooze" })
      .click();
    const created = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/api/inbox/snoozes"),
    );
    await page.getByRole("button", { name: "Tomorrow" }).click();
    expect((await created).postDataJSON()).toEqual({
      conversationId,
      inboxItemId: todoForYou.id,
      wakeAt: expect.any(String),
    });
    await expect(rowOf(page)).toHaveCount(0);
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox");
  });

  test("a To-do stacks with its Conversation's asks, and the stack's Dismiss leaves it", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockInboxItems(page, {
      open: [rollout, todoForYou],
    });
    await page.goto(`${dashboard.baseURL}/inbox`);
    const stack = todo(page).getByRole("listitem", { name: checkout });
    await expect(stack.getByRole("list").getByRole("listitem")).toHaveCount(2);
    await stack
      .getByRole("button", {
        exact: true,
        name: "Dismiss 1 item in this stack",
      })
      .click();
    await expect
      .poll(() => actions)
      .toEqual([{ body: { action: "dismiss" }, id: rollout.id }]);
    await expect(rowOf(page)).toHaveCount(1);
  });
});
