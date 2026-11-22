import type { Page } from "@playwright/test";

import { expect, test } from "./test";

const CONVERSATION_ID = "slack:CQA123:1770000000.000100";

async function openComposer(page: Page, baseURL: string) {
  await page.goto(
    `${baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });
  // The editor loads after the page. A textarea stands in until then.
  await expect(composer).toHaveAttribute("contenteditable", "true");
  await composer.click();
  return composer;
}

test("Markdown markers show only while the caret is at their span", async ({
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
  const composer = await openComposer(page, dashboard.baseURL);
  await composer.pressSequentially("Ship **this** now");
  const markers = composer.getByText("**", { exact: true });
  const bold = composer.getByRole("strong").filter({ hasText: /^this$/ });
  await expect(bold).toHaveCount(1);
  await expect(markers).toHaveCount(2);
  await expect(markers.first()).toBeHidden();

  // Back to the edge of the span: its markers show, and it stays bold.
  for (let step = 0; step < 4; step++) await page.keyboard.press("ArrowLeft");
  await expect(markers.first()).toBeVisible();
  await expect(markers.last()).toBeVisible();
  await expect(bold).toHaveCount(1);

  await page.keyboard.press("Home");
  await expect(markers.first()).toBeHidden();

  // The message is the Markdown as typed.
  await page.keyboard.press("Enter");
  await expect.poll(() => sent).toEqual(["Ship **this** now"]);
});

test("deleting a marker turns its span back into text", async ({
  page,
  dashboard,
}) => {
  const composer = await openComposer(page, dashboard.baseURL);
  await composer.pressSequentially("run `make test`");
  await expect(composer.getByRole("code")).toHaveText("make test");
  await page.keyboard.press("Backspace");
  await expect(composer).toHaveText("run `make test");
  await expect(composer.getByRole("code")).toHaveCount(0);
  await expect(composer.getByText("`", { exact: true })).toHaveCount(0);
});

test("arrow keys reach a span's edge from either side, then move one character", async ({
  page,
  dashboard,
}) => {
  const composer = await openComposer(page, dashboard.baseURL);
  await composer.pressSequentially("a **b** c");

  // From the left, over the opening and closing markers.
  await page.keyboard.press("Home");
  for (let step = 0; step < 7; step++) await page.keyboard.press("ArrowRight");
  await page.keyboard.type("X");
  await expect(composer).toHaveText("a **b**X c");

  // From the right, the caret stops outside the hidden closing marker.
  await page.keyboard.press("End");
  for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("Y");
  await expect(composer).toHaveText("a **b**YX c");

  // Undo gives back the text before the last edit.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(composer).toHaveText("a **b**X c");
});
