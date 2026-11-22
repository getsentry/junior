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
  // The transcript shows its messages before the rows of its Inbox items,
  // and each row that shows moves the messages. A card trigger that moves
  // away from a still pointer does not open. The answered question's row
  // shows last, so hover only after it shows.
  await expect(
    page.getByRole("region", { name: "Asked Pick the canary region" }),
  ).toContainText("Answered by");
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
  // The pull requests the person merged come first, then their activity.
  const shipped = card.getByRole("region", { name: "Recently shipped" });
  await expect(shipped.getByRole("link").first()).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/,
  );
  // Each one names its repository and number, and when it merged.
  await expect(shipped).toContainText(/\S+\/\S+#\d+ · merged /);
  // And its size.
  await expect(
    shipped.getByRole("listitem").filter({ hasText: "Pin Node 22 in CI" }),
  ).toContainText("2 lines added, 2 removed, 1 file changed");
  const activity = card.getByRole("region", { name: "Recent activity" });
  await expect(activity).toContainText("Last active");
  await expect(activity.getByRole("link").first()).toHaveAttribute(
    "href",
    /^\/conversations\//,
  );
  const names = await card
    .getByRole("region")
    .evaluateAll((regions) =>
      regions.map((region) => region.getAttribute("aria-label")),
    );
  expect(names.indexOf("Recently shipped")).toBeGreaterThanOrEqual(0);
  expect(names.indexOf("Recently shipped")).toBeLessThan(
    names.indexOf("Recent activity"),
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

  // The photo mark is part of the link, so it opens the card too.
  await page.mouse.move(0, 0);
  await expect(card).toBeHidden();
  await mention.locator('[aria-hidden="true"]').first().hover();
  await expect(card).toBeVisible();
  // Avery's one Conversation is a private one the viewer is not in: it
  // sets "Last active", but it does not show.
  const activity = card.getByRole("region", { name: "Recent activity" });
  await expect(activity).toContainText("Last active");
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

test("a person card says when its activity fails to load", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.route(/\/api\/people\/[^/]+\/card$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      status: 500,
      body: JSON.stringify({ error: "Card failed." }),
    }),
  );
  await openConversation(page, dashboard.baseURL);
  await page.getByRole("link", { name: "@Avery Chen" }).first().hover();
  const card = personCard(page, "Avery Chen");
  await expect(card.getByText("Could not load recent activity.")).toBeVisible();
  await expect(
    card.getByRole("region", { name: "Recent activity" }),
  ).toHaveCount(0);
});

test("a raw Slack id in an Inbox item question shows the person", async ({
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
  // Inside the preview, the mention only links: a card inside another card
  // would close when the pointer leaves the outer one.
  const mention = question.getByRole("link", { name: "@Avery Chen" });
  await expect(mention).toHaveAttribute("href", "/people/avery%40sentry.io");
  await expect(mention).not.toHaveAttribute("aria-haspopup", "dialog");
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
      const ask = page.getByRole("region", {
        name: "Asked Pick the canary region",
      });
      await ask.scrollIntoViewIfNeeded();
      await screenshot(page, "person-references", {
        lightTheme: true,
        view: view.name,
      });
      // Close crops of a mention and an "Answered by" line, to check that
      // each photo sits on the middle of its line.
      await screenshot(page, "person-mention-line", {
        lightTheme: true,
        target: message.locator("p").filter({ hasText: "can roll it back" }),
        view: view.name,
      });
      await screenshot(page, "person-answered-by-line", {
        lightTheme: true,
        target: ask,
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
          .getByRole("region", { name: "Recently shipped" })
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
