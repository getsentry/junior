import type { Page } from "@playwright/test";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

// Mock Conversations with open Review items that wait on the viewer.
const ONE_QUESTION_ID = "internal:question-qa";
const THREE_QUESTIONS_ID = "internal:questions-qa";

async function openConversation(page: Page, baseURL: string, id: string) {
  await page.goto(`${baseURL}/conversations/${encodeURIComponent(id)}`);
}

for (const view of [desktop, mobile]) {
  test(`asks the open question above the message box (${view.name})`, async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(view);
    await openConversation(page, dashboard.baseURL, ONE_QUESTION_ID);

    const question = page.getByRole("region", {
      name: "Question: Approve the payments-v42 rollout",
    });
    await expect(question).toBeInViewport();
    // The message box stays: a typed message also answers the question.
    const composer = page.getByRole("textbox", {
      name: "Continue this conversation",
    });
    await expect(composer).toBeVisible();
    await expect(composer).toHaveAttribute(
      "placeholder",
      "Or type your answer…",
    );
    // The transcript keeps a one-line record of the ask.
    const record = page.getByRole("region", {
      name: "Asked Approve the payments-v42 rollout",
    });
    await expect(record).toContainText("Waiting on you");
    // An earlier answer shows on its record.
    await expect(
      page.getByRole("region", { name: "Asked Pick the canary region" }),
    ).toContainText("us-east-1, it has the least traffic right now.");
    await screenshot(page, "conversation-question", {
      lightTheme: true,
      view: view.name,
    });

    await question.getByRole("button", { name: /Roll out/ }).click();
    await expect(question).toHaveCount(0);
    await expect(record).toContainText("Roll out");
    await expect(composer).toHaveAttribute("placeholder", "Message Junior…");
    await screenshot(page, "conversation-question-answered", {
      view: view.name,
    });
  });
}

test("steps through several questions with the keyboard", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  const actions: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/actions")) {
      actions.push(request.postDataJSON());
    }
  });
  await openConversation(page, dashboard.baseURL, THREE_QUESTIONS_ID);

  const question = page.getByRole("region", { name: /^Question:/ });
  await expect(question).toContainText("1 of 3", { useInnerText: true });
  await expect(
    question.getByRole("heading", {
      name: "Pick the billing migration window",
    }),
  ).toBeVisible();
  await question.getByRole("button", { name: "Next question" }).click();
  await expect(
    question.getByRole("heading", { name: "Choose the first migration batch" }),
  ).toBeVisible();
  await expect(question).toContainText("2 of 3", { useInnerText: true });
  await question.getByRole("checkbox", { name: /invoices/ }).check();
  await question.getByRole("textbox", { name: /On-call owner/ }).fill("Riley");
  // A step away and back keeps the picks and the text.
  await question.getByRole("button", { name: "Next question" }).click();
  await expect(question).toContainText("3 of 3", { useInnerText: true });
  await question.getByRole("button", { name: "Previous question" }).click();
  await expect(
    question.getByRole("checkbox", { name: /invoices/ }),
  ).toBeChecked();
  await expect(
    question.getByRole("textbox", { name: /On-call owner/ }),
  ).toHaveValue("Riley");
  await screenshot(page, "conversation-question-stepper", {
    lightTheme: true,
    view: "desktop",
  });

  // A number key answers the shown question. The oldest open question shows
  // next and keeps focus, with its picks.
  await question.getByRole("button", { name: "Previous question" }).click();
  await expect(question).toContainText("1 of 3", { useInnerText: true });
  await question.getByRole("heading").click();
  await page.keyboard.press("2");
  await expect(question).toContainText("1 of 2", { useInnerText: true });
  await expect(question).toBeFocused();
  await expect(
    question.getByRole("checkbox", { name: /invoices/ }),
  ).toBeChecked();

  // The form has no note and no Send of its own: the message box sends the
  // picks, then the typed words, which answer another question.
  await expect(
    question.getByRole("textbox", { name: /Anything else/ }),
  ).toHaveCount(0);
  await expect(question.getByRole("button", { name: "Send" })).toHaveCount(0);
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });
  await composer.fill("Write off the negative invoices.");
  await screenshot(page, "conversation-question-picks-and-text", {
    view: "desktop",
  });
  await composer.press("Enter");
  await expect(question).toHaveCount(0);
  await expect(composer).toHaveValue("");
  expect(actions).toEqual([
    { action: "submit", answer: { values: { window: ["Tuesday 14:00 UTC"] } } },
    {
      action: "submit",
      answer: { values: { owner: ["Riley"], tables: ["invoices"] } },
    },
  ]);
  await expect(
    page.getByRole("region", { name: "Asked Handle the negative invoices" }),
  ).toContainText("Write off the negative invoices.");
});

test("a typed message answers the question", async ({ dashboard, page }) => {
  await page.setViewportSize(desktop);
  await openConversation(page, dashboard.baseURL, ONE_QUESTION_ID);
  const question = page.getByRole("region", {
    name: "Question: Approve the payments-v42 rollout",
  });
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });

  // A typed key in the question starts the answer in the message box.
  await question.getByRole("heading").click();
  await expect(question).toBeFocused();
  await page.keyboard.type("Hold");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("Hold");
  await composer.pressSequentially(" until Monday, the EU team is out.");
  await screenshot(page, "conversation-question-typed", { view: "desktop" });
  await composer.press("Enter");

  await expect(question).toHaveCount(0);
  await expect(
    page.getByRole("region", {
      name: "Asked Approve the payments-v42 rollout",
    }),
  ).toContainText("Hold until Monday, the EU team is out.");
});

test("Respond quotes into the message box under a question", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await openConversation(page, dashboard.baseURL, ONE_QUESTION_ID);
  const question = page.getByRole("region", { name: /^Question:/ });
  await expect(question).toBeVisible();

  const quote = await page.evaluate(async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 200));
    const range = document.createRange();
    range.setStart(node!, 0);
    range.setEnd(node!, 23);
    const selection = window.getSelection()!;
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
  await expect.poll(() => composer.inputValue()).toContain(`> ${quote}`);
  await expect(question).toBeVisible();
});
