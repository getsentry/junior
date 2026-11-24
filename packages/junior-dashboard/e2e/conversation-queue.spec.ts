import {
  CONVERSATION_DETAIL_VERSION_HEADER,
  MAX_INPUT_ATTACHMENTS,
  webMessageId,
} from "@sentry/junior/api/schema";
import type { ConversationPendingMessage } from "@sentry/junior/api/schema";
import { chooseTranscriptView } from "./conversationMenu";
import { expect, test } from "./test";
import { withRequestedMailbox } from "./harness";
import { screenshot } from "./screenshot";
import { mockChartPng } from "../src/mock-reporting/chart-png";

test("stops the active Turn and returns queued text to the composer", async ({
  page,
  dashboard,
}) => {
  const conversationId = "slack:CQA123:1770000000.000100";
  const path = `**/api/conversations/${encodeURIComponent(conversationId)}`;
  const createdAt = "2026-06-12T00:00:00.000Z";
  const queuedMessage: ConversationPendingMessage & { text: string } = {
    createdAt,
    receivedAt: createdAt,
    delivery: "defer",
    inboundMessageId: "queued-before-stop",
    messageId: "queued-before-stop",
    role: "user",
    source: "web",
    text: "Queued follow-up",
  };
  // Sent from this tab. The server accepts it, but no poll lists it yet.
  const sentMessage = { ...queuedMessage, text: "Sent before stop" };
  let active = true;
  let queued: ConversationPendingMessage[] = [queuedMessage];
  let stopRequests = 0;
  await page.route(`${path}/messages`, async (route) => {
    const body = route.request().postDataJSON();
    sentMessage.messageId = await webMessageId({
      conversationId,
      idempotencyKey: body.idempotencyKey,
    });
    sentMessage.inboundMessageId = sentMessage.messageId;
    await route.fulfill({
      json: {
        conversationId,
        messageId: sentMessage.messageId,
        status: "accepted",
      },
    });
  });
  await page.route(`${path}/stop`, async (route) => {
    stopRequests += 1;
    const stopped = [queuedMessage, sentMessage];
    await route.fulfill({
      json: {
        conversationId,
        status: "requested",
        stoppedInboundMessageIds: stopped.map(
          (message) => message.inboundMessageId,
        ),
        stoppedMessages: stopped.map((message) => ({
          inboundMessageId: message.inboundMessageId,
          text: message.text,
        })),
      },
    });
  });
  await page.route(`${path}*`, async (route) => {
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        [CONVERSATION_DETAIL_VERSION_HEADER]: "",
      },
    });
    const detail = await response.json();
    await route.fulfill({
      response,
      json: withRequestedMailbox(
        route,
        {
          ...detail,
          isParticipant: true,
          status: active ? "working" : "done",
          turnActive: active,
        },
        { conversationId, generatedAt: createdAt, messages: queued },
      ),
    });
  });

  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  const composer = page.getByLabel("Continue this conversation");
  const pending = page.getByLabel("Pending messages");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(pending.getByText(queuedMessage.text)).toBeVisible();
  await expect(stop).toBeVisible();
  await composer.fill(sentMessage.text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await pending
    .getByRole("button", { name: "2 queued messages" })
    .press("Enter");
  await expect(
    pending.getByRole("button", { name: "Show fewer queued messages" }),
  ).toBeFocused();
  await expect(pending.getByText(sentMessage.text)).toBeVisible();
  await screenshot(page, "conversation-stop-active");

  // Queued text goes back ahead of the draft.
  await composer.fill("Draft in progress");
  await stop.click();
  await expect(composer).toHaveText(
    `${queuedMessage.text}\n${sentMessage.text}\nDraft in progress`,
    { useInnerText: true },
  );
  await expect(pending).toBeHidden();
  expect(stopRequests).toBe(1);

  // The worker removes stopped rows later, so polls can still list them. Keep
  // them hidden, also after leaving the view remounts the footer.
  queued = [queuedMessage, sentMessage];
  await chooseTranscriptView(page, "Event log");
  await chooseTranscriptView(page, "Conversation");
  await expect(composer).toBeVisible();
  await expect(pending).toBeHidden();

  queued = [];
  active = false;
  await expect(stop).toBeHidden({ timeout: 15_000 });
});

test("edits a queued message back into the composer", async ({
  page,
  dashboard,
}) => {
  const conversationId = "slack:CQA123:1770000000.000100";
  const path = `**/api/conversations/${encodeURIComponent(conversationId)}`;
  const createdAt = "2026-06-12T00:00:00.000Z";
  const queuedMessage: ConversationPendingMessage & { text: string } = {
    actorIdentity: { email: "dev@example.com" },
    attachments: [
      {
        bytes: 18211,
        contentType: "image/png",
        filename: "queued-chart.png",
        id: "qa-chart-png",
      },
    ],
    createdAt,
    receivedAt: createdAt,
    delivery: "defer",
    inboundMessageId: "queued-edit",
    messageId: "queued-edit",
    role: "user",
    source: "web",
    text: "Queued follow-up",
  };
  // The reader steers this one. Junior reads it before the edit lands, so the
  // cancel finds nothing.
  const readMessage: ConversationPendingMessage & { text: string } = {
    ...queuedMessage,
    attachments: undefined,
    inboundMessageId: "queued-read",
    messageId: "queued-read",
    text: "Already read",
  };
  let queued: ConversationPendingMessage[] = [queuedMessage, readMessage];
  const steerRequests: string[][] = [];
  await page.route(`${path}/pending-messages/steer`, async (route) => {
    const ids = route.request().postDataJSON().inboundMessageIds as string[];
    steerRequests.push(ids);
    queued = queued.map((message) =>
      ids.includes(message.inboundMessageId)
        ? { ...message, delivery: "interrupt" }
        : message,
    );
    await route.fulfill({
      json: { conversationId, steeredInboundMessageIds: ids },
    });
  });
  await page.route(`${path}/pending-messages`, async (route) => {
    const [id] = route.request().postDataJSON().inboundMessageIds as string[];
    const cancelled = id === queuedMessage.inboundMessageId ? [id] : [];
    queued = queued.filter((message) => message.inboundMessageId !== id);
    await route.fulfill({
      json: {
        cancelledCount: cancelled.length,
        cancelledInboundMessageIds: cancelled,
        conversationId,
      },
    });
  });
  await page.route(`${path}*`, async (route) => {
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        [CONVERSATION_DETAIL_VERSION_HEADER]: "",
      },
    });
    const detail = await response.json();
    await route.fulfill({
      response,
      json: withRequestedMailbox(
        route,
        { ...detail, isParticipant: true, status: "working", turnActive: true },
        { conversationId, generatedAt: createdAt, messages: queued },
      ),
    });
  });

  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  const composer = page.getByLabel("Continue this conversation");
  const pending = page.getByLabel("Pending messages");
  await pending.getByRole("button", { name: "2 queued messages" }).click();
  await expect(pending.getByText(queuedMessage.text)).toBeVisible();
  await expect(
    pending.getByRole("img", { name: "queued-chart.png" }),
  ).toBeVisible();
  await screenshot(page, "conversation-queue-compact");

  const readRow = pending.getByRole("article").filter({
    hasText: readMessage.text,
  });
  await readRow.getByRole("button", { name: "Steer queued message" }).click();
  await expect(readRow.getByLabel("Next step", { exact: true })).toBeVisible();
  await expect(
    readRow.getByRole("button", { name: "Steer queued message" }),
  ).toBeHidden();
  expect(steerRequests).toEqual([[readMessage.inboundMessageId]]);
  // Close the delivery tooltip that opened under the pointer.
  await page.mouse.move(0, 0);

  // A draft with no room for the queued image keeps the message queued.
  const draftFiles = Array.from(
    { length: MAX_INPUT_ATTACHMENTS },
    (_, index) => `draft-${index + 1}.png`,
  );
  await composer.evaluate(
    (element, { data, names }) => {
      const dataTransfer = new DataTransfer();
      for (const name of names) {
        dataTransfer.items.add(
          new File(
            [Uint8Array.from(atob(data), (c) => c.charCodeAt(0))],
            name,
            { type: "image/png" },
          ),
        );
      }
      element.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );
    },
    { data: mockChartPng.toString("base64"), names: draftFiles },
  );
  await expect(
    page.getByRole("img", { name: draftFiles.at(-1) }),
  ).toBeVisible();
  await pending
    .getByRole("button", { name: "Edit queued message" })
    .first()
    .click();
  await expect(
    page.getByText("Remove some draft files to edit that message."),
  ).toBeVisible();
  await expect(pending.getByText(queuedMessage.text)).toBeVisible();
  await expect(composer).toHaveText("", { useInnerText: true });
  for (const name of draftFiles) {
    await page.getByRole("button", { name: `Remove ${name}` }).click();
  }

  // Text with files moves with its files, after the cancel lands.
  await composer.fill("Draft in progress");
  await pending
    .getByRole("button", { name: "Edit queued message" })
    .first()
    .click();
  await expect(composer).toHaveText(
    `${queuedMessage.text}\nDraft in progress`,
    { useInnerText: true },
  );
  await expect(page.getByRole("img", { name: "queued-chart.png" })).toHaveCount(
    1,
  );
  await expect(pending.getByText(queuedMessage.text)).toBeHidden();

  // Text alone moved before the cancel found nothing. It stays, and the
  // error tells the reader that Junior has it already.
  await pending.getByRole("button", { name: "Edit queued message" }).click();
  await expect(
    page.getByText("That message was already read or removed."),
  ).toBeVisible();
  await expect(composer).toHaveText(
    `${readMessage.text}\n${queuedMessage.text}\nDraft in progress`,
    { useInnerText: true },
  );
});

test("moves queued text to the composer before the cancel lands", async ({
  page,
  dashboard,
}) => {
  const conversationId = "slack:CQA123:1770000000.000100";
  const path = `**/api/conversations/${encodeURIComponent(conversationId)}`;
  const createdAt = "2026-06-12T00:00:00.000Z";
  const queuedMessage: ConversationPendingMessage & { text: string } = {
    actorIdentity: { email: "dev@example.com" },
    createdAt,
    receivedAt: createdAt,
    delivery: "defer",
    inboundMessageId: "queued-slow-edit",
    messageId: "queued-slow-edit",
    role: "user",
    source: "web",
    text: "Queued follow-up",
  };
  let queued: ConversationPendingMessage[] = [queuedMessage];
  let sends = 0;
  await page.route(`${path}/messages`, async (route) => {
    sends += 1;
    await route.fulfill({
      json: { conversationId, messageId: "sent-edit", status: "accepted" },
    });
  });
  // Each cancel waits until the test answers it.
  const cancels: ((ok: boolean) => void)[] = [];
  await page.route(`${path}/pending-messages`, async (route) => {
    const ok = await new Promise<boolean>((resolve) => cancels.push(resolve));
    if (!ok) {
      await route.fulfill({ status: 500, json: { error: "Unavailable" } });
      return;
    }
    queued = [];
    await route.fulfill({
      json: {
        cancelledCount: 1,
        cancelledInboundMessageIds: [queuedMessage.inboundMessageId],
        conversationId,
      },
    });
  });
  await page.route(`${path}*`, async (route) => {
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        [CONVERSATION_DETAIL_VERSION_HEADER]: "",
      },
    });
    const detail = await response.json();
    await route.fulfill({
      response,
      json: withRequestedMailbox(
        route,
        { ...detail, isParticipant: true, status: "working", turnActive: true },
        { conversationId, generatedAt: createdAt, messages: queued },
      ),
    });
  });

  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  const composer = page.getByLabel("Continue this conversation");
  const pending = page.getByLabel("Pending messages");
  const edit = pending.getByRole("button", { name: "Edit queued message" });

  await edit.click();
  await expect(composer).toHaveText(queuedMessage.text, { useInnerText: true });
  await expect(pending).toBeHidden();
  await expect.poll(() => cancels.length).toBe(1);

  // A send waits for the cancel. A failed cancel keeps the message queued,
  // stops the send, and keeps the reader's edits.
  await composer.press("End");
  await composer.pressSequentially(" now");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  cancels[0]?.(false);
  await expect(
    page.getByText("Could not edit the queued message. Try again."),
  ).toBeVisible();
  await expect(pending.getByText(queuedMessage.text)).toBeVisible();
  await expect(composer).toHaveText(`${queuedMessage.text} now`, {
    useInnerText: true,
  });
  expect(sends).toBe(0);

  // The retry does not add the text a second time, also after leaving the
  // view remounts the reply box.
  await chooseTranscriptView(page, "Event log");
  await chooseTranscriptView(page, "Conversation");
  await expect(composer).toHaveText(`${queuedMessage.text} now`, {
    useInnerText: true,
  });
  await edit.click();
  await expect.poll(() => cancels.length).toBe(2);
  cancels[1]?.(true);
  await expect(pending).toBeHidden();
  await expect(
    page.getByText("Could not edit the queued message. Try again."),
  ).toBeHidden();
  await expect(composer).toHaveText(`${queuedMessage.text} now`, {
    useInnerText: true,
  });
});
