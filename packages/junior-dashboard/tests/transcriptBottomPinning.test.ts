import { describe, expect, it } from "vitest";

import {
  isNearScrollBottom,
  prependViewportIntent,
  programmaticSettleScrollAction,
  scrollTopAfterPrepend,
  shouldAutoPinTranscriptBottom,
  shouldPinTerminalJuniorReply,
  shouldShowJumpToLatest,
  transcriptFollowIntent,
  transcriptBottomVersion,
  transcriptJuniorMessageVersion,
} from "../src/client/conversations/transcriptBottomPinning";
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

  it("changes the Junior message version when a reply appears", () => {
    const before = transcriptJuniorMessageVersion(
      activeTurn({
        events: [
          {
            seq: 0,
            createdAt: "2026-01-01T00:00:01.000Z",
            data: {
              type: "message",
              messageId: "user-1",
              role: "user",
              text: "check the deployment",
            },
          },
        ],
      }),
    );
    const after = transcriptJuniorMessageVersion(
      activeTurn({ status: "completed" }),
    );

    expect(before).toBe("empty");
    expect(after).not.toBe(before);
  });

  it("changes the Junior message version for assistant message events", () => {
    const version = transcriptJuniorMessageVersion(
      activeTurn({
        events: [
          {
            seq: 1,
            createdAt: "2026-01-01T00:00:02.000Z",
            data: {
              type: "assistant_message",
              parts: [{ type: "reasoning", text: "final reply" }],
            },
          },
        ],
        status: "completed",
      }),
    );

    expect(version).not.toBe("empty");
  });

  it("keeps the Junior message version stable for later non-message events", () => {
    const current = activeTurn();
    const before = transcriptJuniorMessageVersion(current);
    const after = transcriptJuniorMessageVersion(
      activeTurn({
        events: [
          ...current.events,
          {
            seq: 1,
            createdAt: "2026-01-01T00:00:02.000Z",
            data: {
              type: "turn_lifecycle",
              turnId: "turn-1",
              state: "succeeded",
            },
          },
        ],
        status: "completed",
      }),
    );

    expect(after).toBe(before);
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
        type: "tool_calls" as const,
        calls: [
          {
            toolCallId: "search-1",
            name: "search",
            status: "running" as const,
          },
        ],
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
              type: "tool_calls",
              calls: [
                {
                  toolCallId: "search-1",
                  name: "search",
                  status: "completed",
                  output: { matches: 2 },
                },
              ],
            },
          },
        ],
      }),
    );

    expect(after).not.toBe(before);
  });

  it("keeps the tail version stable for metadata-only events", () => {
    const current = activeTurn();
    const before = transcriptBottomVersion(current);
    const after = transcriptBottomVersion(
      activeTurn({
        events: [
          ...current.events,
          {
            seq: 1,
            createdAt: "2026-01-01T00:00:02.000Z",
            data: {
              type: "message_handled",
              messageId: "assistant-1",
            },
          },
        ],
      }),
    );

    expect(after).toBe(before);
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

  it("keeps the tail version stable when earlier events are prepended", () => {
    const current = activeTurn({
      events: [
        {
          seq: 10,
          createdAt: "2026-01-01T00:00:01.000Z",
          data: {
            type: "message",
            messageId: "assistant-10",
            role: "assistant",
            text: "checking",
          },
        },
      ],
    });
    const before = transcriptBottomVersion(current);
    const after = transcriptBottomVersion(
      activeTurn({
        events: [
          {
            seq: 5,
            createdAt: "2026-01-01T00:00:00.000Z",
            data: {
              type: "message",
              messageId: "user-1",
              role: "user",
              text: "earlier context",
            },
          },
          ...current.events,
        ],
      }),
    );

    expect(after).toBe(before);
  });

  it("offsets the viewport by the height added above it", () => {
    expect(
      scrollTopAfterPrepend(
        {
          scrollHeight: 2_000,
          scrollTop: 480,
        },
        2_750,
      ),
    ).toBe(1_230);
  });

  it("waits for history data instead of treating a detail poll as a prepend", () => {
    expect(
      prependViewportIntent({
        currentHistoryVersion: "10",
        loadingPreviousPage: true,
        snapshotHistoryVersion: "10",
      }),
    ).toBe("wait");
    expect(
      prependViewportIntent({
        currentHistoryVersion: "5",
        loadingPreviousPage: true,
        snapshotHistoryVersion: "10",
      }),
    ).toBe("wait");
    expect(
      prependViewportIntent({
        currentHistoryVersion: "5",
        loadingPreviousPage: false,
        snapshotHistoryVersion: "10",
      }),
    ).toBe("restore");
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

  it("pins only terminal Junior replies that finish a followed live turn", () => {
    expect(
      shouldPinTerminalJuniorReply({
        enabled: false,
        following: true,
        wasEnabled: true,
      }),
    ).toBe(true);
    expect(
      shouldPinTerminalJuniorReply({
        enabled: true,
        following: true,
        wasEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldPinTerminalJuniorReply({
        enabled: false,
        following: false,
        wasEnabled: true,
      }),
    ).toBe(false);
  });

  it("does not auto-pin after live mode turns off", () => {
    expect(
      shouldAutoPinTranscriptBottom({ enabled: true, following: true }),
    ).toBe(true);
    expect(
      shouldAutoPinTranscriptBottom({ enabled: false, following: true }),
    ).toBe(false);
  });

  it("does not resume follow from a layout measurement alone", () => {
    expect(
      transcriptFollowIntent({
        previousScrollTop: 1_000,
        snapshot: {
          clientHeight: 800,
          scrollHeight: 2_000,
          scrollTop: 1_112,
        },
        source: "measure",
      }),
    ).toBe("preserve");
  });

  it("resumes follow when the reader scrolls to the bottom", () => {
    expect(
      transcriptFollowIntent({
        previousScrollTop: 1_000,
        snapshot: {
          clientHeight: 800,
          scrollHeight: 2_000,
          scrollTop: 1_112,
        },
        source: "scroll",
      }),
    ).toBe("follow");
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

  it("shows jump-to-latest only after the reader leaves the bottom and a newer tail arrives", () => {
    expect(
      shouldShowJumpToLatest({
        enabled: true,
        following: true,
        hasPendingUpdate: true,
      }),
    ).toBe(false);
    expect(
      shouldShowJumpToLatest({
        enabled: true,
        following: false,
        hasPendingUpdate: false,
      }),
    ).toBe(false);
    expect(
      shouldShowJumpToLatest({
        enabled: true,
        following: false,
        hasPendingUpdate: true,
      }),
    ).toBe(true);
    expect(
      shouldShowJumpToLatest({
        enabled: false,
        following: false,
        hasPendingUpdate: true,
      }),
    ).toBe(false);
  });

  it("lets a real leave-bottom scroll pause follow during a pin settle window", () => {
    expect(
      programmaticSettleScrollAction({
        intent: "pause",
        snapshot: {
          clientHeight: 800,
          scrollHeight: 2_000,
          scrollTop: 800,
        },
      }),
    ).toBe("pause");
    // Layout clamps can drop scrollTop while still near the bottom.
    expect(
      programmaticSettleScrollAction({
        intent: "pause",
        snapshot: {
          clientHeight: 800,
          scrollHeight: 2_000,
          scrollTop: 1_112,
        },
      }),
    ).toBe("ignore");
    expect(
      programmaticSettleScrollAction({
        intent: "follow",
        snapshot: {
          clientHeight: 800,
          scrollHeight: 2_000,
          scrollTop: 1_200,
        },
      }),
    ).toBe("ignore");
    expect(
      programmaticSettleScrollAction({
        intent: "preserve",
        snapshot: {
          clientHeight: 800,
          scrollHeight: 2_000,
          scrollTop: 900,
        },
      }),
    ).toBe("ignore");
  });
});
