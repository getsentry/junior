import { describe, expect, it } from "vitest";
import type {
  ConversationDetailReport,
  ConversationPendingMessage,
} from "@sentry/junior/api/schema";

import {
  conversationTranscriptMessages,
  mergePendingTranscriptMessages,
} from "../src/client/conversations/eventTranscript";

function detail(
  events: ConversationDetailReport["events"] = [],
): ConversationDetailReport {
  return {
    annotations: [],
    conversationId: "local:web:pending",
    cumulativeDurationMs: 0,
    displayTitle: "Pending",
    eventHistory: { status: "available" },
    events,
    generatedAt: new Date(0).toISOString(),
    isParticipant: true,
    lastProgressAt: new Date(0).toISOString(),
    lastSeenAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    status: "active",
    surface: "api",
    visibility: "public",
  };
}

function pending(
  overrides: Partial<ConversationPendingMessage> = {},
): ConversationPendingMessage {
  return {
    createdAt: new Date(2_000).toISOString(),
    delivery: "defer",
    inboundMessageId: "pending-1",
    messageId: "msg-pending-1",
    receivedAt: new Date(2_000).toISOString(),
    role: "user",
    source: "web",
    text: "still in the mailbox",
    ...overrides,
  };
}

describe("pending mailbox transcript merge", () => {
  it("appends mailbox rows after committed history", () => {
    const messages = conversationTranscriptMessages(
      detail([
        {
          createdAt: new Date(1_000).toISOString(),
          data: {
            messageId: "msg-history-1",
            role: "user",
            source: "web",
            text: "already committed",
            type: "message",
          },
          seq: 0,
        },
      ]),
      [pending()],
    );

    expect(messages.map((message) => message.messageId)).toEqual([
      "msg-history-1",
      "msg-pending-1",
    ]);
    expect(messages[1]).toMatchObject({
      delivery: "defer",
      pending: true,
      source: "web",
      parts: [{ type: "text", text: "still in the mailbox" }],
    });
  });

  it("drops mailbox rows once the same message id is committed", () => {
    const messages = mergePendingTranscriptMessages(
      [
        {
          messageId: "msg-pending-1",
          parts: [{ type: "text", text: "already committed" }],
          role: "user",
          source: "web",
          sourceSeq: 0,
          timestamp: 1_000,
        },
      ],
      [pending({ text: "duplicate mailbox copy" })],
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.pending).toBeUndefined();
  });

  it("preserves interrupt vs defer delivery on pending rows", () => {
    const messages = conversationTranscriptMessages(detail(), [
      pending({
        delivery: "interrupt",
        inboundMessageId: "pending-interrupt",
        messageId: "msg-interrupt",
        source: "slack",
        text: "jump the queue",
      }),
      pending({
        delivery: "defer",
        inboundMessageId: "pending-defer",
        messageId: "msg-defer",
        text: "wait your turn",
      }),
    ]);

    expect(messages.map((message) => message.delivery)).toEqual([
      "interrupt",
      "defer",
    ]);
  });
});
