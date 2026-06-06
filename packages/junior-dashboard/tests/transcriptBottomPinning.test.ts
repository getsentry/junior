import { describe, expect, it } from "vitest";

import {
  isNearScrollBottom,
  shouldAutoPinTranscriptBottom,
  transcriptFollowIntent,
  transcriptBottomVersion,
} from "../src/client/components/transcriptBottomPinning";
import type { ConversationTurn } from "../src/client/types";

function activeTurn(
  overrides: Partial<ConversationTurn> = {},
): ConversationTurn {
  return {
    conversationId: "conversation-1",
    cumulativeDurationMs: 0,
    id: "turn-1",
    lastProgressAt: "2026-01-01T00:00:10.000Z",
    lastSeenAt: "2026-01-01T00:00:10.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    surface: "slack",
    title: "Turn turn-1",
    transcript: [
      {
        role: "assistant",
        timestamp: 1_000,
        parts: [{ type: "text", text: "checking" }],
      },
    ],
    transcriptAvailable: true,
    ...overrides,
  } as ConversationTurn;
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
    const before = transcriptBottomVersion([activeTurn()]);
    const after = transcriptBottomVersion([
      activeTurn({
        transcript: [
          {
            role: "assistant",
            timestamp: 1_000,
            parts: [{ type: "text", text: "checking the deployment" }],
          },
        ],
      }),
    ]);

    expect(after).not.toBe(before);
  });

  it("keeps the tail version stable when only polling timestamps change", () => {
    const before = transcriptBottomVersion([activeTurn()]);
    const after = transcriptBottomVersion([
      activeTurn({
        lastProgressAt: "2026-01-01T00:01:00.000Z",
        lastSeenAt: "2026-01-01T00:01:00.000Z",
      }),
    ]);

    expect(after).toBe(before);
  });

  it("changes the tail version when the live turn completes", () => {
    const before = transcriptBottomVersion([activeTurn()]);
    const after = transcriptBottomVersion([
      activeTurn({
        completedAt: "2026-01-01T00:00:12.000Z",
        status: "completed",
      }),
    ]);

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
