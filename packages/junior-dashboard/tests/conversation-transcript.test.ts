import { describe, expect, it, vi } from "vitest";
import type {
  ConversationDetailReport,
  ConversationReportEvent,
} from "@sentry/junior/api/schema";

import {
  buildConversationTranscript,
  conversationHistoryBridgeCursor,
  conversationHistoryChanged,
  conversationHistoryVersion,
  loadCompleteConversationTranscript,
  nextConversationHistoryCursor,
  reuseConversationEventReferences,
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
    ...(previousCursor ? { previousCursor } : undefined),
  };
}

describe("conversation transcript", () => {
  it("derives one ordered transcript from detail and history resources", () => {
    const historyPages = [
      historyPage("before-3", [event(1), event(2), event(3)]),
    ];

    expect(buildConversationTranscript(detail(), historyPages)).toEqual({
      ...detail(),
      events: [event(1), event(2), event(3), event(4)],
      previousCursor: undefined,
    });
  });

  it("uses the oldest loaded page cursor without changing detail metadata", () => {
    const historyPages = [
      historyPage("before-3", [event(2)], "before-2"),
      historyPage("before-2", [event(1)]),
    ];

    expect(buildConversationTranscript(detail(), historyPages)).toMatchObject({
      displayTitle: "Conversation",
      events: [event(1), event(2), event(3), event(4)],
      previousCursor: undefined,
    });
  });

  it("does not retain visible events or model usage after history is restricted", () => {
    const restricted: ConversationHistoryPage = {
      events: [],
      eventHistory: { status: "expired", expiredAt: generatedAt },
      generatedAt,
      requestedBefore: "before-3",
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
    const formerlyVisible: ConversationHistoryPage = {
      events: [event(1), event(2)],
      eventHistory: { status: "available" },
      generatedAt,
      requestedBefore: "before-3",
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

  it("marks a slid detail window incomplete until drained history reconnects", () => {
    const drained = historyPage("before-3", [event(1), event(2)]);
    const shiftedDetail = {
      ...detail(),
      events: [event(5), event(6)],
      previousCursor: "before-5",
    };

    const disconnected = buildConversationTranscript(shiftedDetail, [drained]);
    expect(disconnected.events.map((item) => item.seq)).toEqual([1, 2, 5, 6]);
    expect(disconnected.previousCursor).toBe("before-5");

    const connected = buildConversationTranscript(shiftedDetail, [
      drained,
      historyPage("before-5", [event(3), event(4)], "before-3"),
    ]);
    expect(connected.events.map((item) => item.seq)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(connected.previousCursor).toBeUndefined();
  });

  it("changes the history version only when the oldest loaded event changes", () => {
    const older = historyPage("before-3", [event(1), event(2)]);
    const bridge = historyPage("before-6", [event(3), event(5)]);

    expect(conversationHistoryVersion([])).toBe("empty");
    expect(conversationHistoryVersion([older])).toBe("1");
    expect(conversationHistoryVersion([older, bridge])).toBe("1");
    expect(
      conversationHistoryVersion([
        older,
        bridge,
        historyPage("before-1", [event(0)]),
      ]),
    ).toBe("0");
  });

  it("exports one fixed detail snapshot instead of following a live poll", async () => {
    const readPage = vi.fn(async (before: string) => {
      expect(before).toBe("before-3");
      return {
        events: [event(1), event(2)],
        eventHistory: { status: "available" as const },
        generatedAt,
      };
    });
    const newerLivePage = historyPage(
      "before-6",
      [event(4), event(5)],
      "before-4",
    );

    const complete = await loadCompleteConversationTranscript({
      detail: detail(),
      historyPages: [newerLivePage],
      readPage,
    });

    expect(readPage).toHaveBeenCalledOnce();
    expect(complete.events.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(complete.previousCursor).toBeUndefined();
  });

  it("reuses cached pages that belong to the export snapshot", async () => {
    const readPage = vi.fn(async () => {
      throw new Error("Expected the cached page to be reused");
    });
    const complete = await loadCompleteConversationTranscript({
      detail: detail(),
      historyPages: [historyPage("before-3", [event(1), event(2)])],
      readPage,
    });

    expect(readPage).not.toHaveBeenCalled();
    expect(complete.events.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });

  it("reuses events while keeping fresh poll metadata", () => {
    const previous = detail();
    const next = {
      ...previous,
      cumulativeDurationMs: previous.cumulativeDurationMs + 2_000,
      generatedAt: "2026-07-23T00:00:02.000Z",
      lastProgressAt: "2026-07-23T00:00:02.000Z",
      lastSeenAt: "2026-07-23T00:00:02.000Z",
    };

    const result = reuseConversationEventReferences(previous, next);
    expect(result).toBe(next);
    expect(result.events).toBe(previous.events);
    expect(result.generatedAt).toBe("2026-07-23T00:00:02.000Z");
  });

  it("keeps the next events when their version changes", () => {
    const previous = detail();
    const next = {
      ...previous,
      events: [...previous.events, event(5)],
      generatedAt: "2026-07-23T00:00:02.000Z",
    };

    expect(reuseConversationEventReferences(previous, next)).toBe(next);
  });
});
