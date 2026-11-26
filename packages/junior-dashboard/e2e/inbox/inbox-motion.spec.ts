import type { Locator, Page } from "@playwright/test";

import { NOW_MS } from "../../src/mock-reporting/fixtures";
import { expect, test } from "../test";
import {
  audit,
  expandRow,
  license,
  mockInboxItems,
  prReview,
} from "./inbox-fixture";

test.describe("new UI", () => {
  function todoRows(page: Page): Locator {
    return page
      .getByRole("region", { name: "To do" })
      .locator(":scope > ul > li[data-inbox-row]");
  }

  for (const where of ["list", "page"] as const) {
    test(`a click in empty ${where} space collapses the open row`, async ({
      dashboard,
      page,
    }) => {
      await page.goto(`${dashboard.baseURL}/inbox`);
      const row = todoRows(page).first();
      await expandRow(row.locator("a[data-inbox-head]").first());
      await expect(row).toHaveAttribute("data-expanded", "true");
      if (where === "list") {
        // The list's side inset, beside the cards.
        await page
          .locator("[data-inbox-scroll]")
          .click({ position: { x: 4, y: 300 } });
      } else {
        // The empty top-right of the page, above the list.
        await page.locator("body").click({ position: { x: 1270, y: 4 } });
      }
      await expect(row).not.toHaveAttribute("data-expanded");
    });
  }

  test("Esc collapses the open row", async ({ dashboard, page }) => {
    await page.goto(`${dashboard.baseURL}/inbox`);
    const row = todoRows(page).first();
    await expandRow(row.locator("a[data-inbox-head]").first());
    await expect(row).toHaveAttribute("data-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(row).not.toHaveAttribute("data-expanded");
  });

  test("Dismiss of a row's last ask opens the next row", async ({
    dashboard,
    page,
  }) => {
    await page.goto(`${dashboard.baseURL}/inbox`);
    // Each To do entry is a row, or a stack of rows. When the first
    // entry's last ask leaves, the next entry's first row opens.
    const entryRow = (index: number) =>
      page
        .getByRole("region", { name: "To do" })
        .locator(":scope > ul > li")
        .nth(index)
        .locator("xpath=descendant-or-self::li[@data-inbox-row][1]");
    const first = entryRow(0);
    const firstKey = await first.getAttribute("data-inbox-row");
    const nextKey = await entryRow(1).getAttribute("data-inbox-row");
    await expandRow(first.locator("[data-inbox-head]").first());
    const open = page.locator(
      `li[data-inbox-row="${firstKey}"][data-expanded]`,
    );
    const cards = open.locator("[data-inbox-card]");
    while ((await open.count()) > 0) {
      const left = await cards.count();
      await cards
        .first()
        .getByRole("button", { exact: true, name: "Dismiss" })
        .click();
      await expect
        .poll(
          async () =>
            (await open.count()) === 0 || (await cards.count()) < left,
        )
        .toBe(true);
    }
    await expect(
      page.locator(`li[data-inbox-row="${nextKey}"]`),
    ).toHaveAttribute("data-expanded", "true");
  });

  // Three asks in To do, each in its own Conversation, oldest first. The
  // test closes them on the server, as an agent or a Watch does, and the
  // viewer comes back to the tab after the reads went stale, so the Inbox
  // reads its asks again.
  async function closableAsks(page: Page, options: { pageSize?: number } = {}) {
    const asks = [
      { ...prReview, createdAt: "2026-08-07T08:00:00.000Z" },
      {
        ...license,
        owner: { id: "slack:CLICENSE:1770003600.000400", kind: "conversation" },
        rootConversationId: "slack:CLICENSE:1770003600.000400",
        createdAt: "2026-08-07T08:10:00.000Z",
      },
      {
        ...audit,
        owner: { id: "slack:CAUDIT:1770003600.000500", kind: "conversation" },
        rootConversationId: "slack:CAUDIT:1770003600.000500",
        createdAt: "2026-08-07T08:20:00.000Z",
      },
    ];
    const open = [...asks];
    const actions = await mockInboxItems(page, { ...options, open });
    let nowMs = NOW_MS;
    const refocus = async () => {
      nowMs += 60_000;
      await page.clock.setFixedTime(nowMs);
      const read = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/api/inbox-items",
      );
      await page.evaluate(() =>
        window.dispatchEvent(new Event("visibilitychange")),
      );
      await read;
    };
    return {
      actions,
      async addAndRefocus(item: (typeof asks)[number]) {
        open.push(item);
        await refocus();
      },
      async closeAndRefocus(index: number) {
        open.splice(open.indexOf(asks[index]!), 1);
        await refocus();
      },
      row: (index: number) =>
        page.locator(`li[data-inbox-row="todo:${asks[index]!.id}"]`),
    };
  }

  test("an open row that closes elsewhere leaves as on Dismiss", async ({
    dashboard,
    page,
  }) => {
    const asks = await closableAsks(page);
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expandRow(asks.row(0).locator("a[data-inbox-head]").first());
    await expect(asks.row(0)).toHaveAttribute("data-expanded", "true");

    await asks.closeAndRefocus(0);
    await expect(asks.row(1)).toHaveAttribute("data-expanded", "true");
    await expect(asks.row(0)).toHaveCount(0);
    // The item is already closed, so the Inbox sends nothing.
    expect(asks.actions).toEqual([]);
  });

  test("a row that closes elsewhere while shut leaves without moving the open row", async ({
    dashboard,
    page,
  }) => {
    const asks = await closableAsks(page);
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expandRow(asks.row(0).locator("a[data-inbox-head]").first());
    await expect(asks.row(0)).toHaveAttribute("data-expanded", "true");

    await asks.closeAndRefocus(1);
    await expect(asks.row(1)).toHaveCount(0);
    await expect(asks.row(0)).toHaveAttribute("data-expanded", "true");

    // The row that left is out of the order too: the open row's next is
    // the one after it.
    await asks.closeAndRefocus(0);
    await expect(asks.row(2)).toHaveAttribute("data-expanded", "true");
    expect(asks.actions).toEqual([]);
  });

  test("an open row that only leaves the loaded page stays open", async ({
    dashboard,
    page,
  }) => {
    // Reduced motion leaves a row with no animation, so a wrong leave has
    // already opened the next row by the next frames.
    const asks = await closableAsks(page, { pageSize: 3 });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expandRow(asks.row(0).locator("a[data-inbox-head]").first());
    await expect(asks.row(0)).toHaveAttribute("data-expanded", "true");
    const openRows = page.locator("li[data-inbox-row][data-expanded]");
    const stillOpen = async () => {
      await expect(asks.row(0)).toHaveAttribute("data-expanded", "true");
      await expect(openRows).toHaveCount(1);
    };

    // A newer ask fills the first page, so the open row's ask is on the
    // next one. Its own read says that it is still open.
    const reread = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/inbox-items/${prReview.id}`,
    );
    const newer = {
      ...license,
      owner: { id: "slack:CNEWER:1770003600.000600", kind: "conversation" },
      rootConversationId: "slack:CNEWER:1770003600.000600",
      createdAt: "2026-08-07T08:30:00.000Z",
      id: "item-newer",
    };
    await asks.addAndRefocus(newer);
    await expect(
      page.locator(`li[data-inbox-row="todo:${newer.id}"]`),
    ).toBeVisible();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await stillOpen();
    await reread;
    await stillOpen();
    expect(asks.actions).toEqual([]);
  });
});
