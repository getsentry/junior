import {
  CONVERSATION_DETAIL_VERSION_HEADER,
  CONVERSATION_VERSION_HEADER,
  webMessageId,
} from "@sentry/junior/api/schema";
import type {
  ConversationPendingMessage,
  CreateAttachmentUploadBody,
} from "@sentry/junior/api/schema";
import type { Route } from "@playwright/test";
import { chooseTranscriptView } from "./conversationMenu";
import { expect, test } from "./test";
import { routeConversationVersion, withRequestedMailbox } from "./harness";
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
    uploadIds?: string[];
  }> = [];
  const continueRequests: Array<{
    idempotencyKey: string;
    message: string;
    uploadIds?: string[];
  }> = [];
  // The mock API takes each upload. Keep what the browser asked to upload.
  const uploadRequests: CreateAttachmentUploadBody[] = [];
  const uploadedFiles = (idempotencyKey: string | undefined) =>
    uploadRequests
      .filter((upload) => upload.idempotencyKey === idempotencyKey)
      .map((upload) => upload.filename)
      .sort();
  await page.route("**/api/conversations/attachment-uploads", async (route) => {
    uploadRequests.push(route.request().postDataJSON());
    await route.fallback();
  });
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

  await page.goto(`${dashboard.baseURL}/conversations/new`);
  await expect(
    page.getByRole("heading", { name: "What do you need?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Private" }).click();
  const startComposer = page.getByLabel("Start a conversation");
  const imageBase64 = mockChartPng.toString("base64");
  // Any file type goes. A file over the per-file cap does not. Build large
  // files in the page: sending their bytes from the test is slow.
  await startComposer.evaluate(
    (element, bytes) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([new Uint8Array(bytes)], "huge.log", { type: "text/plain" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    },
    250 * 1024 * 1024 + 1,
  );
  await expect(
    page.getByText(
      "Attach up to 10 files, 250 MB each. Files cannot be empty.",
    ),
  ).toBeVisible();
  await page.getByLabel("Choose files").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("notes"),
  });
  await expect(page.getByText("notes.txt")).toBeVisible();
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
  await screenshot(page, "conversation-file-draft");
  await page.getByRole("button", { name: "Remove pasted.png" }).click();
  await page.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  // Files go to storage before the send, so an image can be over the old
  // 3 MB message limit.
  await startComposer.evaluate(
    (element, { data, padding }) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File(
          [
            Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
            new Uint8Array(padding),
          ],
          "pasted.png",
          { type: "image/png" },
        ),
      );
      clipboardData.items.add(
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    },
    { data: imageBase64, padding: 4 * 1024 * 1024 },
  );
  await expect(page.getByRole("img", { name: "pasted.png" })).toBeVisible();
  await startComposer.fill("Check the deploy");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => createRequests.length).toBe(1);
  // The new Conversation shows at once with the message and Junior at work.
  // The draft stays in the hidden composer while the first accept is
  // open, so a later submit cannot send it twice.
  const transcriptView = page.getByLabel("Conversation transcript");
  await expect(transcriptView.getByText("Check the deploy")).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Junior is thinking" }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${dashboard.baseURL}/conversations/new`);
  await expect(startComposer).toBeHidden();
  await expect(startComposer).toHaveValue("Check the deploy");
  await startComposer.evaluate((element) => {
    element.closest("form")?.requestSubmit();
  });
  expect(createRequests).toHaveLength(1);
  releaseFirstCreate?.();
  await expect(
    page.getByText("Message failed to send. Try again."),
  ).toBeVisible();
  // New roots have no mailbox outbox, so a failed create keeps the draft and
  // the same idempotency key for a safe retry. Focus returns, so Enter
  // retries.
  await expect(startComposer).toHaveValue("Check the deploy");
  await expect(startComposer).toBeFocused();
  await expect(page.getByRole("img", { name: "pasted.png" })).toBeVisible();
  const failedCreateKey = createRequests[0]?.idempotencyKey;
  expect(createRequests[0]?.uploadIds).toHaveLength(2);
  expect(uploadedFiles(failedCreateKey)).toEqual(["notes.txt", "pasted.png"]);
  expect(uploadRequests).toContainEqual(
    expect.objectContaining({
      bytes: mockChartPng.byteLength + 4 * 1024 * 1024,
      contentType: "image/png",
      filename: "pasted.png",
    }),
  );
  expect(createRequests[0]?.message).toBe("Check the deploy");
  expect(createRequests[0]?.visibility).toBe("private");
  expect(failedCreateKey).toBeTruthy();

  let createdDetailReads = 0;
  let releaseCreatedDetail: (() => void) | undefined;
  const createdDetailHeld = new Promise<void>((resolve) => {
    releaseCreatedDetail = resolve;
  });
  // Serve the new Conversation before its history has the first message.
  await page.route(
    `**/api/conversations/${encodeURIComponent(createdConversationId)}*`,
    async (route) => {
      createdDetailReads += 1;
      await createdDetailHeld;
      const url = route.request().url();
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          [CONVERSATION_DETAIL_VERSION_HEADER]: "",
        },
        // Any mock Conversation with available history.
        url: url.replace(
          encodeURIComponent(createdConversationId),
          encodeURIComponent("slack:CQA123:1770003600.000200"),
        ),
      });
      const detail = await response.json();
      await route.fulfill({
        json: withRequestedMailbox(route, {
          ...detail,
          conversationId: createdConversationId,
          events: [],
          isParticipant: true,
          previousCursor: undefined,
          status: "active",
        }),
      });
    },
  );
  await page.getByRole("button", { name: "Send" }).click();
  // The pending Conversation shows until the new one can open with its
  // transcript.
  await expect.poll(() => createdDetailReads).toBe(1);
  await expect(page).toHaveURL(`${dashboard.baseURL}/conversations/new`);
  await expect(transcriptView.getByText("Check the deploy")).toBeVisible();
  await expect(startComposer).toHaveValue("Check the deploy");
  releaseCreatedDetail?.();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(createdConversationId)}`,
  );
  await expect(
    page.getByLabel("Conversation transcript").getByText("Check the deploy"),
  ).toBeVisible();
  // The cursor stays in the reply box from send to the opened Conversation.
  const replyBox = page.getByLabel("Continue this conversation");
  await expect(replyBox).toBeFocused();
  // Coming back from the event log does not ask for the reply box again.
  await chooseTranscriptView(page, "Event log");
  await chooseTranscriptView(page, "Conversation");
  await expect(replyBox).toBeVisible();
  await expect(replyBox).not.toBeFocused();
  expect(createRequests).toHaveLength(2);
  expect(createRequests[1]?.idempotencyKey).toBe(failedCreateKey);
  expect(createRequests[1]?.message).toBe("Check the deploy");
  expect(createRequests[1]?.visibility).toBe("private");
  // A retry uploads the files again under the same message key.
  expect(createRequests[1]?.uploadIds).toHaveLength(2);
  expect(uploadedFiles(failedCreateKey)).toEqual([
    "notes.txt",
    "notes.txt",
    "pasted.png",
    "pasted.png",
  ]);

  const slackConversationId = "slack:CQA123:1770000000.000100";
  await page.route(
    `**/api/conversations/${encodeURIComponent(slackConversationId)}*`,
    async (route) => {
      if (holdDetailRefresh) await detailRefreshHeld;
      // Request the full body because this test changes it.
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          [CONVERSATION_DETAIL_VERSION_HEADER]: "",
        },
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
  await page
    .getByRole("button", { name: "Conversation details", exact: true })
    .click();
  const details = page.getByRole("complementary", {
    name: "Conversation details",
  });
  await expect(details).toBeVisible();
  await expect(composer).toHaveValue("Continue in Junior");
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
  await screenshot(page, "conversation-file-reply");
  await page.getByRole("button", { name: "Send" }).click();
  const pending = page.getByLabel("Pending messages");
  // This history expired, so the transcript cannot show the send. It queues.
  await expect(pending.getByText("Continue in Junior")).toBeVisible();
  // The author avatar carries the name and email for hover and screen readers.
  await expect(pending.getByLabel(/dev@example\.com/)).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect.poll(() => continueRequests.length).toBe(1);
  await expect(details).toBeVisible();
  // Distinct messages can queue while an earlier accept is still open.
  await composer.fill("Second queued message");
  await page.getByRole("button", { name: "Send" }).click();
  const expandQueue = pending.getByRole("button", {
    name: "2 queued messages",
  });
  await expect(expandQueue).toHaveAttribute("aria-expanded", "false");
  await expect(pending.getByText("Second queued message")).toBeHidden();
  await expect.poll(() => continueRequests.length).toBe(2);
  // Empty-composer double submit must not mint another request.
  await composer.evaluate((element) => {
    element.closest("form")?.requestSubmit();
  });
  expect(continueRequests).toHaveLength(2);
  releaseFirstContinue?.();
  await expect(pending.getByText("Could not send.")).toBeVisible();
  await expect(expandQueue).toHaveAttribute("aria-expanded", "false");
  await expect(composer).toHaveValue("");
  const failedIdempotencyKey = continueRequests[0]?.idempotencyKey;
  expect(continueRequests[0]?.message).toBe("Continue in Junior");
  expect(failedIdempotencyKey).toBeTruthy();

  holdDetailRefresh = true;
  await pending.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => continueRequests.length).toBe(3);
  expect(continueRequests[2]?.idempotencyKey).toBe(failedIdempotencyKey);
  expect(continueRequests[0]?.uploadIds).toHaveLength(1);
  expect(continueRequests[2]?.uploadIds).toHaveLength(1);
  expect(uploadedFiles(failedIdempotencyKey)).toEqual([
    "dropped.png",
    "dropped.png",
  ]);
  // The accepted message stays out of the composer before background transcript
  // refreshes finish. Keep the local row until a server snapshot sees it.
  await expect(composer).toHaveValue("");
  await expandQueue.click();
  await expect(pending.getByText("Second queued message")).toBeVisible();
  await expect(pending.getByText("Continue in Junior")).toBeVisible();
  releaseDetailRefresh?.();
  await screenshot(page, "conversation-outbox-author");

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
  let detailReads = 0;
  let detailReadsInFlight = 0;
  let releaseAccept!: () => void;
  const accept = new Promise<void>((resolve) => {
    releaseAccept = resolve;
  });
  let releaseHistory!: () => void;
  let historyHeld: Promise<void> | undefined;
  let failCancel = true;
  // Polls read the mailbox with the detail below. This route only cancels.
  await page.route(`${path}/pending-messages`, async (route) => {
    if (failCancel) {
      await route.fulfill({
        status: 500,
        json: { error: "temporary failure" },
      });
      return;
    }
    const cancelled = queued.map((message) => message.inboundMessageId);
    queued = [];
    await route.fulfill({
      json: {
        conversationId,
        cancelledCount: cancelled.length,
        cancelledInboundMessageIds: cancelled,
      },
    });
  });
  // The tree token moves with the mailbox and history, as on the server.
  const conversationVersion = () =>
    JSON.stringify([queued, committed, active, started]);
  await routeConversationVersion(page, conversationVersion);
  await page.route(`${path}*`, async (route) => {
    detailReads += 1;
    detailReadsInFlight += 1;
    // Like the server, read the mailbox before history.
    const mailbox = {
      conversationId,
      generatedAt: createdAt,
      messages: queued,
    };
    await historyHeld;
    // Request the full body because this test changes it.
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        [CONVERSATION_DETAIL_VERSION_HEADER]: "",
      },
    });
    const detail = await response.json();
    const { "content-length": _, ...headers } = response.headers();
    await route.fulfill({
      response,
      headers: {
        ...headers,
        [CONVERSATION_VERSION_HEADER]: conversationVersion(),
      },
      json: {
        ...detail,
        mailbox,
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
    detailReadsInFlight -= 1;
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
  const transcript = page.getByLabel("Conversation transcript");
  const thinking = page
    .getByRole("status")
    .filter({ hasText: "Junior is thinking" });
  await composer.fill(web.text);
  await composer.evaluate((element, data) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File(
        [Uint8Array.from(atob(data), (c) => c.charCodeAt(0))],
        "handoff.png",
        { type: "image/png" },
      ),
    );
    element.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
    );
  }, mockChartPng.toString("base64"));
  await expect(page.getByRole("img", { name: "handoff.png" })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // Junior is idle and the queue is empty, so the send goes straight to the
  // transcript and stays in place until history has it. Its local image shows
  // before the server stores it.
  await expect(transcript.getByText(web.text)).toBeVisible();
  await expect(
    transcript.getByRole("img", { name: "handoff.png" }),
  ).toBeVisible();
  await expect(pending).toBeHidden();
  await expect(thinking).toBeHidden();

  // History does not have the first send yet, so its Turn can start first.
  // A send now waits in the queue instead of the transcript tail.
  const waiting = { ...web, text: "Wait behind the first send" };
  const acceptWaiting = async (route: Route) => {
    const body = route.request().postDataJSON();
    waiting.messageId = await webMessageId({
      conversationId,
      idempotencyKey: body.idempotencyKey,
    });
    waiting.inboundMessageId = waiting.messageId;
    await route.fulfill({
      json: {
        conversationId,
        messageId: waiting.messageId,
        status: "accepted",
      },
    });
  };
  await page.route(`${path}/messages`, acceptWaiting);
  await composer.fill(waiting.text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(pending.getByText(waiting.text)).toBeVisible();
  await expect(transcript.getByText(waiting.text)).toBeHidden();
  await page.unroute(`${path}/messages`, acceptWaiting);
  // History takes the waiting send so the rest of the handoff starts clean.
  committed = [waiting];
  await expect(pending).toBeHidden();
  await expect(transcript.getByText(web.text)).toBeVisible();

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
  await expect(transcript.getByText(web.text)).toBeVisible();
  await expect(pending).toBeHidden();
  await expect(thinking).toBeHidden();
  releaseHistory();
  historyHeld = undefined;
  // The mailbox copy does not pull the message back into the queue.
  queued = [web];
  const readsBeforeQueued = detailReads;
  await expect.poll(() => detailReads).toBeGreaterThan(readsBeforeQueued + 1);
  await expect(transcript.getByText(web.text)).toBeVisible();
  await expect(pending).toBeHidden();
  await expect(thinking).toBeHidden();

  // The mailbox can empty before the slower history read returns. Publish both
  // together, and do not hide the web message in the meantime. A read that is
  // already past the hold would show the new history early.
  await expect.poll(() => detailReadsInFlight).toBe(0);
  const readsBeforeCommit = detailReads;
  queued = [];
  committed = [waiting, web];
  started = true;
  historyHeld = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  await expect.poll(() => detailReads).toBeGreaterThan(readsBeforeCommit);
  await expect(transcript.getByText(web.text)).toBeVisible();
  await expect(thinking).toBeHidden();
  releaseHistory();
  historyHeld = undefined;
  await expect(thinking).toBeVisible();
  await expect(transcript.getByText(web.text)).toBeVisible();
  await expect(pending).toBeHidden();

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
    pending.getByRole("button", { name: "Delete queued message" }),
  ).toBeVisible();
  await expect(page.getByText(second.text, { exact: true })).toHaveCount(1);
  committed = [waiting, web, second];
  await expect(pending).toBeHidden();
  await expect(page.getByText(second.text, { exact: true })).toHaveCount(1);
  releaseSecondAccept();

  // A second Source can queue during an existing Turn. Do not suppress the
  // current thinking indicator just because another message is waiting.
  queued = [external];
  await expect(pending.getByText(external.text)).toBeVisible();
  await expect(pending.getByLabel("Slack", { exact: true })).toBeVisible();
  await expect(thinking).toBeVisible();
  committed = [waiting, web, second, external];
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
  await pending.getByRole("button", { name: "Delete queued message" }).click();
  await expect(pending.getByText("Could not delete. Try again.")).toBeVisible();
  failCancel = false;
  await pending
    .getByRole("button", { name: "Could not delete. Try again." })
    .click();
  await expect(pending).toBeHidden();
});

test("keeps details closed on a home send after the reader closed them", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  const createdConversationId = "local:web:details-closed";
  let releaseCreate: (() => void) | undefined;
  const createHeld = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await createHeld;
    await route.fulfill({
      json: {
        conversationId: createdConversationId,
        messageId: "created-message",
        status: "accepted",
      },
    });
  });
  await page.route(
    `**/api/conversations/${encodeURIComponent(createdConversationId)}*`,
    async (route) => {
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          [CONVERSATION_DETAIL_VERSION_HEADER]: "",
        },
        // Any mock Conversation with available history.
        url: route
          .request()
          .url()
          .replace(
            encodeURIComponent(createdConversationId),
            encodeURIComponent("slack:CQA123:1770003600.000200"),
          ),
      });
      await route.fulfill({
        json: withRequestedMailbox(route, {
          ...(await response.json()),
          conversationId: createdConversationId,
          events: [],
          isParticipant: true,
          previousCursor: undefined,
          status: "active",
        }),
      });
    },
  );
  const details = page.getByRole("complementary", {
    name: "Conversation details",
  });

  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`,
  );
  await expect(details).toBeVisible();
  await details
    .getByRole("button", { name: "Close conversation details" })
    .click();
  await expect(details).toBeHidden();

  await page.goto(`${dashboard.baseURL}/conversations/new`);
  await page.getByLabel("Start a conversation").fill("Check the deploy");
  await page.getByRole("button", { name: "Send" }).click();
  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText("Check the deploy")).toBeVisible();
  await expect(page).toHaveURL(`${dashboard.baseURL}/conversations/new`);
  // The pending view follows the saved choice, as the page does.
  await expect(details).toBeHidden();
  releaseCreate?.();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(createdConversationId)}`,
  );
  await expect(transcript.getByText("Check the deploy")).toBeVisible();
  await expect(details).toBeHidden();
});
