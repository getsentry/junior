import { describe, expect, it } from "vitest";
import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationReportEvent,
} from "@sentry/junior/api/schema";

import {
  buildConversationTranscript,
  conversationHistoryBridgeCursor,
  conversationHistoryChanged,
  nextConversationHistoryCursor,
  type ConversationHistoryPage,
} from "../src/client/conversations/transcript";

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

function historyPage(
  requestedBefore: string,
  events: ConversationReportEvent[],
  previousCursor?: string,
): ConversationHistoryPage {
  return {
    events,
    eventHistory: { status: "available" },
    generatedAt,
    requestedBefore,
    ...(previousCursor ? { previousCursor } : {}),
  };
}

describe("conversation transcript", () => {
  it("derives one ordered transcript from detail and history resources", () => {
    const historyPages: ConversationEventPage[] = [
      {
        events: [event(1), event(2), event(3)],
        eventHistory: { status: "available" },
        generatedAt,
      },
    ];

    expect(buildConversationTranscript(detail(), historyPages)).toEqual({
      ...detail(),
      events: [event(1), event(2), event(3), event(4)],
      previousCursor: undefined,
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

    expect(buildConversationTranscript(detail(), historyPages)).toMatchObject({
      displayTitle: "Conversation",
      events: [event(1), event(2), event(3), event(4)],
      previousCursor: undefined,
    });
  });

  it("does not retain visible events or model usage after history is restricted", () => {
    const restricted: ConversationEventPage = {
      events: [],
      eventHistory: { status: "expired", expiredAt: generatedAt },
      generatedAt,
    };
    const current = buildConversationTranscript(detail(), [restricted]);

    expect(current.eventHistory).toEqual({
      status: "expired",
      expiredAt: generatedAt,
    });
    expect(current.events).toEqual([]);
    expect(current.modelUsage).toBeUndefined();
    expect(conversationHistoryChanged(detail(), [restricted])).toBe(true);
  });

  it("does not restore cached visible history after detail is restricted", () => {
    const restrictedDetail: ConversationDetailReport = {
      ...detail(),
      eventHistory: {
        status: "redacted",
        reason: "non_public_conversation",
      },
      events: [event(4)],
      modelUsage: undefined,
    };
    const formerlyVisible: ConversationEventPage = {
      events: [event(1), event(2)],
      eventHistory: { status: "available" },
      generatedAt,
    };

    expect(
      buildConversationTranscript(restrictedDetail, [formerlyVisible]),
    ).toEqual(restrictedDetail);
    expect(
      conversationHistoryChanged(restrictedDetail, [formerlyVisible]),
    ).toBe(true);
  });

  it("bridges a shifted detail window without discarding loaded history", () => {
    const loaded = historyPage(
      "before-501",
      [event(1), event(500)],
      "before-1",
    );

    expect(conversationHistoryBridgeCursor("before-1002", [loaded])).toBe(
      "before-1002",
    );

    const shifted = historyPage(
      "before-1002",
      [event(502), event(1001)],
      "before-502",
    );
    expect(
      conversationHistoryBridgeCursor("before-1002", [loaded, shifted]),
    ).toBe("before-502");

    const bridge = historyPage(
      "before-502",
      [event(2), event(501)],
      "before-2",
    );
    expect(
      conversationHistoryBridgeCursor("before-1002", [loaded, shifted, bridge]),
    ).toBeUndefined();
    expect(
      nextConversationHistoryCursor("before-1002", [loaded, shifted, bridge]),
    ).toBe("before-1");

    const transcript = buildConversationTranscript(
      {
        ...detail(),
        events: [event(1002)],
        previousCursor: "before-1002",
      },
      [loaded, shifted, bridge],
    );
    expect(transcript.events.map((item) => item.seq)).toEqual([
      1, 2, 500, 501, 502, 1001, 1002,
    ]);
    expect(transcript.previousCursor).toBe("before-1");
  });
});
