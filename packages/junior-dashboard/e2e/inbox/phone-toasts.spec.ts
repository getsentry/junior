import { NOW_MS } from "../../src/mock-reporting/fixtures";
import { digest, license, mockInboxItems, prReady } from "./inbox-fixture";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("phone toasts", { tag: "@new" }, () => {
  const checkout = "Investigate checkout latency";

  test("on a phone, a sweep's Undo works over a Conversation's composer", async ({
    dashboard,
    page,
  }) => {
    await page.clock.setFixedTime(NOW_MS);
    const actions = await mockInboxItems(page, {
      open: [license, prReady, digest],
    });
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox/ })
      .click();
    const clearFyi = page.getByRole("button", {
      name: /^Dismiss \d+ in FYI$/,
    });
    await clearFyi.click();
    const undo = page
      .getByRole("region", { name: "Notifications" })
      .getByRole("dialog", { name: /^Dismissed \d+ FYIs?$/ })
      .getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();

    // The toast sits at the top: the composer box and Send still take a tap.
    await page.goBack();
    await page
      .getByRole("list", { name: "In flight" })
      .getByRole("link", { name: new RegExp(checkout) })
      .click();
    await expect(page).toHaveURL(/\/conversations\//);
    await page
      .getByRole("textbox", { name: "Continue this conversation" })
      .fill("Status?");
    await page.getByRole("button", { name: "Send" }).click({ trial: true });
    await undo.click();
    await expect(undo).toHaveCount(0);
    await page.goBack();
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox/ })
      .click();
    await expect(clearFyi).toBeVisible();
    expect(actions).toEqual([]);
  });

  test("on a phone, a toast swipes up to dismiss", async ({
    dashboard,
    page,
  }) => {
    // A paused clock keeps the toast from timing out during the swipe.
    await page.clock.install();
    await mockInboxItems(page, { open: [license, digest] });
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto(`${dashboard.baseURL}/inbox?view=inbox`);
    await page.getByRole("button", { name: /^Dismiss \d+ in FYI$/ }).click();
    const toast = page
      .getByRole("region", { name: "Notifications" })
      .getByRole("dialog", { name: /^Dismissed \d+ FYIs?$/ });
    await expect(toast).toBeVisible();
    await page.clock.pauseAt(Date.now() + 500);

    const pointer = { button: 0, isPrimary: true, pointerId: 1 };
    await toast.dispatchEvent("pointerdown", {
      ...pointer,
      clientX: 200,
      clientY: 60,
    });
    for (const clientY of [50, 20, -10, -40]) {
      await toast.dispatchEvent("pointermove", {
        ...pointer,
        clientX: 200,
        clientY,
        movementY: -30,
      });
    }
    await toast.dispatchEvent("pointerup", {
      ...pointer,
      clientX: 200,
      clientY: -40,
    });
    await page.clock.runFor(1_000);
    await expect(toast).toHaveCount(0);
  });
});
