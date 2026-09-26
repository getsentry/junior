import { webMessageId } from "@sentry/junior/api/schema";
import type {
  ConversationPendingMessage,
  InputImage,
} from "@sentry/junior/api/schema";
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
      // Request the full body because this test changes it.
      const response = await route.fetch({
        headers: { ...route.request().headers(), "if-none-match": "" },
      });
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
  // refreshes finish. Keep the local row until a server snapshot sees it.
  await expect(composer).toHaveValue("");
  await expect(pending.getByText("Continue in Junior")).toBeVisible();
  releaseDetailRefresh?.();

  await page.reload();
  await expect(page.getByLabel("Continue this conversation")).toHaveValue("");
});

test("hands web and external messages from queue to history without gaps", async ({
  page,
  dashboard,
}) => {
  // This journey includes real active and idle poll intervals.
  test.setTimeout(60_000);
  const conversationId = "slack:CQA123:1770000000.000100";
  const path = `**/api/conversations/${encodeURIComponent(conversationId)}`;
  const createdAt = "2026-06-12T00:00:00.000Z";
  const web: ConversationPendingMessage & { text: string } = {
    createdAt,
    receivedAt: createdAt,
    delivery: "defer",
    inboundMessageId: "web-handoff",
    messageId: "web-handoff",
    role: "user",
    source: "web",
    text: "Check the message handoff",
  };
  const external = {
    ...web,
    inboundMessageId: "slack-handoff",
    messageId: "slack-handoff",
    source: "slack",
    text: "A follow-up from Slack",
  } as const;
  let queued: ConversationPendingMessage[] = [];
  let committed: ConversationPendingMessage[] = [];
  let active = false;
  let started = false;
  let pendingReads = 0;
  let detailReads = 0;
  let releaseAccept!: () => void;
  const accept = new Promise<void>((resolve) => {
    releaseAccept = resolve;
  });
  let releaseHistory!: () => void;
  let historyHeld: Promise<void> | undefined;
  let failCancel = true;
  await page.route(`${path}/pending-messages`, async (route) => {
    if (route.request().method() === "DELETE") {
      if (failCancel) {
        await route.fulfill({
          status: 500,
          json: { error: "temporary failure" },
        });
      } else {
        const cancelled = queued.map((message) => message.inboundMessageId);
        queued = [];
        await route.fulfill({
          json: {
            conversationId,
            cancelledCount: cancelled.length,
            cancelledInboundMessageIds: cancelled,
          },
        });
      }
      return;
    }
    pendingReads += 1;
    await route.fulfill({
      json: { conversationId, generatedAt: createdAt, messages: queued },
    });
  });
  await page.route(path, async (route) => {
    detailReads += 1;
    await historyHeld;
    // Request the full body because this test changes it.
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const detail = await response.json();
    await route.fulfill({
      response,
      json: {
        ...detail,
        eventHistory: { status: "available" },
        isParticipant: true,
        status: active ? "active" : "completed",
        events: [
          ...detail.events,
          ...committed.map((message, index) => ({
            seq: 1000 + index,
            createdAt,
            data: {
              type: "message",
              messageId: message.messageId,
              role: message.role,
              source: message.source,
              text: message.text,
            },
          })),
          ...(started
            ? [
                {
                  seq: 1100,
                  createdAt,
                  data: {
                    type: "turn_lifecycle",
                    state: "started",
                    turnId: "handoff-turn",
                    inputMessageIds: [web.messageId],
                  },
                },
              ]
            : []),
        ],
      },
    });
  });
  await page.route(`${path}/messages`, async (route) => {
    const body = route.request().postDataJSON();
    web.messageId = await webMessageId({
      conversationId,
      idempotencyKey: body.idempotencyKey,
    });
    web.inboundMessageId = web.messageId;
    await accept;
    await route.fulfill({
      json: { conversationId, messageId: web.messageId, status: "accepted" },
    });
  });
  // Record transient empty states too: the first query result must not leave
  // the loading view before its snapshot reaches the transcript.
  await page.addInitScript(() => {
    const state = { sawEmptyTranscript: false };
    Object.assign(window, { transcriptLoad: state });
    const observer = new MutationObserver(() => {
      if (
        document.body?.textContent?.includes(
          "No transcript is available for this conversation.",
        )
      ) {
        state.sawEmptyTranscript = true;
      }
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  const composer = page.getByLabel("Continue this conversation");
  const pending = page.getByLabel("Pending messages");
  const thinking = page
    .getByRole("status")
    .filter({ hasText: "Junior is thinking" });
  await composer.fill(web.text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(pending.getByText(web.text)).toBeVisible();
  await expect(thinking).toBeHidden();

  // Watch every DOM change, not just the final state: the message must never
  // disappear or appear twice while accept and history requests are held.
  await page.evaluate((text) => {
    const samples: number[] = [];
    const check = () => {
      const leaves = [...document.querySelectorAll("p")].filter(
        (node) => node.textContent === text,
      );
      samples.push(leaves.length);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    Object.assign(window, {
      handoffSamples: samples,
      handoffObserver: observer,
    });
    check();
  }, web.text);

  // Accept arrives before any read sees the input. Keep the row, without claiming
  // that a Turn has started just because the Conversation is now active.
  active = true;
  historyHeld = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  const readsBeforeAccept = detailReads;
  releaseAccept();
  await expect.poll(() => detailReads).toBeGreaterThan(readsBeforeAccept);
  await expect(pending.getByText(web.text)).toBeVisible();
  await expect(pending.getByLabel("Queued", { exact: true })).toBeVisible();
  await expect(thinking).toBeHidden();
  releaseHistory();
  historyHeld = undefined;
  queued = [web];
  await expect(
    pending.getByRole("button", { name: "Remove queued message" }),
  ).toBeVisible();
  await expect(thinking).toBeHidden();

  // The mailbox can empty before the slower history read returns. Publish both
  // together, and do not hide the web message in the meantime.
  const readsBeforeCommit = pendingReads;
  queued = [];
  committed = [web];
  started = true;
  historyHeld = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  await expect.poll(() => pendingReads).toBeGreaterThan(readsBeforeCommit);
  await expect(pending.getByText(web.text)).toBeVisible();
  await expect(thinking).toBeHidden();
  releaseHistory();
  historyHeld = undefined;
  await expect(pending).toBeHidden();
  await expect(
    page.getByLabel("Conversation transcript").getByText(web.text),
  ).toBeVisible();
  await expect(thinking).toBeVisible();

  expect(
    await page.evaluate(() => {
      const state = window as typeof window & {
        transcriptLoad: { sawEmptyTranscript: boolean };
      };
      return state.transcriptLoad.sawEmptyTranscript;
    }),
  ).toBe(false);
  const samples = await page.evaluate(() => {
    const state = window as typeof window & {
      handoffSamples: number[];
      handoffObserver: MutationObserver;
    };
    state.handoffObserver.disconnect();
    return state.handoffSamples;
  });
  expect(samples.length).toBeGreaterThan(1);
  expect(samples.every((count) => count === 1)).toBe(true);

  // Polling can observe a second send before its POST response returns.
  const second = { ...web, text: "Web input before its accept response" };
  let releaseSecondAccept!: () => void;
  const secondAccept = new Promise<void>((resolve) => {
    releaseSecondAccept = resolve;
  });
  await page.route(`${path}/messages`, async (route) => {
    const body = route.request().postDataJSON();
    second.messageId = await webMessageId({
      conversationId,
      idempotencyKey: body.idempotencyKey,
    });
    second.inboundMessageId = second.messageId;
    queued = [second];
    await secondAccept;
    await route.fulfill({
      json: { conversationId, messageId: second.messageId, status: "accepted" },
    });
  });
  await composer.fill(second.text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    pending.getByRole("button", { name: "Remove queued message" }),
  ).toBeVisible();
  await expect(page.getByText(second.text, { exact: true })).toHaveCount(1);
  committed = [web, second];
  await expect(pending).toBeHidden();
  await expect(page.getByText(second.text, { exact: true })).toHaveCount(1);
  releaseSecondAccept();

  // A second Source can queue during an existing Turn. Do not suppress the
  // current thinking indicator just because another message is waiting.
  queued = [external];
  await expect(pending.getByText(external.text)).toBeVisible();
  await expect(pending.getByLabel("Slack", { exact: true })).toBeVisible();
  await expect(thinking).toBeVisible();
  committed = [web, second, external];
  // Even a stale mailbox containing the consumed input must not duplicate it.
  await expect(
    page.getByLabel("Conversation transcript").getByText(external.text),
  ).toBeVisible();
  await expect(pending).toBeHidden();

  // Idle tabs must discover external input without a local submit or refocus.
  queued = [];
  active = false;
  await expect(thinking).toBeHidden();
  const idleExternal = {
    ...external,
    messageId: "idle-slack",
    inboundMessageId: "idle-slack",
    text: "Slack wakes an idle conversation",
  };
  queued = [idleExternal];
  await expect(pending.getByText(idleExternal.text)).toBeVisible({
    timeout: 15_000,
  });
  await expect(thinking).toBeHidden();
  await pending.getByRole("button", { name: "Remove queued message" }).click();
  await expect(pending.getByText("Could not remove. Try again.")).toBeVisible();
  failCancel = false;
  await pending
    .getByRole("button", { name: "Could not remove. Try again." })
    .click();
  await expect(pending).toBeHidden();
});
