import type { Page } from "@playwright/test";
import { desktop } from "./screenshot";
import { expect, test } from "./test";

// The last reply of the mock release Conversation links to a person, a pull
// request alone on its line, and a video page alone on its line.
const CONVERSATION_ID = "slack:CQA456:1770021600.000600";
const CONVERSATION_PATH = `/conversations/${encodeURIComponent(CONVERSATION_ID)}`;
const PULL_REQUEST_CARD = "Pull request: Pin the release train to payments 4.2";
const PULL_REQUEST_URL = "https://github.com/getsentry/payments/pull/91";

// Resolved links render again when their cards arrive, which drops an
// earlier hover. Wait for them before a hover.
async function waitForResolvedLinks(page: Page): Promise<void> {
  for (const name of [/Release 4\.2 checklist/, /Checkout 4\.2 launch demo/]) {
    await expect(page.getByRole("link", { name }).first()).toBeVisible();
  }
}

async function choosePlainLinks(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Open profile menu for/ }).click();
  await page.getByRole("menuitemradio", { name: "Plain links" }).click();
  await page.keyboard.press("Escape");
}

test("plain links show every link as text, and the browser keeps the choice", async ({
  browser,
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${CONVERSATION_PATH}`);
  await waitForResolvedLinks(page);
  // The person photo is part of the `@Name` link, and has no name of its own.
  const person = page.getByRole("link", { name: "@Morgan Lee" }).first();
  const demo = page.getByRole("link", { name: "Checkout 4.2 launch demo" });

  // Rich links are the default.
  await expect(
    page.getByRole("region", { name: PULL_REQUEST_CARD }),
  ).toBeVisible();
  await expect(person.getByRole("presentation")).toHaveCount(1);
  await expect(demo.getByRole("img")).toHaveCount(1);

  await choosePlainLinks(page);

  for (const reload of [false, true]) {
    if (reload) {
      await page.reload();
      await waitForResolvedLinks(page);
    }
    // A link alone on its line is its titled link, with no card or thumbnail.
    await expect(
      page.getByRole("region", { name: PULL_REQUEST_CARD }),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("link", {
          name: "Pin the release train to payments 4.2 (#91)",
        })
        .first(),
    ).toHaveAttribute("href", PULL_REQUEST_URL);
    await expect(demo.getByRole("img")).toHaveCount(0);
    // A person is `@Name` with no photo.
    await expect(person).toBeVisible();
    await expect(person.getByRole("presentation")).toHaveCount(0);
  }

  // Hover cards stay.
  await page
    .getByRole("link", { name: "Investigate checkout latency", exact: true })
    .hover();
  await expect(
    page.getByRole("region", {
      name: "Conversation: Investigate checkout latency",
    }),
  ).toBeVisible();

  // Another browser has its own choice.
  const other = await browser.newPage();
  await other.goto(`${dashboard.baseURL}${CONVERSATION_PATH}`);
  await expect(
    other.getByRole("region", { name: PULL_REQUEST_CARD }),
  ).toBeVisible();
  await other.close();
});

test("an Inbox item card keeps rich links in plain links", async ({
  page,
  dashboard,
}) => {
  const title = "Merge the payments pin";
  await page.route("**/api/inbox-items**", async (route) => {
    // Only the list of items; counts and other reads keep their mocks.
    if (
      !/\/api\/inbox-items\/?$/.test(new URL(route.request().url()).pathname)
    ) {
      return route.fallback();
    }
    return route.fulfill({
      json: {
        items: [
          {
            assignedToEveryone: false,
            assignees: [
              {
                avatarUrl: "https://example.com/avatar/morgan.png",
                displayName: "Morgan Lee",
                email: "dev@example.com",
                userId: "u-dev",
              },
            ],
            body: `The pin is ready.\n\n${PULL_REQUEST_URL}`,
            canAct: true,
            canTake: false,
            conversationIds: [],
            createdAt: "2026-08-07T08:00:00.000Z",
            id: "item-payments-pin",
            kind: "notice",
            owner: { id: CONVERSATION_ID, kind: "conversation" },
            status: "open",
            title,
            updatedAt: "2026-08-07T08:30:00.000Z",
            visibility: "public",
          },
        ],
      },
    });
  });
  await page.route("https://example.com/avatar/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: "<svg xmlns='http://www.w3.org/2000/svg'/>",
    }),
  );
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${CONVERSATION_PATH}`);
  await waitForResolvedLinks(page);
  await choosePlainLinks(page);
  await page.goto(`${dashboard.baseURL}${CONVERSATION_PATH}?review=open`);

  const card = page.getByRole("region", { name: `Inbox item: ${title}` });
  await expect(card).toBeVisible();
  // The card shows the pull request card and the assignee photo...
  await expect(
    card.getByRole("region", { name: PULL_REQUEST_CARD }),
  ).toBeVisible();
  await expect(
    card.getByRole("link", { name: "Morgan Lee" }).getByRole("presentation"),
  ).toHaveCount(1);
  // ...while the transcript shows the same pull request as its titled link.
  await expect(
    page.getByRole("region", { name: PULL_REQUEST_CARD }),
  ).toHaveCount(1);
});
