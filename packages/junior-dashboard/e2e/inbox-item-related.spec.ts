import type { Locator } from "@playwright/test";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

// The mock rollout question suggests Roll out. Its links support that,
// and two other open items on the same release say p95 rose and ask to
// hold the deploy.
const QUESTION_CONVERSATION_ID = "internal:question-qa";

async function expectRelated(question: Locator) {
  const links = question.getByRole("region", { name: "Links" });
  await expect(
    links.getByRole("link", { name: "Canary error rate" }),
  ).toHaveAttribute("href", /release=payments-v42/);
  await expect(links).toContainText("Flat for 30 minutes.");
  const related = question.getByRole("region", { name: "Related" });
  await expect(
    related.getByRole("link", { name: "Hold the payments-v42 deploy" }),
  ).toBeVisible();
  // The linked Conversation shows its title.
  await expect(
    related.getByRole("link", { name: "Checkout latency triage" }),
  ).toBeVisible();
  return related;
}

for (const view of [desktop, mobile]) {
  test(`shows a question's related links and items above its choices (${view.name})`, async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(view);
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(QUESTION_CONVERSATION_ID)}`,
    );
    const question = page.getByRole("region", {
      name: "Asked Approve the payments-v42 rollout",
    });
    await expectRelated(question);
    // The pill shows until the card reports that it is in full view.
    await question.scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", { name: /questions? waiting$/ }),
    ).toHaveCount(0);
    await screenshot(page, "inbox-item-related-card", {
      lightTheme: true,
      view: view.name,
    });
  });
}

test("an Inbox question row shows its related links and items", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}/inbox?view=inbox&item=qa-rollout`);
  const related = await expectRelated(
    page.getByRole("region", { name: "Approve the payments-v42 rollout" }),
  );
  // The Inbox has the item's row, so the link expands it in place and then
  // leaves the URL.
  const link = related.getByRole("link", {
    name: "Checkout p95 rose after payments-v42",
  });
  await expect(link).toHaveAttribute("href", /item=qa-p95-rose/);
  await link.click();
  await expect(
    page.getByRole("region", { name: "Checkout p95 rose after payments-v42" }),
  ).toBeVisible();
});
