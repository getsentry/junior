import type { Page } from "@playwright/test";

import { expect, test } from "../test";
import {
  audit,
  conversationId,
  digest,
  license,
  mockReviewItems,
  pinChecks,
  pinReview,
  prReview,
  rollout,
} from "./inbox-fixture";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  // To do asks, each in its own Conversation, in To do's order, oldest
  // first: a button question, two forms, and an ask with Dismiss only.
  const asks = [
    { ...rollout, createdAt: "2026-08-07T08:00:00.000Z" },
    {
      ...license,
      addedByConversationId: "slack:CLICENSE:1770003600.000400",
      rootConversationId: "slack:CLICENSE:1770003600.000400",
      createdAt: "2026-08-07T08:10:00.000Z",
    },
    {
      ...audit,
      addedByConversationId: "slack:CAUDIT:1770003600.000500",
      rootConversationId: "slack:CAUDIT:1770003600.000500",
      createdAt: "2026-08-07T08:20:00.000Z",
    },
    { ...prReview, createdAt: "2026-08-07T08:30:00.000Z" },
  ];
  const [buttons, form, other, plain] = asks;

  const row = (page: Page, ask: (typeof asks)[number]) =>
    page.locator(`li[data-inbox-row="todo:${ask.id}"]`);
  const open = async (page: Page, ask: (typeof asks)[number]) => {
    await row(page, ask)
      .locator('[aria-controls^="inbox-row-"]')
      .first()
      .click();
    await expect(row(page, ask)).toHaveAttribute("data-expanded", "true");
  };
  const badge = (page: Page) =>
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox, \d+ waiting$/ });
  // A row's Dismiss: its card's own, which closes the row's one ask.
  const rowDone = (page: Page, ask: (typeof asks)[number]) =>
    row(page, ask).getByRole("button", { exact: true, name: "Dismiss" }).last();

  /** Hold every action request until `release`, then answer it as the mock. */
  async function holdActions(page: Page) {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const sent: string[] = [];
    await page.route("**/api/review-items/*/actions", async (route) => {
      sent.push(new URL(route.request().url()).pathname.split("/").at(-2)!);
      await held;
      await route.fallback();
    });
    return { release, sent };
  }

  test("Done and each kind of answer apply before the server answers", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [...asks] });
    const actions = await holdActions(page);
    await page.goto(`${dashboard.baseURL}/`);
    await expect(badge(page)).toHaveAccessibleName("Inbox, 4 waiting");

    // A button answer.
    await open(page, buttons!);
    await row(page, buttons!).getByRole("button", { name: "Roll out" }).click();
    await expect(row(page, form!)).toHaveAttribute("data-expanded", "true");
    await expect(row(page, buttons!)).toHaveCount(0);
    await expect(badge(page)).toHaveAccessibleName("Inbox, 3 waiting");

    // A form with a choice and text, which opened in its place.
    const formItem = row(page, form!);
    await formItem.getByRole("radio", { name: "Approve" }).click();
    await formItem.getByLabel("Reason").fill("MIT, no change.");
    await formItem.getByRole("button", { name: "Send" }).click();
    await expect(row(page, other!)).toHaveAttribute("data-expanded", "true");
    await expect(row(page, form!)).toHaveCount(0);

    // The card's own Dismiss.
    await rowDone(page, other!).click();
    await expect(row(page, plain!)).toHaveAttribute("data-expanded", "true");
    await expect(row(page, other!)).toHaveCount(0);
    await expect(badge(page)).toHaveAccessibleName("Inbox, 1 waiting");

    // Every action is still in flight, and none of them clobbered another.
    expect(actions.sent.sort()).toEqual(
      [buttons!.id, form!.id, other!.id].sort(),
    );
    actions.release();
    await expect(row(page, plain!)).toHaveAttribute("data-expanded", "true");
    for (const ask of [buttons!, form!, other!]) {
      await expect(row(page, ask)).toHaveCount(0);
    }
  });

  test("a failed Done brings the row back in its place, and Retry sends it again", async ({
    dashboard,
    page,
  }) => {
    const failActions = [plain!.id];
    const done = await mockReviewItems(page, {
      failActions,
      open: [...asks],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const rows = page
      .getByRole("region", { name: "To do" })
      .locator(":scope > ul > li[data-inbox-row]");
    await expect(rows).toHaveCount(4);
    await open(page, plain!);
    await rowDone(page, plain!).click();

    const toast = page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Could not dismiss" });
    await expect(toast).toBeVisible();
    // The row is last again, and it opens again: the viewer did not move on.
    await expect(rows.last()).toHaveAttribute(
      "data-inbox-row",
      `todo:${plain!.id}`,
    );
    await expect(row(page, plain!)).toHaveAttribute("data-expanded", "true");
    await expect(badge(page)).toHaveAccessibleName("Inbox, 4 waiting");

    failActions.length = 0;
    await toast.getByRole("button", { name: "Retry" }).click();
    await expect(row(page, plain!)).toHaveCount(0);
    expect(done).toEqual([{ body: { action: "dismiss" }, id: plain!.id }]);
  });

  test("a failed answer keeps its draft, and the next row that opened stays open after the viewer moves on", async ({
    dashboard,
    page,
  }) => {
    const failActions = [form!.id, buttons!.id];
    const done = await mockReviewItems(page, { failActions, open: [...asks] });
    await page.goto(`${dashboard.baseURL}/`);

    // The viewer opens another row before the failure lands, so the row
    // comes back shut.
    let fail = () => {};
    const failing = new Promise<void>((resolve) => (fail = resolve));
    await page.route(
      `**/api/review-items/${buttons!.id}/actions`,
      async (route) => {
        await failing;
        await route.fallback();
      },
    );
    await open(page, buttons!);
    await row(page, buttons!).getByRole("button", { name: "Hold" }).click();
    await expect(row(page, buttons!)).toHaveCount(0);
    await open(page, plain!);
    fail();
    await expect(
      page
        .locator('[data-slot="toast"]')
        .filter({ hasText: "Could not send your answer" }),
    ).toHaveCount(1);
    await expect(row(page, buttons!)).not.toHaveAttribute("data-expanded");
    await expect(row(page, plain!)).toHaveAttribute("data-expanded", "true");

    await open(page, form!);
    const formItem = row(page, form!);
    await formItem.getByRole("radio", { name: "Approve" }).click();
    await formItem.getByLabel("Reason").fill("MIT, no change.");
    await formItem.getByLabel("Anything else?").fill("Ask legal first.");
    await formItem.getByRole("button", { name: "Send" }).click();
    const toast = page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Could not send your answer" })
      .filter({ hasText: form!.title });
    await expect(toast).toBeVisible();
    await expect(formItem).toHaveAttribute("data-expanded", "true");
    await expect(
      formItem.getByRole("radio", { name: "Approve" }),
    ).toBeChecked();
    await expect(formItem.getByLabel("Reason")).toHaveValue("MIT, no change.");
    await expect(formItem.getByLabel("Anything else?")).toHaveValue(
      "Ask legal first.",
    );

    failActions.length = 0;
    await toast.getByRole("button", { name: "Retry" }).click();
    await expect(formItem).toHaveCount(0);
    expect(done).toEqual([
      {
        body: {
          action: "submit",
          answer: {
            other: "Ask legal first.",
            values: { decision: ["Approve"], reason: ["MIT, no change."] },
          },
        },
        id: form!.id,
      },
    ]);
  });

  test("Snooze and Wake open the next row as the row starts to leave", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [...asks] });
    await page.goto(`${dashboard.baseURL}/`);
    // Slow the leave motion, so the test sees the next row open before the
    // row that leaves is gone.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.05 });

    await open(page, buttons!);
    await row(page, buttons!).getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(row(page, form!)).toHaveAttribute("data-expanded", "true", {
      timeout: 1000,
    });
    await expect(row(page, buttons!)).toHaveCount(1);
    await expect(row(page, buttons!)).toHaveCount(0);

    await row(page, form!).getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(row(page, form!)).toHaveCount(0);

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Snoozed/ })
      .click();
    const snoozed = (ask: (typeof asks)[number]) =>
      page.locator(`li[data-inbox-row="${ask.id}"]`);
    await snoozed(buttons!)
      .locator('[aria-controls^="inbox-row-"]')
      .first()
      .click();
    await snoozed(buttons!).getByRole("button", { name: "Wake" }).click();
    await expect(snoozed(form!)).toHaveAttribute("data-expanded", "true", {
      timeout: 1000,
    });
    await expect(snoozed(buttons!)).toHaveCount(1);
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
    await expect(snoozed(buttons!)).toHaveCount(0);
  });

  test("a pin that fails to save shows a toast whose Retry pins it", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [...asks] });
    let fails = true;
    await page.route(
      `**/api/conversations/${encodeURIComponent(conversationId)}/pin`,
      (route) =>
        fails
          ? route.fulfill({ json: { error: "Failed" }, status: 500 })
          : route.fallback(),
    );
    await page.goto(`${dashboard.baseURL}/`);
    await open(page, buttons!);
    const pin = row(page, buttons!).getByRole("button", {
      exact: true,
      name: "Pin",
    });
    await pin.click();
    const toast = page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Could not pin" });
    await expect(toast).toBeVisible();
    await expect(pin).toHaveAttribute("aria-pressed", "false");

    fails = false;
    await toast.getByRole("button", { name: "Retry" }).click();
    await expect(
      row(page, buttons!).getByRole("button", { exact: true, name: "Unpin" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("Dismissing FYIs closes them at once, and Retry dismisses the ones that failed", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [license, digest] });
    let fails = true;
    const sent: string[] = [];
    await page.route(
      `**/api/review-items/${digest.id}/actions`,
      async (route) => {
        sent.push(digest.id);
        await (fails
          ? route.fulfill({ json: { error: "Failed" }, status: 500 })
          : route.fallback());
      },
    );
    await page.goto(`${dashboard.baseURL}/`);
    const digestFyi = page
      .getByRole("region", { name: "FYI" })
      .locator("[data-inbox-row]")
      .filter({ hasText: digest.title });
    await expect(digestFyi).toBeVisible();
    await page.getByRole("button", { name: /^Dismiss \d+ in FYI$/ }).click();
    await expect(digestFyi).toHaveCount(0);
    const toast = page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Could not dismiss 1 FYI" });
    // The sweep goes out when its Undo toast closes.
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(digestFyi).toBeVisible();
    expect(sent).toHaveLength(1);

    fails = false;
    await toast.getByRole("button", { name: "Retry" }).click();
    await expect(digestFyi).toHaveCount(0);
    await expect.poll(() => sent.length).toBe(2);
    await expect(toast).toHaveCount(0);
    await expect(digestFyi).toHaveCount(0);
  });

  test("a folded notice's Dismiss applies at once, and comes back with Retry when it fails", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [pinReview, pinChecks] });
    let answer = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    let fails = true;
    const sent: string[] = [];
    await page.route(
      `**/api/review-items/${pinChecks.id}/actions`,
      async (route) => {
        sent.push(pinChecks.id);
        if (!fails) return route.fallback();
        await answered;
        await route.fulfill({ json: { error: "Failed" }, status: 500 });
      },
    );
    await page.goto(`${dashboard.baseURL}/?item=${pinChecks.id}`);
    const asks = page.getByRole("region", { name: /: asks$/ });
    const checks = asks.getByRole("region", { name: pinChecks.title });
    await checks.getByRole("button", { name: "Checks failed" }).click();
    await checks.getByRole("button", { name: "Dismiss" }).click();
    await expect.poll(() => sent).toEqual([pinChecks.id]);
    await expect(checks).toHaveCount(0);

    answer();
    const toast = page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Could not dismiss" });
    await expect(toast).toBeVisible();
    await expect(asks.locator("[data-folded-notice]")).toHaveText(
      "Checks failed",
    );

    fails = false;
    await toast.getByRole("button", { name: "Retry" }).click();
    await expect(asks.locator("[data-folded-notice]")).toHaveCount(0);
    await expect.poll(() => sent).toHaveLength(2);
    await expect(asks.locator("[data-folded-notice]")).toHaveCount(0);
    // The ask it folded into still waits, so its row stays open.
    await expect(
      asks.getByRole("region", { name: pinReview.title }),
    ).toBeVisible();
  });
});
