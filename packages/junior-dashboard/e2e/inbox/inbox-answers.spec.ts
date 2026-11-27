import type { Page } from "@playwright/test";

import { expect, test } from "../test";

const title = "Roll out payments-v42";

function rollout(page: Page) {
  return page.locator("[data-inbox-row]").filter({ hasText: title });
}

async function answerHold(page: Page, phone: boolean) {
  await rollout(page).locator('[aria-controls^="inbox-row-"]').first().click();
  // A phone opens the row in a sheet.
  const card = (
    phone
      ? page.getByRole("dialog", { name: "Approve the payments-v42 rollout" })
      : page.getByRole("region", { name: "To do" })
  ).getByRole("region", {
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

test.describe("new UI", () => {
  for (const view of [
    { height: 900, name: "desktop", width: 1440 },
    { height: 844, name: "phone", width: 390 },
  ]) {
    test(`an answer shows no toast (${view.name})`, async ({
      dashboard,
      page,
    }) => {
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      // Hold the answer, so the row leaves before the server answers.
      await page.route(/\/api\/inbox-items\/[^/]+\/actions$/, async (route) => {
        await held;
        await route.fallback();
      });
      await page.setViewportSize(view);
      await page.goto(`${dashboard.baseURL}/inbox?view=inbox`);
      const phone = view.name === "phone";
      await answerHold(page, phone);
      // The row leaving is the confirmation. Count at once: a toast that
      // showed with the answer would still show now.
      await expect(rollout(page)).toHaveCount(0);
      // The sheet closes with its row, back to the list.
      if (phone) await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await toasts(page).count()).toBe(0);

      // The test ends after the answer that it held.
      const answered = page.waitForResponse(
        (response) =>
          /\/api\/inbox-items\/[^/]+\/actions$/.test(response.url()) &&
          response.request().method() === "POST",
      );
      release();
      expect((await answered).ok()).toBe(true);
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
    await answerHold(page, false);
    const failure = toasts(page).filter({
      hasText: "Could not send your answer",
    });
    await expect(failure).toBeVisible();
    await expect(failure.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(toasts(page)).toHaveCount(1);
  });
});
