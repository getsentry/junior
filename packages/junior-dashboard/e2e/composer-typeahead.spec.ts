import type { Locator, Page, Request } from "@playwright/test";

import { pasteText } from "./paste-text";
import { expect, test } from "./test";
import { mockConversationDetail } from "./mock-reports";

const PUBLIC_CONVERSATION_ID = "slack:CQA123:1770000000.000100";
const PARTICIPANT_CONVERSATION_ID = "slack:CQA123:1770003600.000200";

async function openComposer(page: Page, baseURL: string, id: string) {
  await page.goto(`${baseURL}/conversations/${encodeURIComponent(id)}`);
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });
  // The editor loads after the page. A textarea stands in until then.
  await expect(composer).toHaveAttribute("contenteditable", "true");
  await composer.click();
  return composer;
}

// Type a mention and wait until the person's row can be inserted. Until
// the search for the full text answers, the menu shows the rows of the
// earlier search, and Enter or Tab on them inserts nothing.
async function typeMention(composer: Locator, text: string, person: RegExp) {
  await composer.pressSequentially(text);
  const mentions = composer.page().getByRole("listbox", { name: "Mentions" });
  await expect(mentions.getByRole("option", { name: person })).toBeVisible();
  await expect(mentions).not.toHaveAttribute("aria-busy", "true");
}

// Hold people searches. The returned function answers them and waits for
// their responses.
async function holdSearches(page: Page) {
  const held: Request[] = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/people/search?*", async (route) => {
    held.push(route.request());
    await released;
    await route.fallback();
  });
  return async () => {
    release();
    await Promise.all(held.map((request) => request.response()));
  };
}

test("text typed before the editor loads stays in the editor", async ({
  page,
  dashboard,
}) => {
  // Hold the editor chunk, so the stand-in text box takes the first keys.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/chunks/ComposerEditor-*.js", async (route) => {
    await held;
    await route.fallback();
  });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(PUBLIC_CONVERSATION_ID)}`,
  );
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });
  await composer.click();
  await composer.pressSequentially("Typed early");
  await expect(composer).not.toHaveAttribute("contenteditable", "true");

  release();
  await expect(composer).toHaveAttribute("contenteditable", "true");
  await expect(composer).toHaveText("Typed early");
  // The editor takes the focus, with the caret after the text.
  await expect(composer).toBeFocused();
  await composer.pressSequentially(", then more");
  await expect(composer).toHaveText("Typed early, then more");
});

test("@ suggests people and sends the mention as a Slack token", async ({
  page,
  dashboard,
}) => {
  const sent: string[] = [];
  const searches: (string | null)[] = [];
  await page.route("**/api/people/search?*", async (route) => {
    searches.push(
      new URL(route.request().url()).searchParams.get("conversationId"),
    );
    await route.fallback();
  });
  await page.route("**/api/conversations/*/messages", async (route) => {
    if (route.request().method() === "POST") {
      sent.push(route.request().postDataJSON().message);
    }
    await route.fallback();
  });
  const composer = await openComposer(
    page,
    dashboard.baseURL,
    PUBLIC_CONVERSATION_ID,
  );

  await composer.pressSequentially("Hi @c");
  const mentions = page.getByRole("listbox", { name: "Mentions" });
  const people = mentions.getByRole("group", { name: "People" });
  await expect(people.getByRole("option")).toHaveText([
    /Casey Nguyen/,
    /Avery Chen/,
  ]);
  await expect(
    people.getByRole("option", { name: /Casey Nguyen/ }),
  ).toHaveAttribute("aria-selected", "true");
  // The Conversations below People come from a slower search.
  await expect(mentions).not.toHaveAttribute("aria-busy", "true");

  // Arrows move the choice and wrap. Escape closes the menu.
  await composer.press("ArrowDown");
  await expect(
    people.getByRole("option", { name: /Avery Chen/ }),
  ).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowUp");
  await composer.press("ArrowUp");
  await expect(mentions.getByRole("option").last()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await composer.press("Escape");
  await expect(mentions).toBeHidden();

  // The menu stays closed until the caret leaves that reference.
  await composer.pressSequentially("h");
  await expect(people).toBeHidden();
  await composer.press("Backspace");
  await composer.press("Backspace");
  await composer.press("Backspace");
  await composer.pressSequentially("@av");
  await expect(people.getByRole("option")).toHaveText([/Avery Chen/]);
  await composer.press("Enter");
  await expect(people).toBeHidden();
  await expect(composer).toHaveText("Hi @Avery Chen ");
  await expect(composer.locator("[data-mention='U789']")).toBeVisible();

  await composer.pressSequentially("can you look?");
  await composer.press("Enter");
  await expect.poll(() => sent).toEqual(["Hi <@U789> can you look?"]);
  await expect(composer).toHaveText("");
  // The API finds people of this Conversation's Slack workspace.
  expect(new Set(searches)).toEqual(new Set([PUBLIC_CONVERSATION_ID]));
});

test("an earlier row cannot be inserted while the next search loads", async ({
  page,
  dashboard,
}) => {
  const composer = await openComposer(
    page,
    dashboard.baseURL,
    PUBLIC_CONVERSATION_ID,
  );
  await composer.pressSequentially("@av");
  const mentions = page.getByRole("listbox", { name: "Mentions" });
  await expect(
    mentions.getByRole("group", { name: "People" }).getByRole("option"),
  ).toHaveText([/Avery Chen/]);

  // The next search does not answer yet. Only the API knows whether it
  // matches Avery, by a name the menu may not show.
  const answer = await holdSearches(page);
  await composer.pressSequentially("e");
  await expect(mentions).toHaveAttribute("aria-busy", "true");
  // Neither inserts the earlier row nor sends the half-typed mention.
  await composer.press("Tab");
  await composer.press("Enter");
  await expect(composer.locator("[data-mention]")).toHaveCount(0);
  await expect(composer).toHaveText("@ave");
  await answer();
});

test("Enter and Tab wait while the first people search loads", async ({
  page,
  dashboard,
}) => {
  const sent: string[] = [];
  await page.route("**/api/conversations/*/messages", async (route) => {
    if (route.request().method() === "POST") {
      sent.push(route.request().postDataJSON().message);
    }
    await route.fallback();
  });
  // The first search does not answer yet, so there are no rows.
  const answer = await holdSearches(page);
  const composer = await openComposer(
    page,
    dashboard.baseURL,
    PUBLIC_CONVERSATION_ID,
  );
  const searched = page.waitForRequest("**/api/people/search?*");
  await composer.pressSequentially("@ca");
  await searched;
  await composer.press("Tab");
  await composer.press("Enter");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText("@ca");
  expect(sent).toEqual([]);
  await answer();
});

test("a person without a People page still has a card with Invite", async ({
  page,
  dashboard,
}) => {
  const composer = await openComposer(
    page,
    dashboard.baseURL,
    PUBLIC_CONVERSATION_ID,
  );
  await typeMention(composer, "@sam", /Sam Ortiz/);
  await composer.press("Tab");
  await composer.locator("[data-mention='U234']").hover();
  const card = page.getByRole("dialog", { name: "Sam Ortiz" });
  await expect(card.getByRole("button", { name: "Invite" })).toBeVisible();
});

test("a pasted Slack mention becomes a mention", async ({
  page,
  dashboard,
}) => {
  const composer = await openComposer(
    page,
    dashboard.baseURL,
    PUBLIC_CONVERSATION_ID,
  );
  await composer.pressSequentially("ask first");
  // A key pressed before the editor applies the typed text loses its move.
  await expect(composer).toHaveText("ask first");
  for (let step = 0; step < 6; step++) await composer.press("ArrowLeft");
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(3);
  await pasteText(page, " <@U456>");
  await expect(composer.locator("[data-mention='U456']")).toHaveText("@U456");
  // The caret stays after the mention, not at the end of the line.
  await composer.pressSequentially("!");
  await expect(composer).toHaveText("ask @U456! first");
});

test("Invite subscribes a mentioned person to a public conversation", async ({
  page,
  dashboard,
}) => {
  const invites: unknown[] = [];
  await page.route("**/api/conversations/*/invites", async (route) => {
    invites.push(route.request().postDataJSON());
    await route.fallback();
  });
  const composer = await openComposer(
    page,
    dashboard.baseURL,
    PUBLIC_CONVERSATION_ID,
  );
  await typeMention(composer, "@case", /Casey Nguyen/);
  await composer.press("Tab");
  await composer.locator("[data-mention='U456']").click();

  const card = page.getByRole("dialog", { name: "Casey Nguyen" });
  await card.getByRole("button", { name: "Invite" }).click();
  await expect(card.getByText("Subscribed")).toBeVisible();
  await expect(card.getByRole("button", { name: "Invite" })).toHaveCount(0);

  // A reopened card still shows the answer.
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await composer.locator("[data-mention='U456']").click();
  await expect(card.getByText("Subscribed")).toBeVisible();
  await expect(card.getByRole("button", { name: "Invite" })).toHaveCount(0);
  expect(invites).toEqual([{ slackUserId: "U456" }]);
});

test("Invite says when the person is already a participant", async ({
  page,
  dashboard,
}) => {
  // Only the API knows the feed subscribers.
  await page.route("**/api/conversations/*/invites", (route) =>
    route.fulfill({ json: { added: false } }),
  );
  const composer = await openComposer(
    page,
    dashboard.baseURL,
    PUBLIC_CONVERSATION_ID,
  );
  await typeMention(composer, "@case", /Casey Nguyen/);
  await composer.press("Tab");
  await composer.locator("[data-mention='U456']").click();

  const card = page.getByRole("dialog", { name: "Casey Nguyen" });
  await card.getByRole("button", { name: "Invite" }).click();
  await expect(card.getByText("Already a participant")).toBeVisible();
});

test("a person who is not a User has a card without Invite", async ({
  page,
  dashboard,
}) => {
  const composer = await openComposer(
    page,
    dashboard.baseURL,
    PUBLIC_CONVERSATION_ID,
  );
  await typeMention(composer, "@rile", /Riley Park/);
  await composer.press("Tab");
  await composer.locator("[data-mention='U345']").hover();

  const card = page.getByRole("dialog", { name: "Riley Park" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Invite" })).toHaveCount(0);
});

for (const [name, change] of [
  ["private", { visibility: "private" }],
  [
    "archived",
    { archivedAt: "2026-02-02T00:00:00.000Z", visibility: "public" },
  ],
] as const) {
  test(`a ${name} conversation's mention card has no Invite`, async ({
    page,
    dashboard,
  }) => {
    // A participant's conversation, so the composer shows.
    await page.route(
      (url) =>
        url.pathname ===
        `/api/conversations/${encodeURIComponent(PARTICIPANT_CONVERSATION_ID)}`,
      async (route) => {
        await route.fulfill({
          json: { ...(await mockConversationDetail(route)), ...change },
        });
      },
    );
    const composer = await openComposer(
      page,
      dashboard.baseURL,
      PARTICIPANT_CONVERSATION_ID,
    );
    await typeMention(composer, "@case", /Casey Nguyen/);
    await composer.press("Enter");
    await composer.locator("[data-mention='U456']").click();
    const card = page.getByRole("dialog", { name: "Casey Nguyen" });
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: "Invite" })).toHaveCount(0);
  });
}

test("$ suggests skills and inserts the skill name", async ({
  page,
  dashboard,
}) => {
  await page.route("**/api/skills", (route) =>
    route.fulfill({
      json: [
        {
          name: "triage-incident",
          description: "Triage a live incident into a suspects-first note.",
        },
        {
          name: "tpm",
          description: "Run the TPM bug digest from Linear.",
        },
      ],
    }),
  );
  const composer = await openComposer(
    page,
    dashboard.baseURL,
    PUBLIC_CONVERSATION_ID,
  );
  await composer.pressSequentially("use $t");
  const skills = page.getByRole("grid", { name: "Skills" });
  await expect(skills.getByRole("gridcell", { name: /^\$/ })).toHaveText([
    /\$triage-incident/,
    /\$tpm/,
  ]);
  await composer.press("ArrowUp");
  await expect(
    skills.getByRole("gridcell", { name: /^\$tpm/ }),
  ).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowDown");
  await composer.press("Tab");
  await expect(skills).toBeHidden();
  await expect(composer).toHaveText("use $triage-incident ");
});
