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

/** Count the person card reads that the page sends. */
function countCardReads(page: Page) {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/people\/[^/]+\/card$/.test(new URL(request.url()).pathname)) {
      reads.push(request.url());
    }
  });
  return reads;
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
  // It is the person object card that a link to the People page shows.
  await expect(
    card.getByRole("link", { name: /^Open person/ }),
  ).toHaveAttribute("href", /\/people\/dev%40example\.com$/);
  await expect(card).toContainText("dev@example.com");
  await expect(card).toContainText("@dev-example");
  // With the recent activity of the person.
  const activity = card.getByRole("region", { name: "Recent activity" });
  await expect(activity).toContainText("Last active");
  await expect(activity.getByRole("link").first()).toHaveAttribute(
    "href",
    /^\/conversations\//,
  );

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
    card.getByRole("link", { name: /^Open person/ }),
  ).toHaveAttribute("href", /\/people\/avery%40sentry\.io$/);
  await expect(card).toContainText("avery@sentry.io");
  // Avery's one Conversation is a private one the viewer is not in: it
  // counts, but it does not show.
  const activity = card.getByRole("region", { name: "Recent activity" });
  await expect(activity).toContainText("1 conversation this week");
  await expect(activity.getByRole("link")).toHaveCount(0);
});

test("a person card loads only when it opens", async ({ dashboard, page }) => {
  await page.setViewportSize(desktop);
  const reads = countCardReads(page);
  await openConversation(page, dashboard.baseURL);
  const mention = page.getByRole("link", { name: "@Avery Chen" }).first();
  await expect(mention).toBeVisible();
  // Every reference shows, and no card is read yet.
  await expect(
    page.getByRole("link", { name: "Dashboard User", exact: true }).first(),
  ).toBeVisible();
  expect(reads).toEqual([]);

  await mention.hover();
  await expect(
    personCard(page, "Avery Chen").getByRole("region", {
      name: "Recent activity",
    }),
  ).toBeVisible();
  expect(reads).toHaveLength(1);
  expect(reads[0]).toContain("/api/people/avery%40sentry.io/card");

  // Opening it again reads nothing new.
  await page.mouse.move(0, 0);
  await expect(personCard(page, "Avery Chen")).toBeHidden();
  await mention.hover();
  await expect(personCard(page, "Avery Chen")).toBeVisible();
  expect(reads).toHaveLength(1);
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
      // The viewer's own card has Conversations they may read.
      await page
        .getByRole("article")
        .getByRole("link", { name: "Dashboard User", exact: true })
        .first()
        .hover();
      await expect(
        personCard(page, "Dashboard User")
          .getByRole("region", { name: "Recent activity" })
          .getByRole("link")
          .first(),
      ).toBeVisible();
      await screenshot(page, "person-card", {
        lightTheme: true,
        view: view.name,
      });
      await page.mouse.move(0, 0);
    }
  },
);
