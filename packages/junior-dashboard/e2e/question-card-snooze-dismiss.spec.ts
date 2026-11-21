import type { Page } from "@playwright/test";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

// Three open questions. "Handle the negative invoices" is also for a
// teammate; the other two are for the viewer alone.
const THREE_QUESTIONS_ID = "internal:questions-qa";

async function openConversation(page: Page, baseURL: string) {
  await page.goto(
    `${baseURL}/conversations/${encodeURIComponent(THREE_QUESTIONS_ID)}`,
  );
}

/** Record the body of each request to a path that the page sends. */
function recordBodies(page: Page, path: string) {
  const bodies: unknown[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(path)) {
      bodies.push(request.postDataJSON());
    }
  });
  return bodies;
}

const card = (page: Page, title: string) =>
  page.getByRole("region", { name: `Asked ${title}` });

for (const view of [desktop, mobile]) {
  test(`a question card snoozes in the transcript, and the pill skips it (${view.name})`, async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(view);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const snoozes = recordBodies(page, "/api/inbox/snoozes");
    await openConversation(page, dashboard.baseURL);
    await expect(
      page.getByRole("button", { name: "3 questions waiting" }),
    ).toBeVisible();

    const windowCard = card(page, "Pick the billing migration window");
    await windowCard.scrollIntoViewIfNeeded();
    await windowCard.getByRole("button", { name: "Snooze" }).click();
    const menu = page.getByRole("dialog", { name: "Snooze until" });
    await expect(menu.getByRole("button", { name: /^1 hour/ })).toBeVisible();
    await screenshot(page, "conversation-question-card-snooze", {
      lightTheme: true,
      view: view.name,
    });
    await menu.getByRole("button", { name: /^1 hour/ }).click();

    await expect
      .poll(() => snoozes)
      .toEqual([
        expect.objectContaining({
          conversationId: THREE_QUESTIONS_ID,
          inboxItemId: "qa-migration-window",
          wakeAt: expect.any(String),
        }),
      ]);
    // The card stays in the transcript as a record, with no form.
    await expect(windowCard).toContainText("Snoozed");
    await expect(
      windowCard.getByRole("button", { name: "Send", exact: true }),
    ).toHaveCount(0);
    // The transcript opens at the latest message again, and the pill counts
    // the two questions that still wait.
    await page.reload();
    await expect(
      page.getByRole("button", { name: "2 questions waiting" }),
    ).toBeVisible();
  });
}

for (const view of [desktop, mobile]) {
  test(`Dismiss hides a shared question for the viewer only (${view.name})`, async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(view);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const actions = recordBodies(page, "/actions");
    await openConversation(page, dashboard.baseURL);

    const shared = card(page, "Handle the negative invoices");
    await shared.scrollIntoViewIfNeeded();
    await shared.getByRole("button", { name: "Dismiss" }).click();
    await expect.poll(() => actions).toEqual([{ action: "dismiss" }]);
    // It stays open for the teammate, so the record says it is gone for
    // the viewer only.
    await expect(shared).toContainText("Dismissed for you");
    await expect(
      shared.getByRole("button", { name: "Send", exact: true }),
    ).toHaveCount(0);
    // The details list of open items drops it too.
    if (view === desktop) {
      await expect(
        page
          .getByRole("complementary")
          .getByRole("button", { name: /^Pick the billing migration window/ }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("complementary")
          .getByRole("button", { name: /^Handle the negative invoices/ }),
      ).toHaveCount(0);
    }
    await shared.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await screenshot(page, "conversation-question-card-dismissed-for-you", {
      lightTheme: true,
      view: view.name,
    });
  });
}

test("Dismiss still closes a question for the viewer alone", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await openConversation(page, dashboard.baseURL);
  const tables = card(page, "Choose the first migration batch");
  await tables.scrollIntoViewIfNeeded();
  await tables.getByRole("button", { name: "Dismiss" }).click();
  await expect(tables).toContainText(/Dismissed by/);
  await expect(tables).not.toContainText("Dismissed for you");
});

// Only the inbox project runs `@new` tests.
test(
  "Dismiss on a shared question in the Inbox hides it for the viewer only",
  {
    tag: "@new",
  },
  async ({ dashboard, page }) => {
    await page.setViewportSize(desktop);
    await page.goto(
      `${dashboard.baseURL}/?view=inbox&item=qa-migration-negative`,
    );
    const inboxCard = page.locator('[data-inbox-card="qa-migration-negative"]');
    await expect(inboxCard).toContainText(
      "What should happen to the 12 negative invoices?",
    );
    await inboxCard.getByRole("button", { name: "Dismiss" }).click();
    await expect(inboxCard).toHaveCount(0);
    // It does not come back when the Inbox reads the server again.
    await page.reload();
    await expect(
      page.getByText("Pick the billing migration window").first(),
    ).toBeVisible();
    await expect(page.getByText("Handle the negative invoices")).toHaveCount(0);

    await openConversation(page, dashboard.baseURL);
    await expect(card(page, "Handle the negative invoices")).toContainText(
      "Dismissed for you",
    );
  },
);
