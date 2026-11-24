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

test.describe("snooze times", () => {
  // NOW_MS is Friday 08:00 in New York, so every choice for today shows.
  test.use({ locale: "en-US", timezoneId: "America/New_York" });

  const checkout = "Investigate checkout latency";
  const todo = (page: Page) => page.getByRole("region", { name: "To do" });
  const menu = (page: Page) =>
    page.getByRole("dialog", { name: "Snooze until" });
  const custom = (page: Page) =>
    page.getByRole("dialog", { name: "Custom snooze" });

  // The open row's Snooze; the other row has its own quick one.
  const openMenu = (page: Page) =>
    todo(page)
      .locator("li[data-expanded]")
      .getByRole("button", { name: "Snooze" })
      .click();

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
    await page.goto(`${dashboard.baseURL}/inbox`);
    await polled;
    await expandRow(rowHead(todo(page), checkout));
    await openMenu(page);
  });

  test("the menu shows each choice with its time, and number keys pick them", async ({
    page,
  }) => {
    await expect(menu(page).getByRole("button")).toHaveText([
      /^15m\s*08:15$/,
      /^30m\s*08:30$/,
      /^1h\s*09:00$/,
      /^3h\s*11:00$/,
      /^This afternoon\s*14:00$/,
      /^This evening\s*18:00$/,
      /^Tomorrow morning\s*Sat 09:00$/,
      /^Next week\s*Mon 09:00$/,
      // No time, so no key: it lasts until the item closes.
      "Someday",
      // A dialog, so it stays last.
      "Custom…",
    ]);
    // A duration cell's name spells out its label and time.
    await expect(menu(page).getByRole("button").first()).toHaveAccessibleName(
      "15 minutes 08:15",
    );
    // Focus moves to the first choice, so the keys reach the menu.
    await expect(
      menu(page).getByRole("button", { name: /^15 minutes/ }),
    ).toBeFocused();
    await page.keyboard.press("9");
    // Custom… opens the dialog in place of the menu, at its condition.
    await expect(menu(page)).toHaveCount(0);
    await expect(
      custom(page).getByRole("button", {
        name: "Pick a pull request or issue",
      }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(custom(page)).toHaveCount(0);
    await expect(rowHead(todo(page), checkout)).toBeVisible();
  });

  test("a duration that wakes tomorrow shows only its time in the cell", async ({
    page,
  }) => {
    // Friday 23:00: 3 hours wakes on Saturday.
    await page.keyboard.press("Escape");
    await page.clock.fastForward("15:00:00");
    await openMenu(page);
    const threeHours = menu(page).getByRole("button", { name: /^3 hours/ });
    await expect(threeHours).toHaveText(/^3h\s*02:00$/);
    await expect(threeHours).toHaveAccessibleName("3 hours Sat 02:00");
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
