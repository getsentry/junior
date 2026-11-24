import type { Locator, Page } from "@playwright/test";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

// The mock rollout question suggests Roll out. Its evidence supports that,
// and two other open items on the same release say p95 rose and ask to
// hold the deploy.
const QUESTION_CONVERSATION_ID = "internal:question-qa";

async function expectEvidence(question: Locator) {
  const evidence = question.getByRole("region", { name: "Evidence" });
  await expect(
    evidence.getByRole("link", { name: "Canary error rate" }),
  ).toHaveAttribute("href", /release=payments-v42/);
  await expect(evidence).toContainText("Flat for 30 minutes.");
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

async function openRelatedItem(page: Page, related: Locator) {
  await related
    .getByRole("link", { name: "Checkout p95 rose after payments-v42" })
    .click();
  await expect(page).toHaveURL(/item=qa-p95-rose/);
}

for (const view of [desktop, mobile]) {
  test(`shows a question's evidence and related items above its choices (${view.name})`, async ({
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
    await expectEvidence(question);
    await screenshot(page, "inbox-item-evidence-card", {
      lightTheme: true,
      view: view.name,
    });
  });
}

test("the Inbox question links its evidence and related items @classic", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}/review?item=qa-rollout`);
  const related = await expectEvidence(
    page.getByRole("region", { name: "Answer" }),
  );
  await openRelatedItem(page, related);
});

test("an Inbox question row links its evidence and related items @new", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}/inbox?view=inbox&item=qa-rollout`);
  const related = await expectEvidence(
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
