import { NOW_MS } from "../../src/mock-reporting/fixtures";
import {
  digest,
  expandRow,
  license,
  mockReviewItems,
  prReady,
  prReview,
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
    await expandRow(rowHead(page, checkout));
    await page.getByRole("button", { name: "Snooze" }).click();
    await expect(
      page.getByRole("dialog", { name: "Snooze until" }),
    ).toBeVisible();
    await screenshot(page, "inbox-snooze", { view: "desktop" });
    const created = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/api/inbox/snoozes"),
    );
    await page.getByRole("button", { name: "Tomorrow" }).click();
    // The server keeps the snooze: it wakes the row at its time, or when
    // the Conversation adds an item.
    expect((await created).postDataJSON()).toEqual({
      conversationId: rollout.addedByConversationId,
      wakeAt: expect.any(String),
    });
    const todo = page.getByRole("region", { name: "To do" });
    await expect(
      todo.getByRole("link", { name: new RegExp(checkout) }),
    ).toHaveCount(0);

    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: /^Snoozed/ }).click();
    await expect(page).toHaveURL(/\/\?view=snoozed$/);
    await expandRow(rowHead(page, checkout));
    await page.getByRole("button", { name: "Wake" }).click();
    await expect(page.getByText("Nothing snoozed")).toBeVisible();
  });

  test("a snooze that fails to save brings the row back", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [license, rollout] });
    await page.route("**/api/inbox/snoozes", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ json: { error: "Failed" }, status: 500 })
        : route.fallback(),
    );
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    await expandRow(rowHead(todo, checkout));
    await page.getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(page.getByText("The row could not be snoozed")).toBeVisible();
    await expect(rowHead(todo, checkout)).toBeVisible();
  });

  test("a link to an item opens no row while Snoozed cannot load", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, {
      open: [license, rollout],
      snoozes: [
        {
          conversationId: rollout.addedByConversationId,
          untilMs: NOW_MS + 86_400_000,
        },
      ],
    });
    // Only Snoozed can tell whether a snooze hides the item.
    await page.route("**/api/review-items?**snoozed=true**", (route) =>
      route.fulfill({ json: { error: "Failed" }, status: 500 }),
    );
    await page.goto(`${dashboard.baseURL}/?item=${rollout.id}`);
    const todo = page.getByRole("region", { name: "To do" });
    await expect(todo.locator("[data-inbox-row]").first()).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]item=/);
    await expect(rowHead(todo, checkout)).toHaveCount(0);
  });

  test("a pull request row leaves the list as soon as it is snoozed", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [license, prReview] });
    // A pull request row opens from its item link.
    await page.goto(`${dashboard.baseURL}/?view=prs&item=${prReview.id}`);
    const row = page
      .locator("[data-inbox-row]")
      .filter({ hasText: "Review requested · #91" });
    await expect(page.getByRole("button", { name: "Snooze" })).toBeVisible();
    // Hold the reads that follow the snooze, so only the page hides the row.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/review-items?**", async (route) => {
      await held;
      await route.fallback();
    });
    await page.getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(row).toHaveCount(0);
    release();
    await expect(row).toHaveCount(0);
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
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    await expect(todo.locator("[data-inbox-row]").first()).toBeVisible();
    await expect(rowHead(todo, checkout)).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: /^Snoozed/ })).toHaveText(
      /^Snoozed\s*1$/,
    );

    await nav.getByRole("link", { name: /^Snoozed/ }).click();
    await expandRow(rowHead(page, checkout));
    const woken = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        new URL(request.url()).pathname.endsWith("/api/inbox/snoozes"),
    );
    await page.getByRole("button", { name: "Wake" }).click();
    expect((await woken).postDataJSON()).toEqual({
      conversationId: rollout.addedByConversationId,
    });
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

  test("a failed Snoozed page keeps the rows already read, and retries", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, {
      open: [rollout, digest, prReady],
      pageSize: 1,
      snoozes: [rollout, digest].map((item) => ({
        conversationId: item.addedByConversationId,
        untilMs: NOW_MS + 86_400_000,
      })),
    });
    // Snoozed's second page fails until the retry.
    let failing = true;
    await page.route(
      (url) =>
        url.pathname === "/api/review-items" &&
        url.searchParams.get("snoozed") === "true" &&
        url.searchParams.has("cursor"),
      (route) =>
        failing
          ? route.fulfill({ status: 500, json: { error: "boom" } })
          : route.fallback(),
    );
    await page.goto(`${dashboard.baseURL}/?view=snoozed`);
    await expect(rowHead(page, checkout)).toBeVisible();
    await expect(
      page.getByText("Could not load your snoozed rows."),
    ).toBeVisible();
    failing = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(rowHead(page, "Daily operations digest")).toBeVisible();
    await expect(
      page.getByText("Could not load your snoozed rows."),
    ).toHaveCount(0);
  });

  test("a link to a snoozed item waits for Snoozed, which loads last", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, {
      open: [license, rollout],
      snoozes: [
        {
          conversationId: rollout.addedByConversationId,
          untilMs: NOW_MS + 86_400_000,
        },
      ],
    });
    // Snoozed rows arrive after the Inbox is ready.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/review-items?**snoozed=true**", async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto(`${dashboard.baseURL}/?item=${rollout.id}`);
    const todo = page.getByRole("region", { name: "To do" });
    await expect(todo.locator("[data-inbox-row]").first()).toBeVisible();
    // The link holds until Snoozed says whether a snooze hides the item.
    await expect(page).toHaveURL(new RegExp(`[?&]item=${rollout.id}`));
    await expect(rowHead(todo, checkout)).toHaveCount(0);
    await expect(page.getByText("Nothing snoozed")).toHaveCount(0);
    release();
    await expect(page).toHaveURL(/[?&]view=snoozed(?:&|$)/);
    await expect(rowHead(page, checkout)).toBeVisible();
  });

  test("a snoozed row wakes at its time without a reload", async ({
    dashboard,
    page,
  }) => {
    await page.clock.install({ time: NOW_MS });
    // The server checks the wake time against the page's clock.
    await mockReviewItems(page, {
      now: () => page.evaluate(() => Date.now()),
      open: [license, rollout],
    });
    // The first versions poll is the baseline that a wake moves from.
    const polled = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/api/versions"),
    );
    await page.goto(`${dashboard.baseURL}/`);
    await polled;
    const todo = page.getByRole("region", { name: "To do" });
    await expandRow(rowHead(todo, checkout));
    await page.getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "3 hours" }).click();
    await expect(rowHead(todo, checkout)).toHaveCount(0);
    await expect(
      page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { name: /^Snoozed/ }),
    ).toHaveText(/^Snoozed\s*1$/);
    // The versions poll sees the wake. Step the clock until it runs.
    await page.clock.fastForward("03:00:01");
    await expect
      .poll(async () => {
        await page.clock.fastForward(5_000);
        return rowHead(todo, checkout).count();
      })
      .toBe(1);
  });
});
