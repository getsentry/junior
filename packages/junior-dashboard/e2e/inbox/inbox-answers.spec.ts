import { desktop, mobile } from "../screenshot";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  test("an answer shows where it was given, then on the row", async ({
    dashboard,
    page,
  }) => {
    // The mock's own items: its rollout question closes with its answer.
    const ask = "I need your go-ahead before I roll out to every region.";
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let answering = false;
    // Hold the list reads after the answer, so the open card stays.
    await page.route(/\/api\/review-items\?/, async (route) => {
      if (answering) await held;
      await route.fallback();
    });
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    await todo
      .locator("[data-inbox-row]")
      .filter({ hasText: "Roll out payments-v42" })
      .getByRole("button", { name: "Question" })
      .click();
    const card = todo.getByRole("region", {
      name: "Approve the payments-v42 rollout",
    });
    answering = true;
    await card.getByRole("button", { name: "Hold" }).click();
    await expect(card.getByRole("status")).toHaveText("You answered Hold");
    // It stays when the card mounts again: a phone shows the menu here.
    await page.setViewportSize(mobile);
    await expect(card).toHaveCount(0);
    await page.setViewportSize(desktop);
    await expect(card.getByRole("status")).toHaveText("You answered Hold");

    // The row says the answer in place of the ask, after a reload too.
    release();
    const summary = page
      .locator("[data-inbox-row]")
      .filter({ hasText: "Roll out payments-v42" })
      .locator('[data-inbox-slot="summary"]');
    await expect(summary).toHaveText("You answered Hold");
    await expect(page.getByText(ask)).toHaveCount(0);
    answering = false;
    await page.reload();
    await expect(summary).toHaveText("You answered Hold");
  });
});
