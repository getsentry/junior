import type { Page } from "@playwright/test";

import { NOW_MS } from "../../src/mock-reporting/fixtures";
import {
  expandRow,
  license,
  mockReviewItems,
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

  test.beforeEach(async ({ dashboard, page }) => {
    await page.clock.install({ time: NOW_MS });
    await mockReviewItems(page, { open: [license, rollout] });
    await page.goto(`${dashboard.baseURL}/`);
    await expandRow(rowHead(todo(page), checkout));
    await page.getByRole("button", { name: "Snooze" }).click();
  });

  test("the menu shows each choice with its time, and number keys pick them", async ({
    page,
  }) => {
    await expect(menu(page).getByRole("button")).toHaveText([
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
      menu(page).getByRole("button", { name: /^1 hour/ }),
    ).toBeFocused();
    await page.keyboard.press("7");
    await expect(menu(page).getByLabel("Date and time")).toHaveValue(
      "2026-08-08T09:00",
    );
    await menu(page).getByRole("button", { name: "Back" }).click();
    await expect(
      menu(page).getByRole("button", { name: "Custom…" }),
    ).toBeFocused();
  });

  test("1 hour snoozes the row for an hour", async ({ page }) => {
    await menu(page)
      .getByRole("button", { name: /^1 hour/ })
      .click();
    await expect(rowHead(todo(page), checkout)).toHaveCount(0);
    await page.clock.fastForward("01:00:01");
    await expect(rowHead(todo(page), checkout)).toBeVisible();
  });

  test("Custom rejects a past time", async ({ page }) => {
    await menu(page).getByRole("button", { name: "Custom…" }).click();
    const at = menu(page).getByLabel("Date and time");
    await at.fill("2026-08-07T07:30");
    await at.press("Enter");
    await expect(menu(page).getByRole("alert")).toHaveText(
      "Pick a time in the future.",
    );
    await expect(at).toHaveAttribute("aria-invalid", "true");
    await expect(rowHead(todo(page), checkout)).toBeVisible();
  });

  test("Custom snoozes the row until the picked time", async ({ page }) => {
    await menu(page).getByRole("button", { name: "Custom…" }).click();
    const at = menu(page).getByLabel("Date and time");
    await at.fill("2026-08-07T10:30");
    await at.press("Enter");
    await expect(rowHead(todo(page), checkout)).toHaveCount(0);
    await page.clock.fastForward("02:29:00");
    await expect(rowHead(todo(page), checkout)).toHaveCount(0);
    await page.clock.fastForward("00:01:01");
    await expect(rowHead(todo(page), checkout)).toBeVisible();
  });
});
