import type { Page } from "@playwright/test";

import { expect, test } from "./test";

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
  const people = page.getByRole("listbox", { name: "People" });
  await expect(people.getByRole("option")).toHaveText([
    /Casey Nguyen/,
    /Avery Chen/,
  ]);
  await expect(
    people.getByRole("option", { name: /Casey Nguyen/ }),
  ).toHaveAttribute("aria-selected", "true");

  // Arrows move the choice and wrap. Escape closes the menu.
  await composer.press("ArrowDown");
  await expect(
    people.getByRole("option", { name: /Avery Chen/ }),
  ).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowDown");
  await expect(
    people.getByRole("option", { name: /Casey Nguyen/ }),
  ).toHaveAttribute("aria-selected", "true");
  await composer.press("Escape");
  await expect(people).toBeHidden();

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
  const people = page.getByRole("listbox", { name: "People" });
  await expect(people.getByRole("option")).toHaveText([/Avery Chen/]);

  // The next search does not answer yet. Only the API knows whether it
  // matches Avery, by a name the menu may not show.
  await page.route("**/api/people/search?*", () => {});
  await composer.pressSequentially("e");
  await expect(people).toBeHidden();
  await composer.press("Tab");
  await expect(composer.locator("[data-mention]")).toHaveCount(0);
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
  await composer.pressSequentially("@sam");
  await expect(page.getByRole("option", { name: /Sam Ortiz/ })).toBeVisible();
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
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "ask <@U456> first");
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  });
  await expect(composer.locator("[data-mention='U456']")).toHaveText("@U456");
  await expect(composer).toHaveText("ask @U456 first");
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
  await composer.pressSequentially("@case");
  await expect(
    page.getByRole("option", { name: /Casey Nguyen/ }),
  ).toBeVisible();
  await composer.press("Tab");
  await composer.locator("[data-mention='U456']").click();

  const card = page.getByRole("dialog", { name: "Casey Nguyen" });
  await card.getByRole("button", { name: "Invite" }).click();
  await expect(card.getByText("Subscribed")).toBeVisible();
  await expect(card.getByRole("button", { name: "Invite" })).toHaveCount(0);
  expect(invites).toEqual([{ slackUserId: "U456" }]);
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
        const response = await route.fetch();
        const json = await response.json();
        await route.fulfill({
          response,
          json: { ...json, ...change },
        });
      },
    );
    const composer = await openComposer(
      page,
      dashboard.baseURL,
      PARTICIPANT_CONVERSATION_ID,
    );
    await composer.pressSequentially("@case");
    await expect(
      page.getByRole("option", { name: /Casey Nguyen/ }),
    ).toBeVisible();
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
