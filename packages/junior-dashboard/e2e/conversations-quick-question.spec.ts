import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { screenshot } from "./screenshot";

const conversationId = "slack:CQA123:1770003600.000200";

// Wide enough for details to open beside the chat by default.
test.use({ viewport: { height: 900, width: 1440 } });

/** Select the first words of the newest Junior reply, as a mouse drag would. */
async function selectReplyText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const replies = document.querySelectorAll(
      "[data-quick-question-message-id]",
    );
    const reply = replies[replies.length - 1]!;
    const walker = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && (node.textContent ?? "").trim().length < 12) {
      node = walker.nextNode();
    }
    node!.parentElement!.scrollIntoView({ block: "center" });
    // A scroll hides the button. Select after the scroll settles.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const text = node!.textContent!;
    const start = text.search(/\S/);
    const range = document.createRange();
    range.setStart(node!, start);
    range.setEnd(node!, start + 12);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return range.toString();
  });
}

test("asks a quick question about selected reply text", async ({
  page,
  dashboard,
}) => {
  const requests: Array<{
    messageId: string;
    messages: Array<{ role: string; text: string }>;
    quote: string;
  }> = [];
  await page.route(
    `**/api/conversations/${encodeURIComponent(conversationId)}/quick-questions`,
    async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill(
        requests.length === 1
          ? { status: 503, json: { error: "The model is busy." } }
          : { json: { text: `Answer ${requests.length - 1}.` } },
      );
    },
  );
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
  expect(requests.at(-1)).toEqual({
    messageId: requests[0]!.messageId,
    quote,
    messages: [
      { role: "user", text: "Why?" },
      { role: "assistant", text: "Answer 1." },
      { role: "user", text: "And then?" },
    ],
  });
  await screenshot(page, "conversation-quick-question-answered");

  const forks: Array<{ messageId: string }> = [];
  const firstMessages: Array<{ message: string }> = [];
  await page.route(
    `**/api/conversations/${encodeURIComponent(conversationId)}/forks`,
    async (route) => {
      forks.push(route.request().postDataJSON());
      await route.fulfill({ json: { conversationId: "local:web:qq-fork" } });
    },
  );
  await page.route(
    `**/api/conversations/${encodeURIComponent("local:web:qq-fork")}/messages`,
    async (route) => {
      firstMessages.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          conversationId: "local:web:qq-fork",
          messageId: "qq-fork-first-message",
          status: "accepted",
        },
      });
    },
  );
  await panel
    .getByRole("button", { name: "Keep as fork", exact: true })
    .click();
  await expect(page).toHaveURL(/qq-fork/);
  expect(forks[0]?.messageId).toBe(requests[0]!.messageId);
  expect(firstMessages[0]?.message).toBe(
    [
      "About this part of your reply:",
      `> ${quote}`,
      "Quick question: Why?",
      "Your answer: Answer 1.",
      "Quick question: And then?",
      "Your answer: Answer 2.",
    ].join("\n\n"),
  );
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
