import type { Page } from "@playwright/test";
import { openAsk } from "./askSheet";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";
import { waitForOutlineRead } from "./harness";

// Three open questions. "Handle the negative invoices" is also for a
// teammate; the other two are for the viewer alone.
const THREE_QUESTIONS_ID = "internal:questions-qa";

async function openConversation(page: Page, baseURL: string) {
  await page.goto(
    `${baseURL}/conversations/${encodeURIComponent(THREE_QUESTIONS_ID)}`,
  );
}

/**
 * Reload the Conversation, and wait for the outline that each visit reads.
 */
async function reloadConversation(page: Page) {
  const outlineRead = waitForOutlineRead(page, THREE_QUESTIONS_ID);
  await page.reload();
  await outlineRead;
}

/**
 * Record the body of each request to a path that the page sends, once the
 * server answers it.
 */
function recordBodies(page: Page, path: string) {
  const bodies: unknown[] = [];
  page.on("requestfinished", (request) => {
    if (new URL(request.url()).pathname.endsWith(path)) {
      bodies.push(request.postDataJSON());
    }
  });
  return bodies;
}

/** Close a phone's question sheet, back to the transcript. */
async function closeSheet(page: Page) {
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { exact: true, name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
}

const card = (page: Page, title: string) =>
  page.getByRole("region", { name: `Asked ${title}` });

for (const view of [desktop, mobile]) {
  test(`a question card snoozes from the transcript, and still waits (${view.name})`, async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(view);
    const snoozes = recordBodies(page, "/api/inbox/snoozes");
    const phone = view === mobile;
    await openConversation(page, dashboard.baseURL);
    // A phone shows each card as one line, so the short transcript fits on
    // the screen there and needs no pill.
    if (!phone) {
      await expect(
        page.getByRole("button", { name: "3 questions waiting" }),
      ).toBeVisible();
    }

    // A question with two fields keeps its actions on one row, with the
    // progress under them. A phone opens the question in a sheet.
    const batch = await openAsk(
      card(page, "Choose the first migration batch"),
      phone,
    );
    await batch.getByRole("button", { name: "Send" }).scrollIntoViewIfNeeded();
    await expect(batch).toContainText("0 of 2 answered");
    await screenshot(page, "conversation-question-card-actions", {
      lightTheme: true,
      view: view.name,
    });
    if (phone) {
      await batch.getByRole("button", { exact: true, name: "Close" }).click();
      await expect(batch).toHaveCount(0);
    }

    const windowCard = card(page, "Pick the billing migration window");
    await windowCard.scrollIntoViewIfNeeded();
    const windowAsk = await openAsk(windowCard, phone);
    await windowAsk.getByRole("button", { name: "Snooze" }).click();
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
    // A snooze shuts the menu. It hides the item from the viewer's Inbox,
    // but the question stays open, so it still waits for anyone, and a
    // phone's sheet stays until the reader closes it.
    await expect(menu).toHaveCount(0);
    if (phone) await closeSheet(page);
    await expect(windowCard).toContainText("Waiting");
    // The transcript opens at the latest message again, and the pill counts
    // all three questions.
    await reloadConversation(page);
    if (!phone) {
      await expect(
        page.getByRole("button", { name: "3 questions waiting" }),
      ).toBeVisible();
    }
  });
}

for (const view of [desktop, mobile]) {
  test(`Someday snoozes a shared question until someone else handles it (${view.name})`, async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(view);
    const snoozes = recordBodies(page, "/api/inbox/snoozes");
    await openConversation(page, dashboard.baseURL);

    const shared = card(page, "Handle the negative invoices");
    await shared.scrollIntoViewIfNeeded();
    // A phone opens the question in a sheet.
    await (
      await openAsk(shared, view === mobile)
    )
      .getByRole("button", { name: "Snooze" })
      .click();
    const menu = page.getByRole("dialog", { name: "Snooze until" });
    await expect(menu.getByRole("button", { name: "Someday" })).toBeVisible();
    await screenshot(page, "conversation-question-card-someday", {
      lightTheme: true,
      view: view.name,
    });
    await menu.getByRole("button", { name: "Someday" }).click();
    // No time and no Event: the snooze lasts until the item closes.
    await expect
      .poll(() => snoozes)
      .toEqual([
        {
          conversationId: THREE_QUESTIONS_ID,
          inboxItemId: "qa-migration-negative",
          untilClosed: true,
        },
      ]);
    // The question stays open, so its card still waits.
    await expect(menu).toHaveCount(0);
    if (view === mobile) await closeSheet(page);
    await expect(shared).toContainText("Waiting");
    // The details list of the viewer's open items drops it.
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
    await reloadConversation(page);
    // A phone's one-line cards fit on the screen, so it needs no pill.
    if (view === desktop) {
      await expect(
        page.getByRole("button", { name: "3 questions waiting" }),
      ).toBeVisible();
    }
  });
}

test("Dismiss closes a shared question for everyone", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await openConversation(page, dashboard.baseURL);
  const shared = card(page, "Handle the negative invoices");
  await shared.scrollIntoViewIfNeeded();
  // Dismiss, Snooze, then the main action, as on every card.
  await expect(
    shared.getByRole("button", { name: /^(Dismiss|Snooze|Send)$/ }),
  ).toHaveText(["Dismiss", "Snooze", "Send"]);
  await shared.getByRole("button", { name: "Dismiss" }).click();
  await expect(shared).not.toContainText("Waiting");
  await expect(
    shared.getByRole("button", { name: "Send", exact: true }),
  ).toHaveCount(0);
});

for (const view of [desktop, mobile]) {
  test(`a Slack card's Snooze link opens the item's snooze dialog (${view.name})`, async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(view);
    const snoozes = recordBodies(page, "/api/inbox/snoozes");
    await page.goto(
      `${dashboard.baseURL}/inbox?item=qa-migration-negative&snooze=1`,
    );
    const dialog = page.getByRole("dialog", { name: "Custom snooze" });
    await expect(dialog).toBeVisible();
    // The link leaves the URL, so a reload does not open the dialog again.
    // The item leaves once the list shows its row.
    await expect
      .poll(() => {
        const params = new URL(page.url()).searchParams;
        return [params.get("item"), params.get("snooze")];
      })
      .toEqual([null, null]);
    // A phone opens no sheet for the row, so the dialog stays in front.
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await screenshot(page, "inbox-linked-snooze-dialog", {
      lightTheme: true,
      view: view.name,
    });
    await dialog.getByRole("button", { name: "Someday" }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => snoozes)
      .toEqual([
        expect.objectContaining({
          inboxItemId: "qa-migration-negative",
          untilClosed: true,
        }),
      ]);
  });
}

test("an Inbox question card reads Dismiss, Snooze, then Send", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(
    `${dashboard.baseURL}/inbox?view=inbox&item=qa-migration-negative`,
  );
  const inboxCard = page.locator('[data-inbox-card="qa-migration-negative"]');
  await expect(inboxCard).toContainText(
    "What should happen to the 12 negative invoices?",
  );
  await expect(
    inboxCard.getByRole("button", { name: /^(Dismiss|Snooze|Send)$/ }),
  ).toHaveText(["Dismiss", "Snooze", "Send"]);
});
