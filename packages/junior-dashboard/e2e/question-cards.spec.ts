import type { Page } from "@playwright/test";
import { openAsk } from "./askSheet";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";
import { mockInboxItemList } from "./mock-reports";

// Mock Conversations with open Inbox items that wait on the viewer.
const ONE_QUESTION_ID = "internal:question-qa";
const THREE_QUESTIONS_ID = "internal:questions-qa";

async function openConversation(page: Page, baseURL: string, id: string) {
  await page.goto(`${baseURL}/conversations/${encodeURIComponent(id)}`);
}

/** Record the body of each Inbox item action that the page sends. */
function recordActions(page: Page) {
  const actions: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/actions")) {
      actions.push(request.postDataJSON());
    }
  });
  return actions;
}

for (const view of [desktop, mobile]) {
  test(`a question shows in the transcript, and a pick waits for Send (${view.name})`, async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(view);
    const actions = recordActions(page);
    await openConversation(page, dashboard.baseURL, ONE_QUESTION_ID);

    const card = page.getByRole("region", {
      name: "Asked Approve the payments-v42 rollout",
    });
    await expect(card).toContainText("Waiting on you");
    if (view === desktop) {
      // The answered question above reads its closed item after the list,
      // and its row then grows. A click while the transcript follows that
      // growth finds a moving button, and Playwright's retry scrolls the
      // button to the bottom edge, which leaves the latest message. A phone
      // shows the form in a sheet, out of the transcript.
      await expect(
        page.getByRole("region", { name: "Asked Pick the canary region" }),
      ).toBeVisible();
    }
    // Nothing docks over the message box, and nothing takes the focus.
    await expect(page.getByRole("region", { name: /^Question:/ })).toHaveCount(
      0,
    );
    const composer = page.getByRole("textbox", {
      name: "Continue this conversation",
    });
    await expect(composer).toBeVisible();
    await expect(composer).not.toBeFocused();
    expect(
      await card.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(false);
    // A card in full view needs no pill.
    await card.scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", { name: /questions? waiting$/ }),
    ).toHaveCount(0);

    // A phone shows the card as one line, and a tap opens the ask in a
    // sheet.
    const ask = await openAsk(card, view === mobile);
    const question = ask.getByRole("region", { name: "Question" });
    await expect(question).toContainText(
      "Roll out payments-v42 to every region?",
    );
    // Junior's message of that Turn is right above the card in the
    // transcript, so the card does not show it again. A phone sheet covers
    // the transcript, so the sheet shows it.
    await expect(
      ask.getByRole("region", { name: "Junior's message" }),
    ).toHaveCount(view === mobile ? 1 : 0);
    await expect(
      page.getByText("I need your go-ahead before I roll out to every region."),
    ).toHaveCount(view === mobile ? 2 : 1);

    // A click picks a choice. Only Send answers, with the note.
    const rollOut = ask.getByRole("button", { name: /Roll out/ });
    const send = ask.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    await rollOut.click();
    await expect(rollOut).toHaveAttribute("aria-pressed", "true");
    await ask
      .getByRole("textbox", { name: "Additional notes" })
      .fill("Start with us-east-1.");
    expect(actions).toEqual([]);
    await screenshot(page, "conversation-question-card", {
      lightTheme: true,
      view: view.name,
    });
    await send.click();
    await expect
      .poll(() => actions)
      .toEqual([
        {
          action: "submit",
          answer: {
            other: "Start with us-east-1.",
            values: { go: ["Roll out"] },
          },
        },
      ]);
    // The card goes back to one line with the answer, and a sheet closes.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(card.getByRole("region", { name: "Question" })).toHaveCount(0);
    await expect(card).toContainText("Answered");
    await expect(card).toContainText("Roll out");
  });
}

test("a second click takes the pick back, and a note alone answers", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  const actions = recordActions(page);
  await openConversation(page, dashboard.baseURL, ONE_QUESTION_ID);
  const card = page.getByRole("region", {
    name: "Asked Approve the payments-v42 rollout",
  });
  const hold = card.getByRole("button", { name: "Hold", exact: true });
  await hold.click();
  await expect(hold).toHaveAttribute("aria-pressed", "true");
  await hold.click();
  await expect(hold).toHaveAttribute("aria-pressed", "false");
  const send = card.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  // Enter adds a line to the notes. Cmd or Ctrl with Enter sends them.
  const note = card.getByRole("textbox", { name: "Additional notes" });
  await note.fill("Wait for the EU team on Monday.");
  await note.press("Enter");
  await note.pressSequentially("Then roll out.");
  expect(actions).toEqual([]);
  await note.press("ControlOrMeta+Enter");
  await expect
    .poll(() => actions)
    .toEqual([
      {
        action: "submit",
        answer: {
          other: "Wait for the EU team on Monday.\nThen roll out.",
          values: {},
        },
      },
    ]);
  await expect(card).toContainText("Wait for the EU team on Monday.");
});

test("Other takes the reader's own answer in place of a pick", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  const actions = recordActions(page);
  await openConversation(page, dashboard.baseURL, ONE_QUESTION_ID);
  const card = page.getByRole("region", {
    name: "Asked Approve the payments-v42 rollout",
  });
  const hold = card.getByRole("button", { name: "Hold", exact: true });
  await hold.click();
  await expect(hold).toHaveAttribute("aria-pressed", "true");
  // Writing an own answer takes the pick back, as one question has one
  // answer.
  await card
    .getByRole("textbox", { name: /: Other$/ })
    .fill("Roll out to the EU first.");
  await expect(hold).toHaveAttribute("aria-pressed", "false");
  await card.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => actions)
    .toEqual([
      {
        action: "submit",
        answer: {
          custom: { go: "Roll out to the EU first." },
          values: {},
        },
      },
    ]);
  await expect(card).toContainText("Roll out to the EU first.");
});

// A phone shows each card as one line, so this short transcript fits on
// the screen there and needs no pill.
test("the questions pill goes to each waiting question", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await openConversation(page, dashboard.baseURL, THREE_QUESTIONS_ID);
  const card = (title: string) =>
    page.getByRole("region", { name: `Asked ${title}` });
  const windowCard = card("Pick the billing migration window");
  const pill = page.getByRole("button", { name: "3 questions waiting" });
  await expect(pill).toBeVisible();
  // The transcript opens at the latest message, not at a question.
  await expect(windowCard).not.toBeInViewport();
  await screenshot(page, "conversation-questions-pill", {
    lightTheme: true,
    view: desktop.name,
  });

  // The pill shows the oldest card not in full view.
  await pill.click();
  await expect(windowCard).toBeInViewport();
  // Only the transcript scrolls, not the page.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // An answer leaves two, and the pill counts them.
  await windowCard.getByRole("button", { name: /Tuesday 14:00 UTC/ }).click();
  await windowCard.getByRole("button", { name: "Send", exact: true }).click();
  await expect(windowCard).toContainText("Answered");
  await expect(
    page.getByRole("button", { name: "2 questions waiting" }),
  ).toBeVisible();
});

test("the questions pill skips an Everyone question the viewer has not taken", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  // The list marks one of the three questions as asked of everyone.
  await page.route("**/api/inbox-items?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("conversationId") !== THREE_QUESTIONS_ID) {
      await route.fallback();
      return;
    }
    const body = await mockInboxItemList(route);
    await route.fulfill({
      json: {
        items: body.items.map((item) =>
          item.title === "Pick the billing migration window"
            ? { ...item, assignedToEveryone: true }
            : item,
        ),
      },
    });
  });
  await openConversation(page, dashboard.baseURL, THREE_QUESTIONS_ID);
  await expect(
    page.getByRole("button", { name: "2 questions waiting" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "3 questions waiting" }),
  ).toHaveCount(0);
});

test("a typed message still answers the question", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await openConversation(page, dashboard.baseURL, ONE_QUESTION_ID);
  const card = page.getByRole("region", {
    name: "Asked Approve the payments-v42 rollout",
  });
  await expect(card.getByRole("region", { name: "Question" })).toBeVisible();
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });
  await composer.fill("Hold until Monday, the EU team is out.");
  await composer.press("Enter");
  await expect(card.getByRole("region", { name: "Question" })).toHaveCount(0);
  await expect(card).toContainText("Hold until Monday, the EU team is out.");
});

test("a message asks before it drops a pick that is not sent", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  const actions = recordActions(page);
  await openConversation(page, dashboard.baseURL, ONE_QUESTION_ID);
  const card = page.getByRole("region", {
    name: "Asked Approve the payments-v42 rollout",
  });
  await card.getByRole("button", { name: "Hold", exact: true }).click();
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });
  await composer.fill("Friday works.");
  await composer.press("Enter");
  const confirm = page.getByRole("alertdialog", {
    name: "Send without your answers?",
  });
  await expect(confirm).toContainText("Approve the payments-v42 rollout");
  // Go back keeps the draft and the pick.
  await confirm.getByRole("button", { name: "Go back" }).click();
  await expect(confirm).toBeHidden();
  await expect(composer).toHaveText("Friday works.", { useInnerText: true });
  await expect(
    card.getByRole("button", { name: "Hold", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(actions).toEqual([]);
});

test("Respond quotes into the message box beside a question", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await openConversation(page, dashboard.baseURL, ONE_QUESTION_ID);
  const card = page.getByRole("region", {
    name: "Asked Approve the payments-v42 rollout",
  });
  await expect(card.getByRole("region", { name: "Question" })).toBeVisible();

  // Select the start of Junior's last reply, as a reader's drag does.
  const reply = page.locator("[data-quick-question-message-id]").last();
  await reply.scrollIntoViewIfNeeded();
  const quote = await reply.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && (node.textContent ?? "").trim().length < 12) {
      node = walker.nextNode();
    }
    const selection = window.getSelection();
    if (!node || !selection) throw new Error("The reply has no text.");
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 23);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return range.toString();
  });
  await page.getByRole("button", { name: "Respond", exact: true }).click();

  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });
  await expect(composer).toBeFocused();
  await expect.poll(() => composer.innerText()).toContain(`> ${quote}`);
  await expect(card.getByRole("region", { name: "Question" })).toBeVisible();
});
