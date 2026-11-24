import type { Page } from "@playwright/test";
import {
  expandRow,
  license,
  conversationId,
  mockInboxItems,
  rollout,
  rowHead,
} from "./inbox-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";

// The Inbox row titled `title`.
const rowOf = (page: Page, title: string) =>
  page.locator("[data-inbox-row]").filter({ hasText: title });

// The next time the page forgets why items woke.
const wakesCleared = (page: Page) =>
  page.waitForRequest(
    (request) =>
      request.method() === "DELETE" &&
      new URL(request.url()).pathname.endsWith("/api/inbox/snoozes/wakes"),
  );

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const merged = {
    ...license,
    wake: {
      eventType: "pull_request.merged",
      kind: "event",
      phrase: "is merged",
      resource: "getsentry/junior#3842",
    },
  };
  const timed = { ...rollout, wake: { kind: "time" } };

  test("a woken row says why it woke until the viewer opens it", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [merged, timed] });
    // A phone shows the list on its own page.
    await page.goto(`${dashboard.baseURL}/inbox?view=inbox`);
    const mergedReason = "Woke: getsentry/junior#3842 is merged";
    await expect(rowOf(page, merged.title)).toContainText(mergedReason);
    await expect(rowOf(page, timed.title)).toContainText(
      "Woke: snooze time reached",
    );
    await screenshot(page, "inbox-wake-reason", { lightTheme: true });

    // Opening the row tells the server, and the open row still says why.
    const cleared = wakesCleared(page);
    await expandRow(rowHead(page, merged.title));
    expect((await cleared).postDataJSON()).toEqual({
      inboxItemIds: [merged.id],
    });
    await expect(rowOf(page, merged.title)).toContainText(mergedReason);

    // Once it closes, only the row that the viewer did not open says why.
    await rowHead(page, merged.title).click();
    await expect(rowOf(page, merged.title)).not.toContainText("Woke:");
    await expect(rowOf(page, timed.title)).toContainText(
      "Woke: snooze time reached",
    );

    // Opening the other row's owner in a new tab also counts as opening it.
    const timedCleared = wakesCleared(page);
    const tab = page.context().waitForEvent("page");
    await rowHead(page, timed.title).click({ modifiers: ["ControlOrMeta"] });
    expect((await timedCleared).postDataJSON()).toEqual({
      inboxItemIds: [timed.id],
    });
    await (await tab).close();
    await expect(rowOf(page, timed.title)).not.toContainText("Woke:");
  });

  test("an open Conversation row's card says why its item woke", async ({
    dashboard,
    page,
  }) => {
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    const row = rowOf(page, "Sandbox validation").first();
    const reason = "Woke: getsentry/junior#3037 is merged";
    // A closed row says why one of its items woke.
    await expect(row).toContainText(reason);

    const cleared = wakesCleared(page);
    await expandRow(rowHead(page, "Sandbox validation"));
    expect((await cleared).postDataJSON()).toEqual({
      inboxItemIds: ["qa-review-3052"],
    });
    // The open row moves the reason to the card of the item that woke.
    await expect(
      row.locator('[data-inbox-card="qa-review-3052"]'),
    ).toContainText(reason);
    await expect(
      row.locator('[data-inbox-card="qa-merged-3037"]'),
    ).not.toContainText("Woke:");
    await screenshot(page, "inbox-wake-reason-card", { lightTheme: true });
  });

  test("opening a stack's root forgets why its items woke", async ({
    dashboard,
    page,
  }) => {
    const sibling = {
      ...rollout,
      createdAt: "2026-08-07T11:50:00.000Z",
      id: "item-rollout-check",
      title: "Check the payments-v42 canary",
    };
    await mockInboxItems(page, { open: [timed, sibling] });
    await page.goto(`${dashboard.baseURL}/inbox`);
    const stack = page.locator(
      `li[data-inbox-stack][data-dock-key$=":${conversationId}"]`,
    );
    await expect(stack).toContainText("Woke: snooze time reached");

    // A middle click opens the root in a new tab, so the stack stays in
    // view.
    const cleared = wakesCleared(page);
    const tab = page.context().waitForEvent("page");
    await stack
      .locator("[data-inbox-stack-head]")
      .getByRole("link")
      .first()
      .click({ button: "middle" });
    expect((await cleared).postDataJSON()).toEqual({
      inboxItemIds: [timed.id],
    });
    await (await tab).close();
    await expect(stack).not.toContainText("Woke:");
  });
});
