import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { screenshot } from "./screenshot";

const conversationId = "slack:CQA123:1770003600.000200";

// Wide enough for details to open beside the chat by default.
test.use({ viewport: { height: 900, width: 1440 } });

/**
 * Select text in the newest Junior reply, as a mouse drag would: 12
 * characters of its `skip`-th text, or one whole word with `word`.
 */
async function selectReplyText(
  page: Page,
  options: { skip?: number; word?: boolean } = {},
): Promise<string> {
  return page.evaluate(async ({ skip = 0, word = false }) => {
    const replies = document.querySelectorAll(
      "[data-quick-question-message-id]",
    );
    const reply = replies[replies.length - 1]!;
    const walker = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let skipped = 0;
    while (
      node &&
      ((node.textContent ?? "").trim().length < 12 || skipped++ < skip)
    ) {
      node = walker.nextNode();
    }
    node!.parentElement!.scrollIntoView({ block: "center" });
    // A scroll hides the button. Select after the scroll settles.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const text = node!.textContent!;
    const match = word ? /\p{L}{4,}/u.exec(text)! : /\S/.exec(text)!;
    const range = document.createRange();
    range.setStart(node!, match.index);
    range.setEnd(node!, match.index + (word ? match[0].length : 12));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return range.toString();
  }, options);
}

/**
 * Serve a hidden fork from the source Conversation of the mock API: the
 * history through the selected reply, then `messages`. Mocks run no model.
 */
async function serveQuickQuestionFork(
  page: Page,
  forks: ReadonlyArray<{ messageId: string }>,
  messages: Array<{ role: "assistant" | "user"; text: string }>,
) {
  const source = `/api/conversations/${encodeURIComponent(conversationId)}`;
  const fork = `/api/conversations/${encodeURIComponent(forkId)}`;
  await page.route(
    (url) => url.pathname.startsWith(fork),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const url = new URL(route.request().url());
      const response = await route.fetch({
        url: url.toString().replace(fork, source),
      });
      if (url.pathname !== fork) return route.fulfill({ response });
      const detail = await response.json();
      const reply = detail.events.findIndex(
        (event: { data: { messageId?: string } }) =>
          event.data.messageId === forks[0]!.messageId,
      );
      detail.events = detail.events.slice(0, reply + 1);
      const last = detail.events.at(-1);
      detail.conversationId = forkId;
      detail.status = "completed";
      detail.events.push(
        ...messages.map((message, index) => ({
          seq: last.seq + index + 1,
          createdAt: last.createdAt,
          data: {
            type: "message",
            messageId: `qq-${index}`,
            role: message.role,
            text: message.text,
          },
        })),
      );
      await route.fulfill({ json: detail });
    },
  );
}

const forkId = "local:web:qq-fork";

test("asks a quick question about selected reply text", async ({
  page,
  dashboard,
}) => {
  const forks: Array<{
    idempotencyKey: string;
    messageId: string;
    quickQuestion: { quote: string };
  }> = [];
  await page.route(
    `**/api/conversations/${encodeURIComponent(conversationId)}/forks`,
    async (route) => {
      forks.push(route.request().postDataJSON());
      await route.fulfill(
        forks.length === 1
          ? { status: 503, json: { error: "The model is busy." } }
          : { json: { conversationId: forkId } },
      );
    },
  );
  const messages: Array<{ role: "assistant" | "user"; text: string }> = [];
  await page.route(
    `**/api/conversations/${encodeURIComponent(forkId)}/messages`,
    async (route) => {
      const { message } = route.request().postDataJSON();
      messages.push(
        { role: "user", text: message },
        { role: "assistant", text: `Answer ${messages.length / 2 + 1}.` },
      );
      await route.fulfill({
        json: {
          conversationId: forkId,
          messageId: `qq-message-${messages.length}`,
          status: "accepted",
        },
      });
    },
  );
  await serveQuickQuestionFork(page, forks, messages);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  await expect(
    page.locator("[data-quick-question-message-id]").first(),
  ).toBeVisible();

  const quote = await selectReplyText(page);
  await page
    .getByRole("button", { name: "Quick question", exact: true })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Quick question",
    exact: true,
  });
  await expect(panel.locator("blockquote")).toHaveText(quote);
  await expect(
    panel.getByRole("button", { name: "Explain this", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Keep as fork", exact: true }),
  ).toBeDisabled();
  await screenshot(page, "conversation-quick-question");

  await panel
    .getByRole("button", { name: "Explain this", exact: true })
    .click();
  await expect(panel.getByText("The model is busy.")).toBeVisible();
  const composer = panel.getByRole("textbox", { name: "Quick question" });
  await composer.fill("Why?");
  await composer.press("Enter");
  await expect(panel.getByText("Answer 1.")).toBeVisible();
  await expect(composer).toHaveAttribute("placeholder", "Ask a follow-up…");
  await composer.fill("And then?");
  await composer.press("Enter");
  await expect(panel.getByText("Answer 2.")).toBeVisible();
  // The retry finds the same fork. Follow-ups go to that fork.
  expect(forks).toEqual([
    {
      idempotencyKey: forks[0]!.idempotencyKey,
      messageId: forks[0]!.messageId,
      quickQuestion: { quote },
    },
    forks[0],
  ]);
  expect(messages.filter((message) => message.role === "user")).toEqual([
    { role: "user", text: "Why?" },
    { role: "user", text: "And then?" },
  ]);
  await screenshot(page, "conversation-quick-question-answered");

  let kept = 0;
  await page.route(
    `**/api/conversations/${encodeURIComponent(forkId)}/quick-question/keep`,
    async (route) => {
      kept += 1;
      await route.fulfill({ json: { conversationId: forkId } });
    },
  );
  await panel
    .getByRole("button", { name: "Keep as fork", exact: true })
    .click();
  await expect(page).toHaveURL(/qq-fork/);
  expect(kept).toBe(1);
});

test("closes a quick question and shows details again", async ({
  page,
  dashboard,
}) => {
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  const details = page.getByRole("complementary", {
    name: "Conversation details",
  });
  await expect(details).toBeVisible();
  await expect(
    page.locator("[data-quick-question-message-id]").first(),
  ).toBeVisible();
  await selectReplyText(page);
  await page
    .getByRole("button", { name: "Quick question", exact: true })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Quick question",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(details).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(details).toBeVisible();
});

test("quotes selected reply text in the message box", async ({
  page,
  dashboard,
}) => {
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  await expect(
    page.locator("[data-quick-question-message-id]").first(),
  ).toBeVisible();
  const respond = page.getByRole("button", { name: "Respond", exact: true });
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });

  // One word is a double-click or a lookup, not a quote.
  await selectReplyText(page, { word: true });
  await expect(respond).toBeHidden();

  await composer.fill("Thanks.");
  const first = await selectReplyText(page);
  await screenshot(page, "conversation-selection-respond", { view: "desktop" });
  await respond.click();
  await expect(composer).toBeFocused();
  await composer.pressSequentially("Why?");
  const second = await selectReplyText(page, { skip: 1 });
  await respond.click();
  await expect(composer).toHaveValue(
    `Thanks.\n\n> ${first}\n\nWhy?\n\n> ${second}\n\n`,
  );
  await screenshot(page, "conversation-selection-respond-quoted", {
    view: "desktop",
  });
});
