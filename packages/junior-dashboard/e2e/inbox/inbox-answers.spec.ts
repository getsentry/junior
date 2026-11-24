import type { Page } from "@playwright/test";

import { expect, test } from "../test";

const title = "Roll out payments-v42";

function rollout(page: Page) {
  return page.locator("[data-inbox-row]").filter({ hasText: title });
}

async function answerHold(page: Page) {
  const todo = page.getByRole("region", { name: "To do" });
  await rollout(page).locator('[aria-controls^="inbox-row-"]').first().click();
  const card = todo.getByRole("region", {
    name: "Approve the payments-v42 rollout",
  });
  // A click picks the choice, and Send answers.
  await card.getByRole("button", { exact: true, name: "Hold" }).click();
  await card.getByRole("button", { exact: true, name: "Send" }).click();
}

function toasts(page: Page) {
  return page
    .getByRole("region", { name: "Notifications" })
    .getByRole("dialog");
}

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  for (const view of [
    { height: 900, name: "desktop", width: 1440 },
    { height: 844, name: "phone", width: 390 },
  ]) {
    test(`an answer shows no toast, then shows on its row (${view.name})`, async ({
      dashboard,
      page,
    }) => {
      // The mock's own items: its rollout question closes with its answer.
      const ask = "I need your go-ahead before I roll out to every region.";
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      // Hold the answer, so the row leaves before the server answers.
      await page.route(/\/api\/inbox-items\/[^/]+\/actions$/, async (route) => {
        await held;
        await route.fallback();
      });
      await page.setViewportSize(view);
      await page.goto(`${dashboard.baseURL}/inbox?view=inbox`);
      await answerHold(page);
      // The row leaving is the confirmation. Count at once: a toast that
      // showed with the answer would still show now.
      await expect(rollout(page)).toHaveCount(0);
      expect(await toasts(page).count()).toBe(0);

      // Its Conversation's row says the answer in place of the ask, and
      // after a reload too.
      const answered = page.waitForResponse(
        (response) =>
          /\/api\/inbox-items\/[^/]+\/actions$/.test(response.url()) &&
          response.request().method() === "POST",
      );
      release();
      expect((await answered).ok()).toBe(true);
      await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
      const summary = rollout(page).locator('[data-inbox-slot="summary"]');
      await expect(summary).toHaveText("You answered Hold");
      await expect(page.getByText(ask)).toHaveCount(0);
      // The summaries read the cards of their links.
      const cardsRead = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/objects",
      );
      await page.reload();
      await expect(summary).toHaveText("You answered Hold");
      await cardsRead;
    });
  }

  test("a failed answer shows its failure toast with Retry", async ({
    dashboard,
    page,
  }) => {
    await page.route(/\/api\/inbox-items\/[^/]+\/actions$/, (route) =>
      route.fulfill({ json: { error: "Down." }, status: 503 }),
    );
    await page.goto(`${dashboard.baseURL}/inbox?view=inbox`);
    await answerHold(page);
    const failure = toasts(page).filter({
      hasText: "Could not send your answer",
    });
    await expect(failure).toBeVisible();
    await expect(failure.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(toasts(page)).toHaveCount(1);
  });
});
