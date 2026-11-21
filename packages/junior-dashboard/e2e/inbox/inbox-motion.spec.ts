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

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  // Longer than the focus intent, so the card under the pointer grows. The
  // tests drive the page clock, so it passes at once.
  const PAST_REST_MS = 350;

  async function comfortable(page: Page) {
    await page.addInitScript(() =>
      localStorage.setItem("junior:density", "comfortable"),
    );
  }

  // The magnifier is off until the viewer turns it on.
  async function magnify(page: Page) {
    await page.addInitScript(() =>
      localStorage.setItem("junior:inbox:magnify", "true"),
    );
  }

  function todoRows(page: Page): Locator {
    return page
      .getByRole("region", { name: "To do" })
      .locator(":scope > ul > li[data-inbox-row]");
  }

  // The first To do row, with the pointer resting on its head.
  async function restOnFirstRow(page: Page) {
    const row = todoRows(page).first();
    await row.locator("a[data-inbox-head]").first().hover();
    await page.clock.runFor(PAST_REST_MS);
    return row;
  }

  const transform = (row: Locator) =>
    row.evaluate((element) => (element as HTMLElement).style.transform);

  test("the magnifier is off until its setting turns it on, and grows rows in both densities", async ({
    dashboard,
    page,
  }) => {
    await page.clock.install();
    const scale = async (row: Locator) => {
      await expect.poll(() => transform(row)).toMatch(/^scale\(/);
      return Number(/^scale\(([\d.]+)/.exec(await transform(row))![1]);
    };
    for (const density of ["comfortable", "compact"]) {
      await page.goto(`${dashboard.baseURL}/`);
      await page.evaluate(
        (value) => localStorage.setItem("junior:density", value),
        density,
      );
      await page.reload();
      const row = await restOnFirstRow(page);
      await page.clock.runFor(PAST_REST_MS);
      expect(await transform(row)).toBe("");
    }

    await page.goto(`${dashboard.baseURL}/settings`);
    const setting = page.getByRole("checkbox", {
      name: "Magnify the row under the pointer",
    });
    await expect(setting).not.toBeChecked();
    await setting.check();
    // Compact rows grow too, less than comfortable ones.
    await page.goto(`${dashboard.baseURL}/`);
    const compact = await scale(await restOnFirstRow(page));
    expect(compact).toBeGreaterThan(1);
    expect(compact).toBeLessThanOrEqual(1.02);
    await page.evaluate(() =>
      localStorage.setItem("junior:density", "comfortable"),
    );
    await page.reload();
    expect(await scale(await restOnFirstRow(page))).toBeGreaterThan(compact);
  });

  test("rows never grow under reduced motion", async ({ dashboard, page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await magnify(page);
    await comfortable(page);
    await page.clock.install();
    await page.goto(`${dashboard.baseURL}/`);
    const row = await restOnFirstRow(page);
    expect(await transform(row)).toBe("");
  });

  test("a row with Threads grows as one card, with its Threads inside", async ({
    dashboard,
    page,
  }) => {
    await magnify(page);
    await comfortable(page);
    await page.clock.install();
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const head = page
      .getByRole("link", { name: /^Dashboard QA edge cases/ })
      .first();
    const row = page
      .locator("li[data-inbox-row]")
      .filter({ has: head })
      .first();
    // The rows above it finish loading their cards first, so the row stays
    // under the pointer.
    await head.scrollIntoViewIfNeeded();
    await page.waitForLoadState("networkidle");
    await head.hover();
    await page.clock.runFor(PAST_REST_MS);
    await expect.poll(() => transform(row)).toMatch(/^scale\(/);
    // The Threads are the card's own children, so they scale and move with
    // it, and no other layer covers them.
    await expect(
      row.getByRole("link", { name: /Check pinned row order/ }),
    ).toBeVisible();
    await expect(page.locator("[data-hover-card]")).toHaveCount(0);
  });

  for (const where of ["list", "page"] as const) {
    test(`a click in empty ${where} space collapses the open row`, async ({
      dashboard,
      page,
    }) => {
      await page.goto(`${dashboard.baseURL}/`);
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
    await page.goto(`${dashboard.baseURL}/`);
    const row = todoRows(page).first();
    await expandRow(row.locator("a[data-inbox-head]").first());
    await expect(row).toHaveAttribute("data-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(row).not.toHaveAttribute("data-expanded");
  });

  for (const motion of ["no-preference", "reduce"] as const) {
    test(`Dismiss of a row's last ask opens the next row (${motion} motion)`, async ({
      dashboard,
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: motion });
      await page.goto(`${dashboard.baseURL}/`);
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
  }

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

  for (const motion of ["no-preference", "reduce"] as const) {
    test(`an open row that closes elsewhere leaves as on Dismiss (${motion} motion)`, async ({
      dashboard,
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: motion });
      const asks = await closableAsks(page);
      await page.goto(`${dashboard.baseURL}/`);
      await expandRow(asks.row(0).locator("a[data-inbox-head]").first());
      await expect(asks.row(0)).toHaveAttribute("data-expanded", "true");

      await asks.closeAndRefocus(0);
      await expect(asks.row(1)).toHaveAttribute("data-expanded", "true");
      await expect(asks.row(0)).toHaveCount(0);
      // The item is already closed, so the Inbox sends nothing.
      expect(asks.actions).toEqual([]);
    });
  }

  test("a row that closes elsewhere while shut leaves without moving the open row", async ({
    dashboard,
    page,
  }) => {
    const asks = await closableAsks(page);
    await page.goto(`${dashboard.baseURL}/`);
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
    await page.emulateMedia({ reducedMotion: "reduce" });
    const asks = await closableAsks(page, { pageSize: 3 });
    await page.goto(`${dashboard.baseURL}/`);
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
