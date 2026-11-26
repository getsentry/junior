import type { Page } from "@playwright/test";

import { holdRequests } from "./harness";
import { expect, test } from "./test";

const CONVERSATION_ID = "slack:CQA123:1770000000.000100";
const EDITOR_CHUNK = "**/chunks/ComposerEditor-*.js";

// The textarea that stands in until the editor chunk loads.
async function openStandIn(page: Page, baseURL: string) {
  await page.goto(
    `${baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });
  await composer.click();
  await expect(composer).not.toHaveAttribute("contenteditable", "true");
  return composer;
}

test("Enter in the stand-in sends the message", async ({ page, dashboard }) => {
  const sent: string[] = [];
  await holdRequests(page, EDITOR_CHUNK);
  await page.route("**/api/conversations/*/messages", async (route) => {
    if (route.request().method() === "POST") {
      sent.push(route.request().postDataJSON().message);
    }
    await route.fallback();
  });
  const composer = await openStandIn(page, dashboard.baseURL);
  await composer.pressSequentially("Sent early");
  await composer.press("Enter");
  await expect.poll(() => sent).toEqual(["Sent early"]);
  await expect(composer).toHaveValue("");
});

test("the stand-in grows with its text", async ({ page, dashboard }) => {
  await holdRequests(page, EDITOR_CHUNK);
  const composer = await openStandIn(page, dashboard.baseURL);
  const scrolls = () =>
    composer.evaluate((field) => field.scrollHeight > field.clientHeight);
  await composer.pressSequentially("one");
  for (const line of ["two", "three"]) {
    await composer.press("Shift+Enter");
    await composer.pressSequentially(line);
  }
  await expect.poll(scrolls).toBe(false);
});

test("a file pasted into the stand-in is attached", async ({
  page,
  dashboard,
}) => {
  await holdRequests(page, EDITOR_CHUNK);
  await openStandIn(page, dashboard.baseURL);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  });
  await expect(
    page.getByRole("button", { name: "Remove notes.txt" }),
  ).toBeVisible();
});

test("an editor chunk that fails to load is loaded again", async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  let failures = 0;
  await page.route(EDITOR_CHUNK, async (route) => {
    if (failures === 0) {
      failures += 1;
      await route.abort();
      return;
    }
    await route.fallback();
  });
  const composer = await openStandIn(page, dashboard.baseURL);
  await expect.poll(() => failures).toBe(1);
  await page.clock.fastForward(30_000);
  await expect(composer).toHaveAttribute("contenteditable", "true");
});

test("an editor chunk whose error names no URL is loaded again", async ({
  page,
  dashboard,
}) => {
  // Safari's import error names no URL. A chunk that throws when it runs
  // gives Chromium such an error too, and the browser keeps that failure.
  await page.clock.install();
  let failures = 0;
  await page.route(EDITOR_CHUNK, async (route) => {
    if (failures === 0) {
      failures += 1;
      await route.fulfill({
        body: "throw new Error('broken chunk');",
        contentType: "text/javascript",
      });
      return;
    }
    await route.fallback();
  });
  const composer = await openStandIn(page, dashboard.baseURL);
  await expect.poll(() => failures).toBe(1);
  await page.clock.fastForward(30_000);
  await expect(composer).toHaveAttribute("contenteditable", "true");
});
