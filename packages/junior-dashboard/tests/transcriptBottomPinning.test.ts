import { describe, expect, it } from "vitest";

import {
  isNearScrollBottom,
  shouldAutoPinTranscriptBottom,
  transcriptFollowIntent,
  transcriptBottomVersion,
} from "../src/client/components/transcriptBottomPinning";
import type { ConversationTranscript } from "../src/client/types";

function activeTurn(
  overrides: Partial<ConversationTranscript> = {},
): ConversationTranscript {
  return {
    conversationId: "conversation-1",
    cumulativeDurationMs: 0,
    lastProgressAt: "2026-01-01T00:00:10.000Z",
    lastSeenAt: "2026-01-01T00:00:10.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    surface: "slack",
    displayTitle: "Conversation",
    generatedAt: "2026-01-01T00:00:10.000Z",
    isParticipant: false,
    eventHistory: { status: "available" },
    events: [
      {
        seq: 0,
        createdAt: "2026-01-01T00:00:01.000Z",
        data: {
          type: "message",
          messageId: "assistant-1",
          role: "assistant",
          text: "checking",
        },
      },
    ],
    ...overrides,
  };
}

describe("transcript bottom pinning", () => {
  it("treats near-bottom scroll positions as followable", () => {
    expect(
      isNearScrollBottom({
        clientHeight: 800,
        scrollHeight: 2_000,
        scrollTop: 1_112,
      }),
    ).toBe(true);

    expect(
      isNearScrollBottom({
        clientHeight: 800,
        scrollHeight: 2_000,
        scrollTop: 1_000,
      }),
    ).toBe(false);
  });

  it("changes the tail version when streamed text grows", () => {
    const before = transcriptBottomVersion(activeTurn());
    const after = transcriptBottomVersion(
      activeTurn({
        events: [
          {
            seq: 0,
            createdAt: "2026-01-01T00:00:01.000Z",
            data: {
              type: "message",
              messageId: "assistant-1",
              role: "assistant",
              text: "checking the deployment",
            },
          },
        ],
      }),
    );

    expect(after).not.toBe(before);
  });

  it("changes the tail version when a running tool receives its result", () => {
    const started = {
      seq: 0,
      createdAt: "2026-01-01T00:00:01.000Z",
      data: {
        type: "tool_started" as const,
        toolCallId: "search-1",
        name: "search",
      },
    };
    const before = transcriptBottomVersion(activeTurn({ events: [started] }));
    const after = transcriptBottomVersion(
      activeTurn({
        events: [
          started,
          {
            seq: 1,
            createdAt: "2026-01-01T00:00:02.000Z",
            data: {
              type: "tool_result",
              toolCallId: "search-1",
              outcome: "completed",
              output: { matches: 2 },
            },
          },
        ],
      }),
    );

    expect(after).not.toBe(before);
  });

  it("keeps the tail version stable when only polling timestamps change", () => {
    const before = transcriptBottomVersion(activeTurn());
    const after = transcriptBottomVersion(
      activeTurn({
        lastProgressAt: "2026-01-01T00:01:00.000Z",
        lastSeenAt: "2026-01-01T00:01:00.000Z",
      }),
    );

    expect(after).toBe(before);
  });

  it("changes the tail version when the live turn completes", () => {
    const before = transcriptBottomVersion(activeTurn());
    const after = transcriptBottomVersion(
      activeTurn({
        status: "completed",
      }),
    );

    expect(after).not.toBe(before);
  });

  it("changes the tail version when an empty response gains a terminal outcome", () => {
    const before = transcriptBottomVersion(activeTurn({ events: [] }));
    const after = transcriptBottomVersion(
      activeTurn({
        events: [
          {
            seq: 0,
            createdAt: "2026-01-01T00:00:01.000Z",
            data: {
              type: "turn_lifecycle",
              turnId: "turn-1",
              state: "failed",
              failureKind: "agent",
            },
          },
        ],
      }),
    );

    expect(after).not.toBe(before);
  });

  it("does not auto-pin after live mode turns off", () => {
    expect(
      shouldAutoPinTranscriptBottom({ enabled: true, following: true }),
    ).toBe(true);
    expect(
      shouldAutoPinTranscriptBottom({ enabled: false, following: true }),
    ).toBe(false);
  });

  it("pauses follow when the reader scrolls up inside bottom slack", () => {
    expect(
      transcriptFollowIntent({
        previousScrollTop: 1_120,
        snapshot: {
          clientHeight: 800,
          scrollHeight: 2_000,
          scrollTop: 1_112,
        },
        source: "scroll",
      }),
    ).toBe("pause");
  });
});
