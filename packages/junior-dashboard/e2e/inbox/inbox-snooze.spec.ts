import type { Page } from "@playwright/test";

import { NOW_MS } from "../../src/mock-reporting/fixtures";
import {
  expandRow,
  license,
  mockInboxItems,
  rollout,
  rowHead,
} from "./inbox-fixture";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("snooze times", { tag: "@new" }, () => {
  // NOW_MS is Friday 08:00 in New York, so every choice for today shows.
  test.use({ locale: "en-US", timezoneId: "America/New_York" });

  const checkout = "Investigate checkout latency";
  const todo = (page: Page) => page.getByRole("region", { name: "To do" });
  const menu = (page: Page) =>
    page.getByRole("dialog", { name: "Snooze until" });
  const custom = (page: Page) =>
    page.getByRole("dialog", { name: "Custom snooze" });

  /** Step the clock until the versions poll sees the wake and the row is back. */
  const wakes = (page: Page) =>
    expect
      .poll(async () => {
        await page.clock.fastForward(5_000);
        return rowHead(todo(page), checkout).count();
      })
      .toBe(1);

  test.beforeEach(async ({ dashboard, page }) => {
    await page.clock.install({ time: NOW_MS });
    // The server checks the wake time against the page's clock.
    await mockInboxItems(page, {
      now: () => page.evaluate(() => Date.now()),
      open: [license, rollout],
    });
    // The first versions poll is the baseline that a wake moves from.
    const polled = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/api/versions"),
    );
    await page.goto(`${dashboard.baseURL}/`);
    await polled;
    await expandRow(rowHead(todo(page), checkout));
    // The open row's Snooze; the other row has its own quick one.
    await todo(page)
      .locator("li[data-expanded]")
      .getByRole("button", { name: "Snooze" })
      .click();
  });

  test("the menu shows each choice with its time, and number keys pick them", async ({
    page,
  }) => {
    await expect(menu(page).getByRole("button")).toHaveText([
      /^15 minutes\s*08:15$/,
      /^30 minutes\s*08:30$/,
      /^1 hour\s*09:00$/,
      /^3 hours\s*11:00$/,
      /^This afternoon\s*14:00$/,
      /^This evening\s*18:00$/,
      /^Tomorrow morning\s*Sat 09:00$/,
      /^Next week\s*Mon 09:00$/,
      "Custom…",
    ]);
    // Focus moves to the first choice, so the keys reach the menu.
    await expect(
      menu(page).getByRole("button", { name: /^15 minutes/ }),
    ).toBeFocused();
    await page.keyboard.press("9");
    // Custom… opens the dialog in place of the menu, at its time field.
    await expect(menu(page)).toHaveCount(0);
    await expect(custom(page).getByLabel("Wake at")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(custom(page)).toHaveCount(0);
    await expect(rowHead(todo(page), checkout)).toBeVisible();
  });

  test("1 hour snoozes the row for an hour", async ({ page }) => {
    await menu(page)
      .getByRole("button", { name: /^1 hour/ })
      .click();
    await expect(rowHead(todo(page), checkout)).toHaveCount(0);
    await page.clock.fastForward("01:00:01");
    await wakes(page);
  });

  test("Custom rejects a past time", async ({ page }) => {
    await menu(page).getByRole("button", { name: "Custom…" }).click();
    const at = custom(page).getByLabel("Wake at");
    await at.fill("2026-08-07T07:30");
    await at.press("Enter");
    await expect(custom(page).getByRole("alert")).toHaveText(
      "Pick a time in the future.",
    );
    await expect(at).toHaveAttribute("aria-invalid", "true");
    // Nothing saved: the dialog stays, and the row with it once it closes.
    await page.keyboard.press("Escape");
    await expect(rowHead(todo(page), checkout)).toBeVisible();
  });

  test("Custom snoozes the row until the picked time", async ({ page }) => {
    await menu(page).getByRole("button", { name: "Custom…" }).click();
    const at = custom(page).getByLabel("Wake at");
    await at.fill("2026-08-07T10:30");
    await at.press("Enter");
    await expect(rowHead(todo(page), checkout)).toHaveCount(0);
    await page.clock.fastForward("02:29:00");
    await expect(rowHead(todo(page), checkout)).toHaveCount(0);
    await page.clock.fastForward("00:01:01");
    await wakes(page);
  });
});
