import type { Page } from "@playwright/test";

import { conversationMenuRow, viewAsParticipant } from "./conversationMenu";
import { mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

const CONVERSATION_PATH = `/conversations/${encodeURIComponent(
  "slack:CQA123:1770003600.000200",
)}`;
const TITLE = "Investigate checkout latency";

/** Collect the bodies of the page's rename requests. */
function recordRenames(page: Page): unknown[] {
  const bodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith("/title")) {
      bodies.push(request.postDataJSON());
    }
  });
  return bodies;
}

/**
 * Open Rename from the Conversation menu, the only way to edit the title.
 * The new UI shows that menu as a bottom sheet on a phone.
 */
async function openRename(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Rename").click();
}

test("renames a conversation from the menu", async ({ page, dashboard }) => {
  await viewAsParticipant(page);
  const renames = recordRenames(page);
  await page.goto(`${dashboard.baseURL}${CONVERSATION_PATH}`);
  const title = page.getByRole("heading", { name: TITLE });
  const field = page.getByRole("textbox", { name: "Conversation title" });
  await expect(title).toBeVisible();
  // The title is text, not a control that a stray click or tap edits.
  await expect(title.getByRole("button")).toHaveCount(0);
  await screenshot(page, "conversation-title", { lightTheme: true });

  await openRename(page);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(TITLE);
  // The field stays open after the menu closes, so typing reaches it.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await field.fill("Checkout latency notes");
  await screenshot(page, "conversation-title-editing", {
    lightTheme: true,
    view: "desktop",
  });
  // Escape cancels.
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(title).toBeVisible();

  // An empty title does not save.
  await openRename(page);
  await field.fill("   ");
  await field.press("Enter");
  await expect(title).toBeVisible();

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith("/title"),
  );
  await openRename(page);
  await page.keyboard.type("  Checkout latency follow-up ");
  await page.keyboard.press("Enter");
  expect((await saved).ok()).toBe(true);
  await expect(
    page.getByRole("heading", { name: "Checkout latency follow-up" }),
  ).toBeVisible();
  expect(renames).toEqual([{ title: "Checkout latency follow-up" }]);
});

test("a failed rename on a phone keeps the old title", async ({
  page,
  dashboard,
}) => {
  await viewAsParticipant(page);
  await page.route("**/api/conversations/*/title", (route) =>
    route.fulfill({ json: { error: "unavailable" }, status: 503 }),
  );
  await page.setViewportSize(mobile);
  await page.goto(`${dashboard.baseURL}${CONVERSATION_PATH}`);

  await openRename(page);
  const field = page.getByRole("textbox", { name: "Conversation title" });
  await expect(field).toBeFocused();
  await field.fill("Checkout latency follow-up");
  await screenshot(page, "conversation-title-editing", {
    lightTheme: true,
    view: "mobile",
  });
  await field.press("Enter");

  await expect(page.getByText("Could not rename.")).toBeVisible();
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
  await screenshot(page, "conversation-title-error", { lightTheme: true });
});
