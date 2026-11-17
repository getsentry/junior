import { NOW_MS } from "../../src/mock-reporting/fixtures";
import {
  digest,
  license,
  mockReviewItems,
  prReady,
  rollout,
  rowHead,
} from "./inbox-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const checkout = "Investigate checkout latency";

  test("snooze hides a row until it wakes", async ({ dashboard, page }) => {
    await mockReviewItems(page, { open: [license, rollout] });
    await page.goto(`${dashboard.baseURL}/`);
    await rowHead(page, checkout).click();
    await page.getByRole("button", { name: "Snooze" }).click();
    await expect(
      page.getByRole("dialog", { name: "Snooze until" }),
    ).toBeVisible();
    await screenshot(page, "inbox-snooze", { view: "desktop" });
    const created = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/api/automations"),
    );
    await page.getByRole("button", { name: "Tomorrow" }).click();
    // The snooze is a wake Automation on the server: it wakes the row at
    // its time, or when the Conversation adds an item.
    expect((await created).postDataJSON()).toMatchObject({
      action: "wake",
      subject: { conversationId: rollout.addedByConversationId },
      triggers: [
        { kind: "new_item" },
        {
          events: ["timer.fired"],
          kind: "event",
          namespace: "junior",
          resourceType: "timer",
        },
      ],
    });
    const todo = page.getByRole("region", { name: "To do" });
    await expect(
      todo.getByRole("link", { name: new RegExp(checkout) }),
    ).toHaveCount(0);

    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: /^Snoozed/ }).click();
    await expect(page).toHaveURL(/\/\?view=snoozed$/);
    await rowHead(page, checkout).click();
    await page.getByRole("button", { name: "Wake" }).click();
    await expect(page.getByText("Nothing snoozed")).toBeVisible();
  });

  test("a row snoozed in another browser loads asleep", async ({
    dashboard,
    page,
  }) => {
    // Nothing in this browser knows about the snooze: the server keeps it.
    await mockReviewItems(page, {
      open: [license, rollout],
      snoozes: [
        {
          conversationId: rollout.addedByConversationId,
          untilMs: NOW_MS + 86_400_000,
        },
      ],
    });
    // The first read of the snoozes fails. Wake reads them again.
    let snoozeReads = 0;
    await page.route("**/api/automations/snoozes", (route) =>
      snoozeReads++ === 0
        ? route.fulfill({ json: { error: "Failed" }, status: 500 })
        : route.fallback(),
    );
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    await expect(todo.locator("[data-inbox-row]").first()).toBeVisible();
    await expect(rowHead(todo, checkout)).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: /^Snoozed/ })).toHaveText(
      /^Snoozed\s*1$/,
    );

    await nav.getByRole("link", { name: /^Snoozed/ }).click();
    await rowHead(page, checkout).click();
    const woken = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        new URL(request.url()).pathname.endsWith("/api/automations/snooze-0"),
    );
    await page.getByRole("button", { name: "Wake" }).click();
    await woken;
    await expect(page.getByText("Nothing snoozed")).toBeVisible();
    await nav.getByRole("link", { name: /^Inbox/ }).click();
    await expect(rowHead(todo, checkout)).toBeVisible();
  });

  test("Snoozed reads every page, and a link to a snoozed item opens it there", async ({
    dashboard,
    page,
  }) => {
    // One item a page: the digest's row is on Snoozed's second page.
    await mockReviewItems(page, {
      open: [rollout, digest, prReady],
      pageSize: 1,
      snoozes: [rollout, digest].map((item) => ({
        conversationId: item.addedByConversationId,
        untilMs: NOW_MS + 86_400_000,
      })),
    });
    await page.goto(`${dashboard.baseURL}/?item=${digest.id}`);
    await expect(page).toHaveURL(/[?&]view=snoozed(?:&|$)/);
    await expect(rowHead(page, "Daily operations digest")).toBeVisible();
    await expect(rowHead(page, checkout)).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: /^Snoozed/ })).toHaveText(
      /^Snoozed\s*2$/,
    );
  });

  test("a snoozed row the server still hides after its time is checked again", async ({
    dashboard,
    page,
  }) => {
    await page.clock.install({ time: NOW_MS });
    // The server's clock is 20 seconds behind the page's.
    await mockReviewItems(page, {
      now: async () => (await page.evaluate(() => Date.now())) - 20_000,
      open: [license, rollout],
      snoozes: [
        {
          conversationId: rollout.addedByConversationId,
          untilMs: NOW_MS + 60_000,
        },
      ],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    await expect(todo.locator("[data-inbox-row]").first()).toBeVisible();
    await expect(rowHead(todo, checkout)).toHaveCount(0);
    // At its time the row still sleeps on the server.
    const checked = page.waitForResponse((response) =>
      response.url().endsWith("/api/automations/snoozes"),
    );
    await page.clock.fastForward("01:01");
    await checked;
    await expect(rowHead(todo, checkout)).toHaveCount(0);
    // A later check wakes it, with no reload. Step the clock until it runs.
    await expect
      .poll(async () => {
        await page.clock.fastForward(5_000);
        return rowHead(todo, checkout).count();
      })
      .toBe(1);
  });

  test("a snoozed row wakes at its time without a reload", async ({
    dashboard,
    page,
  }) => {
    await page.clock.install({ time: NOW_MS });
    // The server checks the snooze timer against the page's clock.
    await mockReviewItems(page, {
      now: () => page.evaluate(() => Date.now()),
      open: [license, rollout],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    await rowHead(todo, checkout).click();
    await page.getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "3 hours" }).click();
    await expect(rowHead(todo, checkout)).toHaveCount(0);
    await page.clock.fastForward("03:00:01");
    await expect(rowHead(todo, checkout)).toBeVisible();
  });
});
