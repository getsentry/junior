import type { Page } from "@playwright/test";

import { viewAsParticipant } from "./conversationMenu";
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

test("renames a conversation from its title", async ({ page, dashboard }) => {
  await viewAsParticipant(page);
  const renames = recordRenames(page);
  await page.goto(`${dashboard.baseURL}${CONVERSATION_PATH}`);
  const title = page
    .getByRole("heading", { name: TITLE })
    .getByRole("button", { name: TITLE });
  const field = page.getByRole("textbox", { name: "Conversation title" });
  await expect(title).toBeVisible();
  await screenshot(page, "conversation-title", { lightTheme: true });

  await title.click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(TITLE);
  await field.fill("Checkout latency notes");
  await screenshot(page, "conversation-title-editing", {
    lightTheme: true,
    view: "desktop",
  });
  // Escape cancels and gives focus back to the title.
  await field.press("Escape");
  await expect(title).toBeFocused();

  // An empty title does not save.
  await title.press("Enter");
  await field.fill("   ");
  await field.press("Enter");
  await expect(title).toBeFocused();

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith("/title"),
  );
  await title.click();
  await field.fill("  Checkout latency follow-up ");
  await field.press("Enter");
  expect((await saved).ok()).toBe(true);
  const renamed = page
    .getByRole("heading", { name: "Checkout latency follow-up" })
    .getByRole("button");
  await expect(renamed).toBeFocused();
  expect(renames).toEqual([{ title: "Checkout latency follow-up" }]);

  // The `⋯` menu's Rename edits the same field.
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Checkout latency follow-up");
  // The field stays open after the menu closes, so typing reaches it.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.keyboard.type("Checkout p95 regression");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Checkout p95 regression" }),
  ).toBeVisible();
  expect(renames).toEqual([
    { title: "Checkout latency follow-up" },
    { title: "Checkout p95 regression" },
  ]);
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

  await page
    .getByRole("heading", { name: TITLE })
    .getByRole("button", { name: TITLE })
    .click();
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
