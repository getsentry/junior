import type { Page } from "@playwright/test";

import { NOW_MS } from "../../src/mock-reporting/fixtures";
import { expect, test } from "../test";
import {
  audit,
  conversationId,
  license,
  mockReviewItems,
  prReview,
  rollout,
} from "./inbox-fixture";

// Two child agents of the rollout Conversation each add an ask. They roll up
// under the root's stack, after the root's own ask.
const childOf = (thread: string, label: string) => ({
  addedByChild: { label, rootConversationId: conversationId },
  addedByConversationId: `slack:CQA123:1770003600.${thread}`,
});
const childReview = {
  ...prReview,
  ...childOf("000201", "Check the pipeline runs"),
  createdAt: "2026-08-07T11:55:00.000Z",
  id: "item-child-review",
};
const childLicense = {
  ...license,
  ...childOf("000202", "Read the agent logs"),
  createdAt: "2026-08-07T11:56:00.000Z",
  id: "item-child-license",
};
// Another Conversation's newer ask: the stack after the root's.
const other = { ...audit, createdAt: "2026-08-07T12:00:00.000Z" };

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  async function openStack(page: Page) {
    const stack = page.locator(`li[data-inbox-row="todo:${conversationId}"]`);
    await stack.locator('a[aria-controls^="inbox-row-"]').first().click();
    await expect(stack).toHaveAttribute("data-expanded", "true");
    const asks = stack.getByRole("region", { name: /: asks$/ });
    return {
      card: (item: { title: string }) =>
        asks.getByRole("region", { name: item.title }),
      cards: asks.locator("[data-inbox-card]"),
      stack,
    };
  }

  test("a child agent's ask rolls up under its root and names its child", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [rollout, childReview, other] });
    await page.goto(`${dashboard.baseURL}/`);
    await expect(
      page.locator(
        `li[data-inbox-row="todo:${childReview.addedByConversationId}"]`,
      ),
    ).toHaveCount(0);
    const { card, cards } = await openStack(page);
    await expect(cards).toHaveCount(2);
    await expect(
      card(childReview).getByRole("link", { name: "Check the pipeline runs" }),
    ).toHaveAttribute(
      "href",
      `/conversations/${encodeURIComponent(childReview.addedByConversationId)}`,
    );
    await expect(card(rollout).getByRole("link")).toHaveCount(0);
  });

  for (const motion of ["no-preference", "reduce"] as const) {
    test(`each card dismisses by itself, and next stays in its stack (${motion} motion)`, async ({
      dashboard,
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: motion });
      const actions = await mockReviewItems(page, {
        open: [rollout, childReview, childLicense, other],
      });
      await page.goto(`${dashboard.baseURL}/`);
      const { card, cards, stack } = await openStack(page);
      await expect(cards).toHaveCount(3);
      const dismiss = (item: { title: string }) =>
        card(item).getByRole("button", { exact: true, name: "Dismiss" });

      await dismiss(rollout).click();
      await expect(card(rollout)).toHaveCount(0);
      await expect.poll(() => actions.map((a) => a.id)).toEqual([rollout.id]);
      await expect(stack).toHaveAttribute("data-expanded", "true");
      await expect(card(childReview)).toBeFocused();

      // The last card of a stack goes with it, and the next stack opens.
      await dismiss(childReview).click();
      await expect(card(childLicense)).toBeFocused();
      await dismiss(childLicense).click();
      await expect(stack).toHaveCount(0);
      await expect(
        page.locator(
          `li[data-inbox-row="todo:${other.addedByConversationId}"]`,
        ),
      ).toHaveAttribute("data-expanded", "true");
      expect(actions.map((a) => a.id)).toEqual([
        rollout.id,
        childReview.id,
        childLicense.id,
      ]);
    });
  }

  test("a card snoozes by itself, and Snooze all snoozes the stack", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockReviewItems(page, {
      open: [rollout, childReview, childLicense],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const { card, cards, stack } = await openStack(page);
    const snoozeTomorrow = async (button: string, item?: { title: string }) => {
      const scope = item ? card(item) : stack;
      await scope.getByRole("button", { exact: true, name: button }).click();
      await page.getByRole("button", { name: "Tomorrow" }).click();
    };

    await snoozeTomorrow("Snooze", childReview);
    await expect(cards).toHaveCount(2);
    await expect(stack).toHaveAttribute("data-expanded", "true");
    await expect(card(childLicense)).toBeFocused();
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: /^Snoozed/ })).toContainText(
      "1",
    );

    await snoozeTomorrow("Snooze all");
    await expect(stack).toHaveCount(0);
    await expect(nav.getByRole("link", { name: /^Snoozed/ })).toContainText(
      "3",
    );
    expect(actions).toEqual([]);
  });

  test("a card that closes elsewhere leaves, and its stack stays open", async ({
    dashboard,
    page,
  }) => {
    const open = [rollout, childReview, childLicense];
    const actions = await mockReviewItems(page, { open });
    await page.goto(`${dashboard.baseURL}/`);
    const { card, cards, stack } = await openStack(page);
    await expect(cards).toHaveCount(3);

    // An agent closes the child's review. The viewer comes back to the tab
    // after the reads went stale.
    open.splice(open.indexOf(childReview), 1);
    await page.clock.setFixedTime(NOW_MS + 60_000);
    const read = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/review-items",
    );
    await page.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );
    await read;
    await expect(card(childReview)).toHaveCount(0);
    await expect(cards).toHaveCount(2);
    await expect(stack).toHaveAttribute("data-expanded", "true");
    expect(actions).toEqual([]);
  });
});
