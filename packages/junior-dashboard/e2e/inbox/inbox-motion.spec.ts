import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../test";
import { expandRow } from "./inbox-fixture";

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

  test("the magnifier grows rows in both densities, and its setting turns it off", async ({
    dashboard,
    page,
  }) => {
    await page.clock.install();
    const scale = async (row: Locator) => {
      await expect.poll(() => transform(row)).toMatch(/^scale\(/);
      return Number(/^scale\(([\d.]+)/.exec(await transform(row))![1]);
    };
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

    await page.goto(`${dashboard.baseURL}/settings`);
    await page
      .getByRole("checkbox", { name: "Magnify the row under the pointer" })
      .uncheck();
    for (const density of ["comfortable", "compact"]) {
      await page.evaluate(
        (value) => localStorage.setItem("junior:density", value),
        density,
      );
      await page.goto(`${dashboard.baseURL}/`);
      const row = await restOnFirstRow(page);
      await page.clock.runFor(PAST_REST_MS);
      expect(await transform(row)).toBe("");
    }
  });

  test("rows never grow under reduced motion", async ({ dashboard, page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
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
    test(`Dismiss opens the next row (${motion} motion)`, async ({
      dashboard,
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: motion });
      await page.goto(`${dashboard.baseURL}/`);
      const rows = todoRows(page);
      const first = rows.first();
      const nextKey = await rows.nth(1).getAttribute("data-inbox-row");
      await expandRow(first.locator("a[data-inbox-head]").first());
      // The row bar's Dismiss is the last one in the open row.
      await first
        .getByRole("button", { exact: true, name: "Dismiss" })
        .last()
        .click();
      await expect(
        page.locator(`li[data-inbox-row="${nextKey}"]`),
      ).toHaveAttribute("data-expanded", "true");
    });
  }
});
