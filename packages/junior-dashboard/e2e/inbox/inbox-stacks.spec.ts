import type { Locator, Page } from "@playwright/test";

import { NOW_MS } from "../../src/mock-reporting/fixtures";
import { expect, test } from "../test";
import {
  audit,
  conversationId,
  grab,
  license,
  mockReviewItems,
  prReview,
  rollout,
} from "./inbox-fixture";

// Child agents of the rollout Conversation each add an ask. They roll up
// under the root's stack, after the root's own ask.
const childOf = (thread: string, label: string) => ({
  addedByConversationId: `slack:CQA123:1770003600.${thread}`,
  addedByLabel: label,
  rootConversationId: conversationId,
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
// More asks from one child, so the stack folds past its fourth row.
const childAsks = [1, 2, 3].map((n) => ({
  ...license,
  ...childOf("000203", "Sweep the license entries"),
  createdAt: `2026-08-07T11:5${6 + n}:00.000Z`,
  id: `item-child-ask-${n}`,
  title: `Check license entry ${n}`,
}));
// Another Conversation's newer ask: a row of its own, after the stack.
const other = { ...audit, createdAt: "2026-08-07T12:00:00.000Z" };

const stackOf = (page: Page) =>
  // A stack's key has its section, as `todo:`, before the Conversation.
  page.locator(`li[data-inbox-stack][data-dock-key$=":${conversationId}"]`);
const rowOf = (page: Page, item: { id: string }) =>
  page.locator(`li[data-inbox-row="todo:${item.id}"]`);
const dismissIn = (row: ReturnType<typeof rowOf>) =>
  row
    .locator("[data-inbox-card]")
    .getByRole("button", { exact: true, name: "Dismiss" });

// How opaque an element shows: its own opacity times its ancestors'.
const shownOpacity = (locator: Locator) =>
  locator.evaluate((element) => {
    let opacity = 1;
    for (let at: Element | null = element; at; at = at.parentElement)
      opacity *= Number(getComputedStyle(at).opacity);
    return opacity;
  });

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  test("a child agent's ask rolls up under its root's stack and names its sub-thread", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [rollout, childReview, other] });
    await page.goto(`${dashboard.baseURL}/`);
    const stack = stackOf(page);
    await expect(stack.locator("li[data-inbox-row]")).toHaveCount(2);
    await expect(
      page.locator(
        `li[data-inbox-row="todo:${childReview.addedByConversationId}"]`,
      ),
    ).toHaveCount(0);
    await expect(rowOf(page, childReview)).toContainText(
      "Check the pipeline runs",
    );
    await expect(stack.locator("a").first()).toHaveAttribute(
      "href",
      `/conversations/${encodeURIComponent(conversationId)}`,
    );
    // A Conversation with one ask shows that ask's own row, with no stack.
    const lone = rowOf(page, other);
    await expect(lone).toHaveCount(1);
    await expect(
      lone.locator("xpath=ancestor::li[@data-inbox-stack]"),
    ).toHaveCount(0);
    // It is an item row: a click opens it in place, and it has no
    // Conversation actions.
    await lone.hover();
    await expect(lone.getByRole("button", { name: /^Archive / })).toHaveCount(
      0,
    );
    await lone.locator("[data-inbox-head]").click();
    await expect(lone).toHaveAttribute("data-expanded", "true");
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
    // Open, it has its answer and its own actions, but no Pin.
    await expect(dismissIn(lone)).toBeVisible();
    await expect(lone.getByRole("button", { name: /^(Un)?pin/i })).toHaveCount(
      0,
    );
  });

  for (const motion of ["no-preference", "reduce"] as const) {
    test(`a row click opens the row, each row dismisses by itself, and next stays in the stack (${motion} motion)`, async ({
      dashboard,
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: motion });
      const actions = await mockReviewItems(page, {
        open: [rollout, childReview, childLicense, other],
      });
      await page.goto(`${dashboard.baseURL}/`);
      const stack = stackOf(page);
      await rowOf(page, rollout).locator("[data-inbox-head]").click();
      await expect(rowOf(page, rollout)).toHaveAttribute(
        "data-expanded",
        "true",
      );

      await dismissIn(rowOf(page, rollout)).click();
      await expect(rowOf(page, rollout)).toHaveCount(0);
      await expect.poll(() => actions.map((a) => a.id)).toEqual([rollout.id]);
      await expect(rowOf(page, childReview)).toHaveAttribute(
        "data-expanded",
        "true",
      );
      // A stack of one is that ask's own row, still open.
      await dismissIn(rowOf(page, childReview)).click();
      await expect(stack).toHaveCount(0);
      const lone = rowOf(page, childLicense);
      await expect(lone).toHaveAttribute("data-expanded", "true");
      await expect(lone).toContainText(childLicense.title);

      // Its last ask takes the row, and the next row opens.
      await dismissIn(lone).click();
      await expect(lone).toHaveCount(0);
      await expect(rowOf(page, other)).toHaveAttribute("data-expanded", "true");
      expect(actions.map((a) => a.id)).toEqual([
        rollout.id,
        childReview.id,
        childLicense.id,
      ]);
    });
  }

  test("the last row of a stack opens a row of its own stack next", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, {
      open: [rollout, childReview, childLicense, other],
    });
    await page.goto(`${dashboard.baseURL}/`);
    await rowOf(page, childLicense).locator("[data-inbox-head]").click();
    await dismissIn(rowOf(page, childLicense)).click();
    await expect(rowOf(page, childReview)).toHaveAttribute(
      "data-expanded",
      "true",
    );
    await expect(rowOf(page, other)).not.toHaveAttribute("data-expanded");
  });

  test("a row's quick actions show on hover and act on that row only", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockReviewItems(page, {
      open: [rollout, childReview, childLicense],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const row = rowOf(page, childReview);
    const quick = (name: string) =>
      row.getByRole("button", { exact: true, name });
    await expect.poll(() => shownOpacity(quick("Dismiss"))).toBe(0);
    await row.hover();
    await expect.poll(() => shownOpacity(quick("Dismiss"))).toBe(1);
    await expect(quick("Dismiss")).toHaveAttribute("title", "Dismiss");
    // They use the action bar's words.
    await expect(quick("Snooze")).toHaveText("Snooze");
    await expect(quick("Dismiss")).toHaveText("Dismiss");
    // Open goes to the child that asked, at its ask.
    const open = row.getByRole("link", { name: "Open conversation" });
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute(
      "href",
      `/conversations/${encodeURIComponent(childReview.addedByConversationId)}?ask=${childReview.id}`,
    );
    await quick("Dismiss").click();
    await expect(row).toHaveCount(0);
    await expect(stackOf(page).locator("li[data-inbox-row]")).toHaveCount(2);
    expect(actions.map((a) => a.id)).toEqual([childReview.id]);

    const license = rowOf(page, childLicense);
    await license.hover();
    await license.getByRole("button", { exact: true, name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(license).toHaveCount(0);
    // The root's own ask is left, in its own row.
    await expect(stackOf(page)).toHaveCount(0);
    await expect(rowOf(page, rollout)).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: /^Snoozed/ })).toContainText(
      "1",
    );
  });

  test("a Conversations row with one ask keeps its Pin and Archive", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [rollout] });
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const row = page.locator(
      `li[data-inbox-row="conversation:${conversationId}"]`,
    );
    await row.hover();
    await expect(row.getByRole("button", { name: /^Archive / })).toBeVisible();
    await expect(
      row.getByRole("button", { exact: true, name: "Dismiss" }),
    ).toHaveCount(0);
  });

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true });

    test("a row shows its actions only once it is open", async ({
      dashboard,
      page,
    }) => {
      await mockReviewItems(page, { open: [rollout, childReview] });
      await page.goto(`${dashboard.baseURL}/`);
      const row = rowOf(page, childReview);
      const open = row.getByRole("link", { name: "Open conversation" });
      await expect(open).toBeHidden();
      await expect(
        row.getByRole("button", { exact: true, name: "Dismiss" }),
      ).toBeHidden();
      await row.locator("[data-inbox-head]").tap();
      await expect(row).toHaveAttribute("data-expanded", "true");
      await expect(open.first()).toBeVisible();
      await expect(dismissIn(row)).toBeVisible();
    });
  });

  test("a stack past four rows folds, and next walks past the fold", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, {
      open: [rollout, childReview, childLicense, ...childAsks],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const stack = stackOf(page);
    const more = stack.getByRole("button", {
      name: "+2 more in this Conversation",
    });
    await expect(more).toBeVisible();
    await expect(rowOf(page, childAsks[0]!)).toBeVisible();
    await expect(rowOf(page, childAsks[1]!)).toBeHidden();

    // Next opens the row past the fold, and the fold opens with it.
    await rowOf(page, childAsks[0]!).locator("[data-inbox-head]").click();
    await dismissIn(rowOf(page, childAsks[0]!)).click();
    await expect(rowOf(page, childAsks[1]!)).toHaveAttribute(
      "data-expanded",
      "true",
    );
    await expect(rowOf(page, childAsks[1]!)).toBeVisible();

    // The control shows the rest in place.
    await rowOf(page, childAsks[1]!).locator("[data-inbox-head]").click();
    await expect(
      stack.getByRole("button", { name: "+1 more in this Conversation" }),
    ).toBeVisible();
    await stack
      .getByRole("button", { name: "+1 more in this Conversation" })
      .click();
    await expect(rowOf(page, childAsks[2]!)).toBeVisible();
    await expect(
      stack.getByRole("button", { name: /more in this/ }),
    ).toHaveCount(0);
  });

  test("the stack Dismiss closes every ask of the stack, and the next row opens", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockReviewItems(page, {
      open: [rollout, childReview, childLicense, other],
    });
    await page.goto(`${dashboard.baseURL}/`);
    // The header names the stack's count once, not in each button.
    await expect(
      stackOf(page).getByText("3 items", { exact: true }),
    ).toHaveCount(1);
    await rowOf(page, childReview).locator("[data-inbox-head]").click();
    await expect(rowOf(page, childReview)).toHaveAttribute(
      "data-expanded",
      "true",
    );
    await stackOf(page)
      .getByRole("button", {
        exact: true,
        name: "Dismiss 3 items in this stack",
      })
      .click();
    await expect(stackOf(page)).toHaveCount(0);
    await expect(rowOf(page, other)).toHaveAttribute("data-expanded", "true");
    await expect
      .poll(() => actions.map((action) => action.id).sort())
      .toEqual([childLicense.id, childReview.id, rollout.id].sort());
  });

  test("the stack Snooze snoozes the stack, and Wake wakes one row", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockReviewItems(page, {
      open: [rollout, childReview, childLicense],
    });
    await page.goto(`${dashboard.baseURL}/`);
    await stackOf(page)
      .getByRole("button", {
        exact: true,
        name: "Snooze 3 items in this stack",
      })
      .click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(stackOf(page)).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Primary" });
    const snoozed = nav.getByRole("link", { name: /^Snoozed/ });
    await expect(snoozed).toContainText("3");

    await snoozed.click();
    // Snoozed rows have no section prefix.
    const row = page.locator(`li[data-inbox-row="${childReview.id}"]`);
    await row.locator("[data-inbox-head]").click();
    await expect(row).toHaveAttribute("data-expanded", "true");
    await row.getByRole("button", { exact: true, name: "Wake" }).click();
    await expect(row).toHaveCount(0);
    await expect(stackOf(page).locator("li[data-inbox-row]")).toHaveCount(2);
    await expect(snoozed).toContainText("2");
    expect(actions).toEqual([]);
  });

  test("the stack Snooze puts away a stack whose newest ask snoozed by itself", async ({
    dashboard,
    page,
  }) => {
    const newest = childAsks[0]!;
    await mockReviewItems(page, {
      open: [rollout, childReview, childLicense, newest],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const row = rowOf(page, newest);
    await row.hover();
    await row.getByRole("button", { exact: true, name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(row).toHaveCount(0);
    await stackOf(page)
      .getByRole("button", {
        exact: true,
        name: "Snooze 3 items in this stack",
      })
      .click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(stackOf(page)).toHaveCount(0);
    await expect(rowOf(page, rollout)).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: /^Snoozed/ })).toContainText(
      "4",
    );
  });

  test("the stack Snooze puts the stack away, and a later ask shows by itself", async ({
    dashboard,
    page,
  }) => {
    const open = [rollout, childReview, childLicense, other];
    await mockReviewItems(page, { open });
    await page.goto(`${dashboard.baseURL}/`);
    await rowOf(page, childReview).locator("[data-inbox-head]").click();
    await stackOf(page)
      .getByRole("button", {
        exact: true,
        name: "Snooze 3 items in this stack",
      })
      .click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(stackOf(page)).toHaveCount(0);
    // The open row was in the stack, so the next row opens.
    await expect(rowOf(page, other)).toHaveAttribute("data-expanded", "true");

    // A child agent asks again after the snooze.
    const later = {
      ...childAsks[0]!,
      createdAt: new Date(NOW_MS + 30_000).toISOString(),
    };
    open.push(later);
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
    await expect(rowOf(page, later)).toBeVisible();
    await expect(rowOf(page, rollout)).toHaveCount(0);
    await expect(rowOf(page, childReview)).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Primary" });
    const snoozed = nav.getByRole("link", { name: /^Snoozed/ });
    await expect(snoozed).toContainText("3");

    // The rest stay snoozed, stacked the same way.
    await snoozed.click();
    await expect(stackOf(page).locator("li[data-inbox-row]")).toHaveCount(3);
  });

  test("a row that closes elsewhere leaves, and the open row stays open", async ({
    dashboard,
    page,
  }) => {
    const open = [rollout, childReview, childLicense];
    const actions = await mockReviewItems(page, { open });
    await page.goto(`${dashboard.baseURL}/`);
    await rowOf(page, rollout).locator("[data-inbox-head]").click();

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
    await expect(rowOf(page, childReview)).toHaveCount(0);
    await expect(stackOf(page).locator("li[data-inbox-row]")).toHaveCount(2);
    await expect(rowOf(page, rollout)).toHaveAttribute("data-expanded", "true");
    expect(actions).toEqual([]);
  });

  test("a section counts its rows, not its stacks", async ({
    dashboard,
    page,
  }) => {
    const grabs = [
      grab,
      { ...grab, id: "item-grab-2", title: "Cover the release" },
    ];
    await mockReviewItems(page, { automations: () => 0, open: grabs });
    await page.goto(`${dashboard.baseURL}/`);
    const section = page.getByRole("region", { name: "Up for grabs" });
    await expect(section.locator("li[data-inbox-row]")).toHaveCount(2);
    // A collapsed section shows its count.
    const heading = section.getByRole("button", { name: /^Up for grabs/ });
    await heading.click();
    await expect(heading).toHaveText("Up for grabs2");
  });

  test("a row snooze from before item snoozes keeps its items asleep", async ({
    dashboard,
    page,
  }) => {
    // The old record snoozed the whole row, under its Conversation, until a
    // newer item than its newest arrived.
    await page.addInitScript(
      ([key, newestItemId]) =>
        window.localStorage.setItem(
          "junior:inbox:snoozed",
          JSON.stringify({
            [key!]: { newestItemId, untilMs: Date.now() + 86_400_000 },
          }),
        ),
      [conversationId, childReview.id],
    );
    await mockReviewItems(page, { open: [rollout, childReview, childLicense] });
    await page.goto(`${dashboard.baseURL}/`);
    // The newer ask shows by itself. The two it put away stay asleep.
    await expect(rowOf(page, childLicense)).toBeVisible();
    await expect(rowOf(page, rollout)).toHaveCount(0);
    await expect(rowOf(page, childReview)).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: /^Snoozed/ })).toContainText(
      "2",
    );
  });

  test("a row snooze from before item snoozes keeps its later page asleep", async ({
    dashboard,
    page,
  }) => {
    await page.addInitScript(
      ([key, newestItemId]) =>
        window.localStorage.setItem(
          "junior:inbox:snoozed",
          JSON.stringify({
            [key!]: { newestItemId, untilMs: Date.now() + 86_400_000 },
          }),
        ),
      [conversationId, childReview.id],
    );
    // The row's older ask comes on the second page, after the first converts.
    await mockReviewItems(page, {
      open: [childReview, childLicense, rollout],
      pageSize: 2,
    });
    let releaseLaterPages = () => {};
    const laterPages = new Promise<void>((resolve) => {
      releaseLaterPages = resolve;
    });
    await page.route(/\/api\/review-items\?.*cursor=/, async (route) => {
      await laterPages;
      await route.fallback();
    });
    await page.goto(`${dashboard.baseURL}/`);
    await expect(rowOf(page, childLicense)).toBeVisible();
    await expect(rowOf(page, childReview)).toHaveCount(0);
    releaseLaterPages();
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: /^Snoozed/ })).toContainText(
      "2",
    );
    await expect(rowOf(page, rollout)).toHaveCount(0);
  });
});
