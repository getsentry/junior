import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  // Longer than the pointer's rest, so a row that would expand has. The tests
  // drive the page clock, so the rest passes at once.
  const PAST_REST_MS = 200;

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
    await row.locator('a[aria-controls^="inbox-row-"]').first().hover();
    await page.clock.runFor(PAST_REST_MS);
    return row;
  }

  const transform = (row: Locator) =>
    row.evaluate((element) => (element as HTMLElement).style.transform);

  test("Expand on hover is off when the viewer turns it off", async ({
    dashboard,
    page,
  }) => {
    await page.clock.install();
    await page.goto(`${dashboard.baseURL}/`);
    await page.getByRole("button", { name: /Open profile menu/ }).click();
    await page
      .getByRole("menuitemradio", { name: "Expand on hover: Off" })
      .click();
    await page.keyboard.press("Escape");
    await page.reload();
    const row = await restOnFirstRow(page);
    await expect(row).not.toHaveAttribute("data-grown");
  });

  test("a compact row expands in place, in the list's flow, when the pointer rests", async ({
    dashboard,
    page,
  }) => {
    await page.clock.install();
    await page.goto(`${dashboard.baseURL}/`);
    const row = await restOnFirstRow(page);
    // The row itself shows the comfortable layout; nothing floats over the
    // rows below it.
    await expect(row).toHaveAttribute("data-grown", "true");
    await expect(row.locator('[data-inbox-slot="summary"]')).toHaveCount(1);
    await expect(page.locator("[data-hover-card]")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(row).not.toHaveAttribute("data-grown");
  });

  test("one rest grows and expands a comfortable row together", async ({
    dashboard,
    page,
  }) => {
    await comfortable(page);
    await page.addInitScript(() =>
      localStorage.setItem("junior:hover-expand", "everywhere"),
    );
    await page.clock.install();
    await page.goto(`${dashboard.baseURL}/`);
    const row = await restOnFirstRow(page);
    await expect(row).toHaveAttribute("data-grown", "true");
    // The step that expands it has scaled it too: there is no second, later
    // step.
    expect(await transform(row)).toMatch(/^scale\(/);
  });

  test("Compact only leaves comfortable rows the same height", async ({
    dashboard,
    page,
  }) => {
    await comfortable(page);
    await page.clock.install();
    await page.goto(`${dashboard.baseURL}/`);
    const row = await restOnFirstRow(page);
    await expect(row).not.toHaveAttribute("data-grown");
    // The magnifier still grows it, with `transform` only.
    await expect.poll(() => transform(row)).toMatch(/^scale\(/);
  });

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

  test("rows never grow or expand under reduced motion", async ({
    dashboard,
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await comfortable(page);
    await page.addInitScript(() =>
      localStorage.setItem("junior:hover-expand", "everywhere"),
    );
    await page.clock.install();
    await page.goto(`${dashboard.baseURL}/`);
    const row = await restOnFirstRow(page);
    await expect(row).not.toHaveAttribute("data-grown");
    expect(await transform(row)).toBe("");
  });

  test("a row with Threads grows as one card, with its Threads inside", async ({
    dashboard,
    page,
  }) => {
    await comfortable(page);
    await page.addInitScript(() =>
      localStorage.setItem("junior:hover-expand", "everywhere"),
    );
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
    await expect(row).toHaveAttribute("data-grown", "true");
    await expect.poll(() => transform(row)).toMatch(/^scale\(/);
    // The Threads are the card's own children, so they scale and move with
    // it, and no other layer covers them.
    await expect(
      row.getByRole("link", { name: /Check pinned row order/ }),
    ).toBeVisible();
    await expect(page.locator("[data-hover-card]")).toHaveCount(0);
  });

  test("the grown row shows linked work as quiet cards", async ({
    dashboard,
    page,
  }) => {
    await page.clock.install();
    await page.goto(`${dashboard.baseURL}/`);
    const row = page
      .getByRole("region", { name: "To do" })
      .locator("li[data-inbox-row]")
      .filter({ hasText: "Package release and self-update" })
      .first();
    await row.locator('a[aria-controls^="inbox-row-"]').first().hover();
    await page.clock.runFor(PAST_REST_MS);
    await expect(row).toHaveAttribute("data-grown", "true");
    // The same cards as comfortable rows: no icon, and a line in each one's
    // status color. The two changes that its pills name show only there.
    const cards = row.locator(
      '[aria-label="Linked work"] [data-linked-work-card]',
    );
    await expect(cards).toHaveText([/Return 429 before parsing/]);
    await expect(cards.locator("svg")).toHaveCount(0);
    await expect(cards.locator("[data-status-tone]")).toHaveCount(1);
  });

  for (const where of ["list", "page"] as const) {
    test(`a click in empty ${where} space collapses the open row`, async ({
      dashboard,
      page,
    }) => {
      await page.goto(`${dashboard.baseURL}/`);
      const row = todoRows(page).first();
      await row.locator('a[aria-controls^="inbox-row-"]').first().click();
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
    await row.locator('a[aria-controls^="inbox-row-"]').first().click();
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
      await first.locator('a[aria-controls^="inbox-row-"]').first().click();
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
