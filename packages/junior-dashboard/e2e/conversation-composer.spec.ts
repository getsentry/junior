import type { InputImage } from "@sentry/junior/api/schema";
import { expect, test } from "./test";
import { screenshot } from "./screenshot";
import { mockChartPng } from "../src/mock-reporting/chart-png";

test("starts and continues conversations from the dashboard", async ({
  page,
  dashboard,
}) => {
  const createdConversationId = "local:web:created";
  const createRequests: Array<{
    idempotencyKey: string;
    message: string;
    visibility?: "private" | "public";
    images?: InputImage[];
  }> = [];
  const continueRequests: Array<{
    idempotencyKey: string;
    message: string;
    images?: InputImage[];
  }> = [];
  let releaseFirstContinue: (() => void) | undefined;
  const firstContinueHeld = new Promise<void>((resolve) => {
    releaseFirstContinue = resolve;
  });
  let releaseFirstCreate: (() => void) | undefined;
  const firstCreateHeld = new Promise<void>((resolve) => {
    releaseFirstCreate = resolve;
  });
  let holdDetailRefresh = false;
  let releaseDetailRefresh: (() => void) | undefined;
  const detailRefreshHeld = new Promise<void>((resolve) => {
    releaseDetailRefresh = resolve;
  });
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    createRequests.push(route.request().postDataJSON());
    if (createRequests.length === 1) {
      // Hold the first create so we can prove send stays locked mid-flight.
      await firstCreateHeld;
      await route.fulfill({
        json: { error: "temporary failure" },
        status: 500,
      });
      return;
    }
    await route.fulfill({
      json: {
        conversationId: createdConversationId,
        messageId: "created-message",
        status: "accepted",
      },
    });
  });
  await page.route("**/api/conversations/*/messages", async (route) => {
    const body = route.request().postDataJSON() as {
      idempotencyKey: string;
      message: string;
    };
    continueRequests.push(body);
    // Hold every accept until release so concurrent queue rows stay visible.
    await firstContinueHeld;
    if (
      body.message === "Continue in Junior" &&
      continueRequests.filter((item) => item.message === "Continue in Junior")
        .length === 1
    ) {
      await route.fulfill({
        json: { error: "temporary failure" },
        status: 500,
      });
      return;
    }
    await route.fulfill({
      json: {
        conversationId: "slack:CQA123:1770000000.000100",
        messageId: `continued-message-${continueRequests.length}`,
        status: "accepted",
      },
    });
  });

  await page.goto(dashboard.baseURL);
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "What do you need?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Private" }).click();
  const startComposer = page.getByLabel("Start a conversation");
  const imageBase64 = mockChartPng.toString("base64");
  await page.getByLabel("Choose images").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("notes"),
  });
  await expect(
    page.getByText("Use PNG, JPEG, GIF, or WebP image files."),
  ).toBeVisible();
  await startComposer.evaluate((element, data) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File(
        [Uint8Array.from(atob(data), (c) => c.charCodeAt(0))],
        "pasted.png",
        { type: "image/png" },
      ),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, imageBase64);
  await expect(page.getByRole("img", { name: "pasted.png" })).toBeVisible();
  await screenshot(page, "conversation-image-draft");
  await page.getByRole("button", { name: "Remove pasted.png" }).click();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Choose images").setInputFiles({
    name: "pasted.png",
    mimeType: "image/png",
    buffer: Buffer.from(imageBase64, "base64"),
  });
  await expect(page.getByRole("img", { name: "pasted.png" })).toBeVisible();
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => createRequests.length).toBe(1);
  // Create restore keeps send locked while the first accept is open so a later
  // submit cannot race the failed-draft restore.
  await expect(
    page.getByRole("button", { name: "Sending message" }),
  ).toBeDisabled();
  await startComposer.evaluate((element) => {
    element.closest("form")?.requestSubmit();
  });
  expect(createRequests).toHaveLength(1);
  releaseFirstCreate?.();
  await expect(
    page.getByText("Could not create the conversation. Try again."),
  ).toBeVisible();
  // New roots have no mailbox outbox, so a failed create restores the draft and
  // keeps the same idempotency key for a safe retry.
  await expect(startComposer).toHaveValue("");
  await expect(page.getByRole("img", { name: "pasted.png" })).toBeVisible();
  expect(createRequests[0]?.images).toEqual([
    { filename: "pasted.png", contentType: "image/png", data: imageBase64 },
  ]);
  const failedCreateKey = createRequests[0]?.idempotencyKey;
  expect(createRequests[0]?.message).toBe("");
  expect(createRequests[0]?.visibility).toBe("private");
  expect(failedCreateKey).toBeTruthy();

  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(createdConversationId)}`,
  );
  expect(createRequests).toHaveLength(2);
  expect(createRequests[1]?.idempotencyKey).toBe(failedCreateKey);
  expect(createRequests[1]?.message).toBe("");
  expect(createRequests[1]?.visibility).toBe("private");
  expect(createRequests[1]?.images).toEqual(createRequests[0]?.images);

  const slackConversationId = "slack:CQA123:1770000000.000100";
  await page.route(
    `**/api/conversations/${encodeURIComponent(slackConversationId)}`,
    async (route) => {
      if (holdDetailRefresh) await detailRefreshHeld;
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), isParticipant: true },
      });
    },
  );
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(slackConversationId)}`,
  );
  await expect(
    page.getByText(
      "This reply stays in Junior. It will not be posted to Slack.",
    ),
  ).toHaveCount(0);
  const composer = page.getByLabel("Continue this conversation");
  await composer.fill("Continue in Junior");
  await composer.evaluate((element, data) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File(
        [Uint8Array.from(atob(data), (c) => c.charCodeAt(0))],
        "dropped.png",
        { type: "image/png" },
      ),
    );
    element.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
    );
  }, imageBase64);
  await expect(page.getByRole("img", { name: "dropped.png" })).toBeVisible();
  await screenshot(page, "conversation-image-reply");
  await page.getByRole("button", { name: "Send" }).click();
  const pending = page.getByLabel("Pending messages");
  await expect(pending.getByText("Continue in Junior")).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect.poll(() => continueRequests.length).toBe(1);
  // Distinct messages can queue while an earlier accept is still open.
  await composer.fill("Second queued message");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(pending.getByText("Second queued message")).toBeVisible();
  await expect.poll(() => continueRequests.length).toBe(2);
  // Empty-composer double submit must not mint another request.
  await composer.evaluate((element) => {
    element.closest("form")?.requestSubmit();
  });
  expect(continueRequests).toHaveLength(2);
  releaseFirstContinue?.();
  await expect(pending.getByText("Could not send.")).toBeVisible();
  await expect(composer).toHaveValue("");
  const failedIdempotencyKey = continueRequests[0]?.idempotencyKey;
  expect(continueRequests[0]?.message).toBe("Continue in Junior");
  expect(failedIdempotencyKey).toBeTruthy();

  holdDetailRefresh = true;
  await pending.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => continueRequests.length).toBe(3);
  expect(continueRequests[2]?.idempotencyKey).toBe(failedIdempotencyKey);
  expect(continueRequests[2]?.images).toEqual(continueRequests[0]?.images);
  expect(continueRequests[2]?.images?.[0]?.filename).toBe("dropped.png");
  // The accepted message stays out of the composer before background transcript
  // refreshes finish. A slow read must not make the send look like a UI reload.
  await expect(composer).toHaveValue("");
  await expect(pending.getByText("Continue in Junior")).toBeHidden();
  releaseDetailRefresh?.();

  await page.reload();
  await expect(page.getByLabel("Continue this conversation")).toHaveValue("");
});
