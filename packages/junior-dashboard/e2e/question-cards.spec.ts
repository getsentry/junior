import type { Page } from "@playwright/test";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

// Mock Conversations with open Review items that wait on the viewer.
const ONE_QUESTION_ID = "internal:question-qa";
const THREE_QUESTIONS_ID = "internal:questions-qa";

async function openConversation(page: Page, baseURL: string, id: string) {
  await page.goto(`${baseURL}/conversations/${encodeURIComponent(id)}`);
}

/** Record the body of each Review item action that the page sends. */
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
    const question = card.getByRole("region", { name: "Question" });
    await expect(question).toContainText(
      "Roll out payments-v42 to every region?",
    );
    // As on the Inbox card, Junior's message of that Turn follows.
    await expect(
      card.getByRole("region", { name: "Junior's message" }),
    ).toContainText("I need your go-ahead before I roll out to every region.");
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

    // A click picks a choice. Only Send answers, with the note.
    const rollOut = card.getByRole("button", { name: /Roll out/ });
    const send = card.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    await rollOut.click();
    await expect(rollOut).toHaveAttribute("aria-pressed", "true");
    await card
      .getByRole("textbox", { name: "Anything else?" })
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
    // The card goes back to one line with the answer.
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
  // Enter in the note line sends it.
  const note = card.getByRole("textbox", { name: "Anything else?" });
  await note.fill("Wait for the EU team on Monday.");
  await note.press("Enter");
  await expect
    .poll(() => actions)
    .toEqual([
      {
        action: "submit",
        answer: { other: "Wait for the EU team on Monday.", values: {} },
      },
    ]);
  await expect(card).toContainText("Wait for the EU team on Monday.");
});

for (const view of [desktop, mobile]) {
  test(`the questions pill goes to each waiting question (${view.name})`, async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(view);
    // Without motion the transcript jumps, so each check sees where it ends.
    await page.emulateMedia({ reducedMotion: "reduce" });
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
      view: view.name,
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
}

test("the questions pill skips an Everyone question the viewer has not taken", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  // The list marks one of the three questions as asked of everyone.
  await page.route("**/api/review-items?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("conversationId") !== THREE_QUESTIONS_ID) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as {
      items: Array<{ assignedToEveryone?: boolean; title: string }>;
    };
    for (const item of body.items) {
      if (item.title === "Pick the billing migration window") {
        item.assignedToEveryone = true;
      }
    }
    await route.fulfill({ json: body, response });
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
