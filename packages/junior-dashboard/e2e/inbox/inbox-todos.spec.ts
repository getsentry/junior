import type { Page } from "@playwright/test";

import {
  conversationId,
  expandRow,
  mockInboxItems,
  rollout,
  rowHead,
  todoForYou,
} from "./inbox-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const checkout = "Investigate checkout latency";
  const todo = (page: Page) => page.getByRole("region", { name: "To do" });
  const rowOf = (page: Page) =>
    page.locator(`li[data-inbox-row="todo:${todoForYou.id}"]`);
  const inboxTab = (page: Page) =>
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox/ });

  test("a To-do for the viewer waits in To do, and Done closes it", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockInboxItems(page, {
      automations: () => 0,
      open: [todoForYou],
    });
    await page.goto(`${dashboard.baseURL}/?view=inbox`);
    // It needs the viewer, so it counts in the tab.
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox, 1 waiting");
    // The row's icon marks it as a To do for you.
    await expect(
      rowOf(page).locator('[data-ask-kind="To do for you"]'),
    ).toHaveCount(1);
    await expandRow(rowHead(todo(page), checkout));
    const card = rowOf(page).locator("[data-inbox-card]");
    await expect(
      card.getByText("Check the deploy calendar before the next release."),
    ).toBeVisible();
    await screenshot(page, "inbox-todo-for-you", { lightTheme: true });
    // Only Done closes the viewer's own To-do.
    await expect(
      card.getByRole("button", { exact: true, name: "Dismiss" }),
    ).toHaveCount(0);
    await card.getByRole("button", { exact: true, name: "Done" }).click();

    await expect(rowOf(page)).toHaveCount(0);
    expect(actions).toEqual([{ body: { action: "done" }, id: todoForYou.id }]);
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox");
  });

  test("a To-do row's quick actions are Done and Snooze", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockInboxItems(page, { open: [todoForYou] });
    await page.goto(`${dashboard.baseURL}/`);
    await rowHead(todo(page), checkout).hover();
    await expect(
      rowOf(page).getByRole("button", { exact: true, name: "Dismiss" }),
    ).toHaveCount(0);
    await expect(
      rowOf(page).getByRole("button", { exact: true, name: "Snooze" }),
    ).toBeVisible();
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
    await page.goto(`${dashboard.baseURL}/`);
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
    await page.goto(`${dashboard.baseURL}/`);
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
    await page.goto(`${dashboard.baseURL}/`);
    const stack = page.locator(
      `li[data-inbox-stack][data-dock-key$=":${conversationId}"]`,
    );
    await expect(stack.locator("li[data-inbox-row]")).toHaveCount(2);
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
