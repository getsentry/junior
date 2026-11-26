import { conversationMenuRow } from "./conversationMenu";
import { pickOption } from "./pick-option";
import { desktop, mobile, screenshot } from "./screenshot";
import type { Locator } from "@playwright/test";
import { mockConversationDetail } from "./mock-reports";
import { expect, test } from "./test";

// A public Conversation.
const PUBLIC_CONVERSATION_ID = "slack:CQA123:1770000000.000100";
// The viewer takes part, so the page shows its details.
const PARTICIPANT_CONVERSATION_ID = "slack:CQA123:1770003600.000200";

const conversationPath = (id: string) =>
  `/conversations/${encodeURIComponent(id)}`;

/** Type into the picker and wait until its search answers. */
async function searchFor(scope: Locator, text: string) {
  await scope.getByRole("combobox").fill(text);
  await expect(
    scope.getByRole("listbox", { includeHidden: true }),
  ).toHaveAttribute("aria-busy", "false");
}

test("Invite adds the people that the picker finds to a public conversation", async ({
  dashboard,
  page,
}) => {
  const invites: unknown[] = [];
  await page.route("**/api/conversations/*/invites", async (route) => {
    invites.push(route.request().postDataJSON());
    await route.fallback();
  });
  await page.setViewportSize(desktop);
  await page.goto(
    `${dashboard.baseURL}${conversationPath(PUBLIC_CONVERSATION_ID)}`,
  );
  const participants = page
    .getByRole("complementary", { exact: true, name: "Conversation details" })
    .getByRole("region", { name: "Participants" });
  await participants.getByRole("button", { name: "Invite" }).click();
  const search = participants.getByRole("combobox", { name: "Invite people" });
  await expect(search).toBeFocused();

  await searchFor(participants, "nobody");
  await expect(participants.getByRole("status")).toHaveText("No people match.");
  // Arrow keys move between people, and Enter chooses one.
  await searchFor(participants, "e");
  await expect(
    participants.getByRole("option", { name: /Avery Chen/ }),
  ).toHaveAttribute("aria-selected", "true");
  // ArrowUp wraps to the last person.
  await search.press("ArrowUp");
  await expect(
    participants.getByRole("option", { name: /Morgan Lee/ }),
  ).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowDown");
  await search.press("ArrowDown");
  await expect(
    participants.getByRole("option", { name: /Casey Nguyen/ }),
  ).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
  const chosen = participants.getByRole("list", { name: "Chosen people" });
  await expect(chosen.getByRole("listitem")).toHaveText(["Casey Nguyen"]);
  await expect(search).toHaveValue("");

  // Backspace in an empty box removes the last chosen person.
  await searchFor(participants, "ave");
  await pickOption(participants.getByRole("option", { name: /Avery Chen/ }));
  await expect(chosen.getByRole("listitem")).toHaveText([
    "Casey Nguyen",
    "Avery Chen",
  ]);
  await search.press("Backspace");
  await expect(chosen.getByRole("listitem")).toHaveText(["Casey Nguyen"]);

  await searchFor(participants, "ave");
  await expect(
    participants.getByRole("option", { name: /Avery Chen/ }),
  ).toBeVisible();
  await screenshot(page, "people-picker-invite", {
    lightTheme: true,
    target: participants,
    view: "desktop",
  });
  // Escape clears the search.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(participants.getByRole("option")).toHaveCount(0);

  const invited = page.waitForResponse("**/api/conversations/*/invites");
  await participants
    .getByRole("button", { exact: true, name: "Invite" })
    .click();
  await invited;
  await expect(search).toHaveCount(0);
  expect(invites).toEqual([{ slackUserId: "U456" }]);
});

test("the picker fits a phone's details sheet", async ({ dashboard, page }) => {
  await page.setViewportSize(mobile);
  await page.goto(
    `${dashboard.baseURL}${conversationPath(PUBLIC_CONVERSATION_ID)}`,
  );
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Conversation details").click();
  const details = page.getByRole("dialog", { name: "Conversation details" });
  const participants = details.getByRole("region", { name: "Participants" });
  await participants.getByRole("button", { name: "Invite" }).click();
  const search = participants.getByRole("combobox", { name: "Invite people" });
  await searchFor(participants, "case");
  await expect(
    participants.getByRole("option", { name: /Casey Nguyen/ }),
  ).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
  await searchFor(participants, "e");
  await expect(
    participants.getByRole("option", { name: /Avery Chen/ }),
  ).toBeVisible();
  await screenshot(page, "people-picker-invite", {
    lightTheme: true,
    view: "mobile",
  });
});

for (const [name, change] of [
  // The API refuses Invite here, so the detail has no `canInvite`.
  ["Slack-backed private", { canInvite: undefined, visibility: "private" }],
  [
    "archived",
    { archivedAt: "2026-02-02T00:00:00.000Z", visibility: "public" },
  ],
] as const) {
  test(`a ${name} conversation offers no Invite`, async ({
    dashboard,
    page,
  }) => {
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
    await page.setViewportSize(desktop);
    await page.goto(
      `${dashboard.baseURL}${conversationPath(PARTICIPANT_CONVERSATION_ID)}`,
    );
    const participants = page
      .getByRole("complementary", { exact: true, name: "Conversation details" })
      .getByRole("region", { name: "Participants" });
    await expect(
      participants.getByRole("group", { name: /Conversation participants/ }),
    ).toBeVisible();
    await expect(
      participants.getByRole("button", { name: "Invite" }),
    ).toHaveCount(0);
  });
}
