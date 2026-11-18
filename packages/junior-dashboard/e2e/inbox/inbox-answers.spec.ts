import type { Page } from "@playwright/test";

import { expect, test } from "../test";

const title = "Roll out payments-v42";

function rollout(page: Page) {
  return page.locator("[data-inbox-row]").filter({ hasText: title });
}

async function answerHold(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/`);
  const todo = page.getByRole("region", { name: "To do" });
  await rollout(page).getByRole("button", { name: "Question" }).click();
  await todo
    .getByRole("region", { name: "Approve the payments-v42 rollout" })
    .getByRole("button", { exact: true, name: "Hold" })
    .click();
}

function toasts(page: Page, text: string) {
  return page.locator('[data-slot="toast"]').filter({ hasText: text });
}

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  test("an answer says so in a toast, then on the row", async ({
    dashboard,
    page,
  }) => {
    // The mock's own items: its rollout question closes with its answer.
    const ask = "I need your go-ahead before I roll out to every region.";
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    // Hold the answer, so the toast shows before the server answers.
    await page.route(/\/api\/review-items\/[^/]+\/actions$/, async (route) => {
      await held;
      await route.fallback();
    });
    await answerHold(page, dashboard.baseURL);
    const toast = toasts(page, "You answered Hold");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(title);

    // Conversations lists the row. It says the answer in place of the ask
    // at once, and after a reload too.
    const answered = page.waitForResponse(
      /\/api\/review-items\/[^/]+\/actions$/,
    );
    release();
    await answered;
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { exact: true, name: "Conversations" })
      .click();
    const summary = rollout(page).locator('[data-inbox-slot="summary"]');
    await expect(summary).toHaveText("You answered Hold");
    await expect(page.getByText(ask)).toHaveCount(0);
    await page.reload();
    await expect(summary).toHaveText("You answered Hold");
  });

  test("a failed answer shows only its failure toast", async ({
    dashboard,
    page,
  }) => {
    let fail = () => {};
    const failing = new Promise<void>((resolve) => (fail = resolve));
    await page.route(/\/api\/review-items\/[^/]+\/actions$/, async (route) => {
      await failing;
      await route.fulfill({ json: { error: "Down." }, status: 503 });
    });
    await answerHold(page, dashboard.baseURL);
    await expect(toasts(page, "You answered Hold")).toBeVisible();
    fail();
    await expect(toasts(page, "Could not send your answer")).toBeVisible();
    await expect(toasts(page, "You answered Hold")).toHaveCount(0);
  });
});
