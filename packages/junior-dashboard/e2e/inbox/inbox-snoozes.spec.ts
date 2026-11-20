import type { Page } from "@playwright/test";
import { NOW_MS } from "../../src/mock-reporting/fixtures";
import {
  automationAlert,
  digest,
  expandRow,
  license,
  mockReviewItems,
  pinChecks,
  pinReview,
  prReady,
  prReview,
  pullRequestResource,
  releaseNotes,
  rollout,
  rowHead,
} from "./inbox-fixture";
import { automationReport } from "./automation-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";

// The open row. Every row has its own quick Snooze, so scope to this one.
const openRowOf = (page: Page) =>
  page.locator("li[data-inbox-row][data-expanded]");

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const checkout = "Investigate checkout latency";

  test("snooze hides a row until it wakes", async ({ dashboard, page }) => {
    await mockReviewItems(page, { open: [license, rollout] });
    await page.goto(`${dashboard.baseURL}/`);
    await expandRow(rowHead(page, checkout));
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    await expect(
      page.getByRole("dialog", { name: "Snooze until" }),
    ).toBeVisible();
    await screenshot(page, "inbox-snooze", { view: "desktop" });
    // The ask names no resource, so no Event can end its snooze.
    await expect(page.getByRole("button", { name: "Event…" })).toHaveCount(0);
    const created = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/api/inbox/snoozes"),
    );
    await page.getByRole("button", { name: "Tomorrow" }).click();
    // A lone card snoozes its own item. The server keeps the snooze and
    // wakes the item at its time.
    expect((await created).postDataJSON()).toEqual({
      conversationId: rollout.rootConversationId,
      reviewItemId: rollout.id,
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

  test("an Automation alert snoozes on the server like any item", async ({
    dashboard,
    page,
  }) => {
    const alert = automationAlert("event-1", "Closed issue summary");
    await mockReviewItems(page, { open: [alert, license] });
    const automation = {
      ...automationReport.automations.find(({ id }) => id === "event-1")!,
      status: "blocked" as const,
      statusReason: "GitHub access expired.",
    };
    await page.route("**/api/automations/event-1", (route) =>
      route.fulfill({ json: automation }),
    );
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    await expandRow(rowHead(todo, alert.title));
    // The card says what to fix, and acts on its Automation.
    await expect(openRowOf(page)).toContainText(alert.body);
    await expect(
      openRowOf(page).getByRole("button", { name: "Resume" }),
    ).toBeVisible();
    await expect(
      openRowOf(page).getByRole("link", { name: "Open automation" }),
    ).toHaveAttribute("href", "/automations/event-1");
    await expect(
      openRowOf(page).getByRole("link", { name: "Open editor" }),
    ).toHaveAttribute("href", "/automations/event-1/edit");
    await screenshot(page, "inbox-automation-alert", { lightTheme: true });
    const created = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/api/inbox/snoozes"),
    );
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    // The alert has no Conversation, so the snooze names the item only.
    expect((await created).postDataJSON()).toEqual({
      reviewItemId: alert.id,
      wakeAt: expect.any(String),
    });
    await expect(rowHead(todo, alert.title)).toHaveCount(0);
    // The server keeps the snooze. The browser stores no copy.
    await page.reload();
    await expect(rowHead(todo, license.title)).toBeVisible();
    await expect(rowHead(todo, alert.title)).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.includes("automation")),
      ),
    ).toEqual([]);

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: /^Snoozed/ })).toContainText(
      "1",
    );
    await nav.getByRole("link", { name: /^Snoozed/ }).click();
    await expect(rowHead(page, alert.title)).toBeVisible();
    await screenshot(page, "inbox-automation-alert-snoozed", {
      lightTheme: true,
    });
    await expandRow(rowHead(page, alert.title));
    const deleted = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        new URL(request.url()).pathname.endsWith("/api/inbox/snoozes"),
    );
    await page.getByRole("button", { name: "Wake" }).click();
    expect((await deleted).postDataJSON()).toEqual({ reviewItemId: alert.id });
    await expect(page.getByText("Nothing snoozed")).toBeVisible();
  });

  test("a lone card snoozes only its item, not its Conversation", async ({
    dashboard,
    page,
  }) => {
    // An FYI notice in the ask's Conversation, on a row of its own.
    const notice = {
      ...releaseNotes,
      owner: { id: rollout.owner.id, kind: "conversation" },
      conversationIds: [rollout.owner.id],
      rootConversationId: rollout.rootConversationId,
    };
    await mockReviewItems(page, { open: [rollout, notice] });
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    const created = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/api/inbox/snoozes"),
    );
    // The closed row's quick Snooze.
    const row = rowHead(todo, checkout);
    await row.hover();
    await todo.getByRole("button", { exact: true, name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    expect((await created).postDataJSON()).toEqual({
      conversationId: rollout.rootConversationId,
      reviewItemId: rollout.id,
      wakeAt: expect.any(String),
    });
    await expect(todo).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "FYI" }).getByText(notice.title),
    ).not.toHaveCount(0);

    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: /^Snoozed/ }).click();
    await expandRow(rowHead(page, checkout));
    const deleted = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        new URL(request.url()).pathname.endsWith("/api/inbox/snoozes"),
    );
    await page.getByRole("button", { name: "Wake" }).click();
    expect((await deleted).postDataJSON()).toEqual({
      conversationId: rollout.rootConversationId,
      reviewItemId: rollout.id,
    });
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
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(page.getByText("The row could not be snoozed")).toBeVisible();
    await expect(rowHead(todo, checkout)).toBeVisible();
  });

  test("a wake that fails keeps the row in Snoozed and says so", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, {
      open: [license, rollout],
      snoozes: [
        {
          conversationId: rollout.owner.id,
          untilMs: NOW_MS + 86_400_000,
        },
      ],
    });
    await page.route("**/api/inbox/snoozes", (route) =>
      route.request().method() === "DELETE"
        ? route.fulfill({ json: { error: "Failed" }, status: 500 })
        : route.fallback(),
    );
    await page.goto(`${dashboard.baseURL}/?view=snoozed`);
    await expandRow(rowHead(page, checkout));
    await page.getByRole("button", { name: "Wake" }).click();
    await expect(page.getByText("The row could not be woken")).toBeVisible();
    await expect(rowHead(page, checkout)).toBeVisible();
  });

  test("an item that links a snoozed Conversation leaves with its row", async ({
    dashboard,
    page,
  }) => {
    // Another Conversation added this ask, and it links the release one.
    const linked = {
      ...license,
      owner: { id: "slack:CLINK:1770030000.000100", kind: "conversation" },
      conversationIds: ["slack:CLINK:1770030000.000100", pinReview.owner.id],
      id: "item-linked-release",
      title: "Approve the release window",
    };
    // A second ask makes the release Conversation a stack, with its own Snooze.
    const checklist = {
      ...pinReview,
      createdAt: "2026-08-07T09:50:00.000Z",
      id: "item-release-checklist",
      title: "Approve the release checklist",
    };
    await mockReviewItems(page, {
      open: [license, pinReview, checklist, linked],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    const linkedRow = todo
      .locator("[data-inbox-row]")
      .filter({ hasText: "Approve the release window" });
    await expect(linkedRow).toHaveCount(1);
    // Hold the reads that follow the snooze, so only the page hides the rows.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/review-items?**", async (route) => {
      await held;
      await route.fallback();
    });
    await todo
      .locator(
        `li[data-inbox-stack][data-dock-key$=":${pinReview.rootConversationId}"]`,
      )
      .getByRole("button", { name: /^Snooze \d+ items in this stack$/ })
      .click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(linkedRow).toHaveCount(0);
    release();
    await expect(linkedRow).toHaveCount(0);
  });

  test("a link to a notice folded into a snoozed ask opens the ask's row", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, {
      open: [pinReview, pinChecks],
      snoozes: [
        {
          conversationId: pinReview.owner.id,
          untilMs: NOW_MS + 86_400_000,
        },
      ],
    });
    await page.goto(`${dashboard.baseURL}/?item=${pinChecks.id}`);
    await expect(page).toHaveURL(/\/\?view=snoozed$/);
    // The link opens the row, so its Wake shows.
    await expect(page.getByRole("button", { name: "Wake" })).toBeVisible();
  });

  test("a link to an item opens no row while Snoozed cannot load", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, {
      open: [license, rollout],
      snoozes: [
        {
          conversationId: rollout.owner.id,
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
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(row).toHaveCount(0);
    release();
    await expect(row).toHaveCount(0);
  });

  test("a pull request row snoozes until an Event on its pull request", async ({
    dashboard,
    page,
  }) => {
    await mockReviewItems(page, { open: [license, prReview] });
    await page.goto(`${dashboard.baseURL}/?view=prs&item=${prReview.id}`);
    const row = page
      .locator("[data-inbox-row]")
      .filter({ hasText: "Review requested · #91" });
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    const menu = page.getByRole("dialog", { name: "Snooze until" });
    await screenshot(page, "inbox-snooze-event-menu", {
      lightTheme: true,
      view: "desktop",
    });
    await menu.getByRole("button", { name: "Event…" }).click();
    // Each Event of the pull request, named without "pull request".
    const wakeWhen = menu.getByRole("group", { name: "Wake when" });
    await expect(wakeWhen.getByRole("button")).toHaveCount(
      pullRequestResource.events.length,
    );
    await expect(
      wakeWhen.getByRole("button", { name: "Review approved" }),
    ).toBeVisible();
    await screenshot(page, "inbox-snooze-event", {
      lightTheme: true,
      view: "desktop",
    });
    // The viewer can dismiss the ask, so the Event can dismiss it.
    await menu.getByRole("button", { name: "Dismiss" }).click();
    const created = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/api/inbox/snoozes"),
    );
    await menu
      .getByRole("group", { name: "Dismiss when" })
      .getByRole("button", { exact: true, name: "Merged" })
      .click();
    expect((await created).postDataJSON()).toEqual({
      conversationId: prReview.rootConversationId,
      reviewItemId: prReview.id,
      triggers: [{ eventType: "pull_request.merged", outcome: "resolve" }],
    });
    await expect(row).toHaveCount(0);
  });

  test("an Event wakes an ask that the viewer cannot dismiss", async ({
    dashboard,
    page,
  }) => {
    const ask = { ...prReview, canAct: false };
    await mockReviewItems(page, { open: [license, ask] });
    await page.goto(`${dashboard.baseURL}/?view=prs&item=${ask.id}`);
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    const menu = page.getByRole("dialog", { name: "Snooze until" });
    await menu.getByRole("button", { name: "Event…" }).click();
    await expect(menu.getByRole("group", { name: "On the event" })).toHaveCount(
      0,
    );
    const created = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/api/inbox/snoozes"),
    );
    await menu.getByRole("button", { name: "Checks passed" }).click();
    expect((await created).postDataJSON()).toEqual({
      conversationId: ask.rootConversationId,
      reviewItemId: ask.id,
      triggers: [{ eventType: "pull_request.checks.passed", outcome: "wake" }],
    });
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
          conversationId: rollout.owner.id,
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
    // Wake is per item, even when the snooze came from the whole row.
    expect((await woken).postDataJSON()).toEqual({
      conversationId: rollout.owner.id,
      reviewItemId: rollout.id,
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
        conversationId: item.owner.id,
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
        conversationId: item.owner.id,
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
          conversationId: rollout.owner.id,
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
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
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
