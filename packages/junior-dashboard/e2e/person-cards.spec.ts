import type { Page } from "@playwright/test";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

// A mock Conversation where the viewer wrote, answered a question, and
// Junior mentions Avery Chen as `<@U789>`.
const CONVERSATION_ID = "internal:question-qa";

async function openConversation(page: Page, baseURL: string) {
  await page.goto(
    `${baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
}

function personCard(page: Page, name: string) {
  return page.getByRole("dialog", { name });
}

test("a message header name opens the person card", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await openConversation(page, dashboard.baseURL);
  const name = page
    .getByRole("article")
    .getByRole("link", { name: "Dashboard User", exact: true })
    .first();
  await expect(name).toHaveAttribute("href", "/people/dev%40example.com");

  await name.hover();
  const card = personCard(page, "Dashboard User");
  await expect(card).toBeVisible();
  await expect(
    card.getByRole("link", { name: "View profile" }),
  ).toHaveAttribute("href", "/people/dev%40example.com");
  // The card shows no personal data that the header does not.
  await expect(card).not.toContainText("dev@example.com");

  // A keyboard reader opens it with focus and closes it with Escape.
  await page.mouse.move(0, 0);
  await expect(card).toBeHidden();
  await name.focus();
  await expect(name).toHaveAttribute("aria-expanded", "true");
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(name).toHaveAttribute("aria-expanded", "false");
});

test("a Slack mention shows the photo and name, and opens the person card", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await openConversation(page, dashboard.baseURL);
  const message = page
    .getByRole("article")
    .filter({ hasText: "The canary is running in us-east-1." });
  await expect(message).not.toContainText("U789");
  const mention = message.getByRole("link", { name: "@Avery Chen" });
  await expect(mention).toBeVisible();
  // Avery has no photo, so the mark before the name is the initial.
  await expect(mention.locator("xpath=..")).toContainText("A@Avery Chen");

  await mention.hover();
  const card = personCard(page, "Avery Chen");
  await expect(card).toBeVisible();
  await expect(
    card.getByRole("link", { name: "View profile" }),
  ).toHaveAttribute("href", "/people/avery%40sentry.io");
  await expect(card).not.toContainText("avery@sentry.io");
});

test("a raw Slack id in a Review item question shows the person", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await openConversation(page, dashboard.baseURL);
  // The question preview shows the item's text with its mentions resolved.
  await page
    .getByRole("region", { name: "Asked Pick the canary region" })
    .getByRole("link", { name: "Pick the canary region" })
    .hover();
  const question = page.getByText("Which region should run the canary?");
  await expect(question).toBeVisible();
  await expect(question).toContainText("@Avery Chen owns the rollback.");
  await expect(question).not.toContainText("U789");
});

test("the answer line names the person who answered", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await openConversation(page, dashboard.baseURL);
  const ask = page.getByRole("region", {
    name: "Asked Pick the canary region",
  });
  const answeredBy = ask.getByRole("link", { name: "Dashboard User" });
  await expect(ask).toContainText("Answered by");
  await answeredBy.hover();
  await expect(personCard(page, "Dashboard User")).toBeVisible();
});

test("a tap on a touch screen opens the person card", async ({
  browser,
  dashboard,
}) => {
  const context = await browser.newContext({
    colorScheme: "dark",
    hasTouch: true,
    isMobile: true,
    viewport: { height: mobile.height, width: mobile.width },
  });
  const page = await context.newPage();
  await openConversation(page, dashboard.baseURL);
  const mention = page.getByRole("link", { name: "@Avery Chen" }).first();
  await mention.tap();
  const card = personCard(page, "Avery Chen");
  await expect(card).toBeVisible();
  // The first tap shows the card and stays on the page.
  await expect(page).toHaveURL(/\/conversations\//);
  await context.close();
});

// The screenshots show the new UI, where the request came from.
test(
  "person references in a transcript",
  { tag: "@new" },
  async ({ dashboard, page }) => {
    for (const view of [desktop, mobile]) {
      await page.setViewportSize(view);
      await openConversation(page, dashboard.baseURL);
      const message = page
        .getByRole("article")
        .filter({ hasText: "The canary is running in us-east-1." });
      await expect(
        message.getByRole("link", { name: "@Avery Chen" }),
      ).toBeVisible();
      await page
        .getByRole("region", { name: "Asked Pick the canary region" })
        .scrollIntoViewIfNeeded();
      await screenshot(page, "person-references", {
        lightTheme: true,
        view: view.name,
      });
      await message.getByRole("link", { name: "@Avery Chen" }).hover();
      await expect(personCard(page, "Avery Chen")).toBeVisible();
      await screenshot(page, "person-card", {
        lightTheme: true,
        view: view.name,
      });
      await page.mouse.move(0, 0);
    }
  },
);
