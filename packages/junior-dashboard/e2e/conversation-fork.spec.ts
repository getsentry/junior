import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { expect, test } from "./test";
import { screenshot } from "./screenshot";
const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";

test("forks either message role, navigates, and prefills only the user shortcut", async ({
  page,
  dashboard,
}) => {
  const sourcePath = `/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`;
  const source = (await (
    await page.request.get(`${dashboard.baseURL}/api${sourcePath}`)
  ).json()) as ConversationDetailReport;
  const requests: Array<{ messageSeq: number; idempotencyKey: string }> = [];
  const prefix = source.events.filter((event) => event.seq <= 6);
  let sends = 0;
  await page.route("**/api/conversations/*/messages", async (route) => {
    sends++;
    await route.fulfill({
      json: {
        conversationId: "local:web:fork-user",
        messageId: "sent",
        status: "accepted",
      },
    });
  });
  await page.route("**/api/conversations/*/fork", async (route) => {
    const request = route.request().postDataJSON() as (typeof requests)[number];
    requests.push(request);
    if (requests.length === 1) {
      await route.fulfill({
        status: 500,
        json: { error: "Could not fork. Try again." },
      });
      return;
    }
    const user = request.messageSeq === 7;
    await route.fulfill({
      json: {
        conversationId: `local:web:fork-${user ? "user" : "assistant"}`,
        prefill: user ? "Compare the pre/post deploy spans next." : "",
      },
    });
  });
  await page.route(
    "**/api/conversations/local%3Aweb%3Afork-*",
    async (route) => {
      const conversationId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-1)!,
      );
      await route.fulfill({
        json: {
          ...source,
          conversationId,
          isParticipant: true,
          status: "completed",
          events: prefix,
        },
      });
    },
  );
  await page.route(
    "**/api/conversations/local%3Aweb%3Afork-*/pending-messages",
    async (route) => {
      const conversationId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-2)!,
      );
      await route.fulfill({
        json: { conversationId, generatedAt: source.generatedAt, messages: [] },
      });
    },
  );
  await page.goto(`${dashboard.baseURL}${sourcePath}`);
  const userRow = page
    .locator("article")
    .filter({ hasText: "Compare the pre/post deploy spans next." });
  await userRow
    .getByRole("button", { name: "Fork conversation from this message" })
    .focus();
  await screenshot(page, "conversation-fork-action");
  const userFork = userRow.getByRole("button", {
    name: "Fork conversation from this message",
  });
  await userFork.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Could not fork. Try again.",
  );
  await expect(page).toHaveURL(`${dashboard.baseURL}${sourcePath}`);
  await userFork.click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/local%3Aweb%3Afork-user`,
  );
  const composer = page.getByLabel("Continue this conversation");
  await expect(composer).toHaveValue("Compare the pre/post deploy spans next.");
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1]?.messageSeq).toBe(7);
  expect(sends).toBe(0);
  await screenshot(page, "conversation-fork-prefill");
  await page.reload();
  await expect(composer).toHaveValue("Compare the pre/post deploy spans next.");
  await composer.fill("Edited fork input");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect.poll(() => sends).toBe(1);
  await page.reload();
  await expect(composer).toHaveValue("");

  await page.goto(`${dashboard.baseURL}${sourcePath}`);
  const assistantRow = page
    .locator("article")
    .filter({ hasText: "Checkout p95 jumped after" });
  await assistantRow.hover();
  await assistantRow
    .getByRole("button", { name: "Fork conversation from this message" })
    .click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/local%3Aweb%3Afork-assistant`,
  );
  await expect(composer).toHaveValue("");
  expect(requests.at(-1)?.messageSeq).toBe(6);
  expect(sends).toBe(1);
  await screenshot(page, "conversation-fork-empty");
});
