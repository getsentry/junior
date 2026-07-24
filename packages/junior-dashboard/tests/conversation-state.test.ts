import { describe, expect, it } from "vitest";
import {
  conversationDetailReportSchema,
  type ConversationDetailReport,
  type ConversationEventPage,
  type ConversationReportEvent,
  type ConversationUpdatesReport,
} from "@sentry/junior/api/schema";
import {
  mergeConversationEventPage,
  mergeConversationSnapshot,
  mergeConversationUpdate,
} from "../src/client/conversation-state";

const generatedAt = "2026-07-23T00:00:00.000Z";

function event(seq: number): ConversationReportEvent {
  return {
    seq,
    createdAt: generatedAt,
    data: {
      type: "message_handled",
      messageId: `message-${seq}`,
    },
  };
}

function detail(): ConversationDetailReport {
  return {
    conversationId: "conversation-1",
    cumulativeDurationMs: 10,
    displayTitle: "Conversation",
    eventCursor: "live-cursor",
    eventHistory: { status: "available" },
    events: [event(3), event(4)],
    generatedAt,
    isParticipant: false,
    lastProgressAt: generatedAt,
    lastSeenAt: generatedAt,
    modelUsage: [
      {
        modelId: "openai/gpt-5",
        usage: { inputTokens: 1, totalTokens: 1 },
      },
    ],
    previousCursor: "before-3",
    sentryConversationUrl: "https://sentry.example/conversation-1",
    startedAt: generatedAt,
    status: "active",
    surface: "internal",
  };
}

describe("conversation state", () => {
  it("prepends history without replacing the live cursor or duplicating events", () => {
    const page: ConversationEventPage = {
      events: [event(1), event(2), event(3)],
      eventHistory: { status: "available" },
      generatedAt,
    };

    expect(mergeConversationEventPage(detail(), page)).toMatchObject({
      eventCursor: "live-cursor",
      events: [event(1), event(2), event(3), event(4)],
      previousCursor: undefined,
      sentryConversationUrl: "https://sentry.example/conversation-1",
    });
  });

  it("appends updates while preserving detail-only fields", () => {
    const update: ConversationUpdatesReport = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 20,
      displayTitle: "Updated conversation",
      eventCursor: "next-cursor",
      eventHistory: { status: "available" },
      events: [event(4), event(5)],
      generatedAt,
      hasMore: false,
      isParticipant: false,
      lastProgressAt: generatedAt,
      lastSeenAt: generatedAt,
      modelUsage: [
        {
          modelId: "openai/gpt-5",
          usage: { inputTokens: 2, totalTokens: 2 },
        },
      ],
      startedAt: generatedAt,
      status: "completed",
      surface: "internal",
    };

    const merged = mergeConversationUpdate(detail(), update);
    expect(conversationDetailReportSchema.parse(merged)).toMatchObject({
      cumulativeDurationMs: 20,
      displayTitle: "Updated conversation",
      eventCursor: "next-cursor",
      events: [event(3), event(4), event(5)],
      modelUsage: [
        {
          modelId: "openai/gpt-5",
          usage: { inputTokens: 2, totalTokens: 2 },
        },
      ],
      previousCursor: "before-3",
      sentryConversationUrl: "https://sentry.example/conversation-1",
      status: "completed",
    });
  });

  it("refreshes a snapshot without discarding loaded history", () => {
    const current = mergeConversationEventPage(detail(), {
      events: [event(1), event(2)],
      eventHistory: { status: "available" },
      generatedAt,
    });
    const snapshot: ConversationDetailReport = {
      ...detail(),
      cumulativeDurationMs: 30,
      eventCursor: "refreshed-cursor",
      events: [event(4), event(5)],
      status: "completed",
    };

    expect(mergeConversationSnapshot(current, snapshot)).toMatchObject({
      cumulativeDurationMs: 30,
      eventCursor: "refreshed-cursor",
      events: [event(1), event(2), event(3), event(4), event(5)],
      previousCursor: undefined,
      status: "completed",
    });
  });

  it("uses a fresh snapshot when event history availability changes", () => {
    const snapshot: ConversationDetailReport = {
      ...detail(),
      eventHistory: { status: "expired", expiredAt: generatedAt },
      events: [],
      previousCursor: undefined,
    };

    expect(mergeConversationSnapshot(detail(), snapshot)).toEqual(snapshot);
  });
});
