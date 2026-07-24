import { describe, expect, it } from "vitest";
import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationReportEvent,
  ConversationUpdatesReport,
} from "@sentry/junior/api/schema";

import {
  buildConversationTranscript,
  conversationHistoryChanged,
} from "../src/client/conversation-transcript";

const generatedAt = "2026-07-23T00:00:00.000Z";

function event(seq: number): ConversationReportEvent {
  return {
    createdAt: generatedAt,
    data: {
      type: "message_handled",
      messageId: `message-${seq}`,
    },
    seq,
  };
}

function detail(): ConversationDetailReport {
  return {
    actorIdentity: { email: "stale@example.com" },
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

function update(): ConversationUpdatesReport {
  return {
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
}

describe("conversation transcript", () => {
  it("derives one ordered transcript from separate query resources", () => {
    const historyPages: ConversationEventPage[] = [
      {
        events: [event(1), event(2), event(3)],
        eventHistory: { status: "available" },
        generatedAt,
      },
    ];

    expect(
      buildConversationTranscript(detail(), historyPages, [update()]),
    ).toEqual({
      ...update(),
      actorIdentity: undefined,
      events: [event(1), event(2), event(3), event(4), event(5)],
      hasMore: undefined,
      previousCursor: undefined,
      sentryConversationUrl: "https://sentry.example/conversation-1",
    });
  });

  it("uses the oldest loaded page cursor without changing detail metadata", () => {
    const historyPages: ConversationEventPage[] = [
      {
        events: [event(2)],
        eventHistory: { status: "available" },
        generatedAt,
        previousCursor: "before-2",
      },
      {
        events: [event(1)],
        eventHistory: { status: "available" },
        generatedAt,
      },
    ];

    expect(
      buildConversationTranscript(detail(), historyPages, []),
    ).toMatchObject({
      displayTitle: "Conversation",
      events: [event(1), event(2), event(3), event(4)],
      previousCursor: undefined,
    });
  });

  it("retains detail model usage when an update omits it", () => {
    const withoutModelUsage = { ...update(), modelUsage: undefined };

    expect(
      buildConversationTranscript(detail(), [], [withoutModelUsage]).modelUsage,
    ).toEqual(detail().modelUsage);
  });

  it("does not retain visible events or model usage after history is restricted", () => {
    const restricted: ConversationEventPage = {
      events: [],
      eventHistory: { status: "expired", expiredAt: generatedAt },
      generatedAt,
    };
    const current = buildConversationTranscript(detail(), [restricted], []);

    expect(current.eventHistory).toEqual({
      status: "expired",
      expiredAt: generatedAt,
    });
    expect(current.events).toEqual([]);
    expect(current.modelUsage).toBeUndefined();
    expect(conversationHistoryChanged(detail(), [restricted], [])).toBe(true);
  });

  it("detects a visibility change reported by forward updates", () => {
    const restricted: ConversationUpdatesReport = {
      ...update(),
      eventHistory: {
        status: "redacted",
        reason: "non_public_conversation",
      },
      events: [],
      modelUsage: undefined,
    };

    expect(conversationHistoryChanged(detail(), [], [restricted])).toBe(true);
    expect(
      buildConversationTranscript(detail(), [], [restricted]).events,
    ).toEqual([]);
  });
});
