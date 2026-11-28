import type { Locator } from "@playwright/test";
import { openAsk } from "./askSheet";
import { digest, mockInboxItems } from "./inbox/inbox-fixture";
import { distanceFromBottom } from "./long-transcript-fixture";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

// The mock rollout question suggests Roll out. Its links support that,
// and two other open items on the same release say p95 rose and ask to
// hold the deploy. Only the Inbox reads those items.
const QUESTION_CONVERSATION_ID = "internal:question-qa";

async function expectRelated(question: Locator, items: boolean) {
  // One list: the question's links first, then the related items and
  // Conversations.
  const related = question.getByRole("region", { name: "Related" });
  await expect(question.getByRole("region", { name: "Links" })).toHaveCount(0);
  await expect(
    related.getByRole("link", { name: "Canary error rate" }),
  ).toHaveAttribute("href", /release=payments-v42/);
  await expect(related).toContainText("Flat for 30 minutes.");
  await expect(
    related.getByRole("link", { name: "Hold the payments-v42 deploy" }),
  ).toHaveCount(items ? 1 : 0);
  // The question links a Conversation that is also related, so it shows
  // once, with the question's note.
  await expect(
    related.getByRole("link", { name: "Checkout latency triage" }),
  ).toHaveCount(1);
  await expect(related).toContainText("Where p95 is tracked.");
  return related;
}

for (const view of [desktop, mobile]) {
  test(`shows a question's related links above its choices (${view.name})`, async ({
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
    // Each record shows once its item loads, and the transcript then scrolls
    // back to its end. Playwright retries a tap on a record that moves with
    // a scroll that leaves the thread above its end, so wait for both.
    await expect(
      page.getByRole("region", { name: "Asked Pick the canary region" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        distanceFromBottom(page.getByLabel("Conversation transcript")),
      )
      .toBeLessThanOrEqual(1);
    // A phone opens the question in a sheet.
    await expectRelated(await openAsk(question, view === mobile), false);
    if (view === desktop) {
      // The pill shows until the card reports that it is in full view.
      await question.scrollIntoViewIfNeeded();
      await expect(
        page.getByRole("button", { name: /questions? waiting$/ }),
      ).toHaveCount(0);
    }
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
    true,
  );
  // The list shows two rows until the reader asks for the rest.
  await related.getByRole("button", { name: "Show 1 more" }).click();
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

test("a related link to an object opens its hover card", async ({
  dashboard,
  page,
}) => {
  const notice = {
    ...digest,
    request: {
      related: [
        {
          label: "Sidebar tabs",
          url: "https://github.com/getsentry/junior/pull/3052",
        },
      ],
    },
  };
  await page.setViewportSize(desktop);
  await mockInboxItems(page, { open: [notice] });
  await page.goto(`${dashboard.baseURL}/inbox?item=${notice.id}`);
  await page
    .getByRole("region", { name: "Related" })
    .getByRole("link", { name: "Sidebar tabs" })
    .hover();
  await expect(
    page.getByRole("region", {
      name: "Pull request: feat(dashboard): Tabs in the dashboard sidebar",
    }),
  ).toBeVisible();
});
