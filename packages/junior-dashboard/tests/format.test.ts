import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationReportEvent,
  ConversationReportEventData,
  ConversationSummaryReport,
} from "@sentry/junior/api/schema";

import {
  actorLabel,
  buildConversations,
  conversationActorLabel,
  conversationDisplayTitle,
  conversationFromDetail,
  conversationIdentityMeta,
  conversationMessageCount,
  filterConversationList,
  formatActivityChartAverage,
  formatCompactNumber,
  formatConversationDuration,
  formatCostTotal,
  formatElapsedDuration,
  formatPayloadSize,
  formatRelativeMessageTimestamp,
  formatRuntime,
  formatTime,
  formatTranscriptTimestampDetails,
  formatTranscriptDuration,
  formatUsageTotal,
  parseMarkdownBlocks,
  peoplePath,
  slackLocationLabel,
  setDashboardTimeZone,
  summarizeMessages,
  summarizeToolCalls,
  summarizeTurns,
} from "../src/client/format";
import { formatDuration } from "../src/client/components/Duration";
import type { ConversationTranscript } from "../src/client/types";

afterEach(() => {
  vi.useRealTimers();
  setDashboardTimeZone("America/Los_Angeles");
});

function event(
  seq: number,
  data: ConversationReportEventData,
): ConversationReportEvent {
  return {
    seq,
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    data,
  };
}

function transcript(
  events: ConversationReportEvent[] = [],
  overrides: Partial<ConversationTranscript> = {},
): ConversationTranscript {
  const startedAt = "2026-01-01T00:00:00.000Z";
  return {
    conversationId: "conversation-1",
    cumulativeDurationMs: 0,
    displayTitle: "Conversation",
    eventHistory: { status: "available" },
    events,
    generatedAt: startedAt,
    isParticipant: false,
    lastProgressAt: startedAt,
    lastSeenAt: startedAt,
    startedAt,
    status: "completed",
    surface: "internal",
    ...overrides,
  };
}

describe("dashboard conversation formatting", () => {
  it("builds direct person profile routes", () => {
    expect(peoplePath("avery@example.com")).toBe("/people/avery%40example.com");
  });

  it("scales large values through billions and trillions", () => {
    expect(formatCompactNumber(1_912_000_000)).toBe("1.9b");
    expect(formatCompactNumber(2_100_000_000_000)).toBe("2.1t");
  });

  it("keeps fractional chart averages readable below ten", () => {
    expect(formatActivityChartAverage(0.4)).toBe("0.4");
    expect(formatActivityChartAverage(1.25)).toBe("1.3");
    expect(formatActivityChartAverage(12)).toBe("12");
    expect(formatActivityChartAverage(1_200_000_000)).toBe("1.2b");
  });

  it("formats cumulative conversation usage", () => {
    expect(
      formatUsageTotal({
        cachedInputTokens: 25,
        cacheCreationTokens: 30,
        inputTokens: 10,
        outputTokens: 15,
        totalTokens: 999,
      }),
    ).toBe("80 tokens");
    expect(formatCostTotal({ cost: { total: 1.999 } })).toBe("$2.00");
    expect(formatCostTotal({ cost: { total: 0.0042 } })).toBe("$0.0042");
  });

  it("formats human-readable durations at increasing scales", () => {
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(3_500)).toBe("3.5s");
    expect(formatDuration(2_700_000)).toBe("45m");
    expect(formatDuration(839_497_000)).toBe("9d 17h 11m 37s");
    expect(formatDuration(11_117_520_000)).toBe("4mo 8d 16h 12m");
  });

  it("formats serialized payload sizes for transcript metadata", () => {
    expect(formatPayloadSize("hello")).toBe("5b");
    expect(formatPayloadSize({ ok: true })).toBe("11b");
    expect(formatPayloadSize("é")).toBe("2b");
    expect(formatPayloadSize("x".repeat(5_100))).toBe("5kb");
    expect(formatPayloadSize(undefined)).toBeUndefined();
  });

  it("formats cumulative conversation runtime", () => {
    expect(formatRuntime(3_500)).toBe("3.5s");
    expect(formatRuntime(0)).toBe("");
    expect(formatTranscriptDuration({ cumulativeDurationMs: 7_000 })).toBe(
      "7.0s",
    );
  });

  it("formats elapsed transcript event durations", () => {
    expect(formatElapsedDuration(1_000, 4_500)).toBe("3.5s");
    expect(formatElapsedDuration(undefined, 4_500)).toBeUndefined();
    expect(formatElapsedDuration(4_500, 1_000)).toBeUndefined();
  });

  it("formats old transcript timestamps relative to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T16:00:00.000Z"));
    expect(
      formatRelativeMessageTimestamp(Date.parse("2026-08-09T16:00:00.000Z")),
    ).toBe("yesterday");
  });

  it("formats canonical transcript timestamp details in local time and UTC", () => {
    setDashboardTimeZone("America/Los_Angeles");
    const details = formatTranscriptTimestampDetails(
      Date.parse("2026-08-10T16:00:00.000Z"),
    );
    expect(details.local).toContain("9:00:00 AM");
    expect(details.utc).toContain("4:00:00 PM");
  });

  it("formats absolute timestamps in the configured dashboard timezone", () => {
    const value = "2026-08-10T16:00:00.000Z";
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: "medium",
      timeStyle: "short",
    };
    setDashboardTimeZone("UTC");
    expect(formatTime(value, options)).toContain("4:00 PM");
    setDashboardTimeZone("America/Los_Angeles");
    expect(formatTime(value, options)).toContain("9:00 AM");
  });

  it("formats conversation duration from cumulative execution time", () => {
    const [conversation] = buildConversations([
      {
        conversationId: "slack:C1:123",
        cumulativeDurationMs: 7_000,
        displayTitle: "Conversation",
        isParticipant: false,
        lastProgressAt: "2026-06-01T10:02:29.000Z",
        lastSeenAt: "2026-06-01T10:02:29.000Z",
        startedAt: "2026-06-01T10:00:00.000Z",
        status: "completed",
        surface: "slack",
      },
    ]);

    expect(formatConversationDuration(conversation!)).toBe("7.0s");
  });

  it("omits conversation runtime when no execution time is recorded", () => {
    const [conversation] = buildConversations([
      {
        conversationId: "slack:C1:123",
        cumulativeDurationMs: 0,
        displayTitle: "Conversation",
        isParticipant: false,
        lastProgressAt: "2026-06-01T10:02:29.000Z",
        lastSeenAt: "not-a-date",
        startedAt: "2026-06-01T10:00:00.000Z",
        status: "completed",
        surface: "slack",
      },
    ]);

    expect(formatConversationDuration(conversation!)).toBe("none");
  });

  it("summarizes visible canonical messages and structural tools", () => {
    const conversation = transcript(
      [
        event(0, {
          type: "message",
          messageId: "user",
          role: "user",
          text: "run search",
          actorIdentity: {
            fullName: "Taylor Chen",
            slackUserName: "taylor",
          },
        }),
        event(1, {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
            },
          ],
        }),
        event(2, {
          type: "subagent",
          startedSeq: 2,
          startedAt: "2026-01-01T00:00:02.000Z",
          childConversationId: "child-1",
          subagentKind: "advisor",
          parentToolCallId: "search-1",
          status: "running",
        }),
        event(3, {
          type: "message",
          messageId: "assistant",
          role: "assistant",
          text: "done",
        }),
      ],
      { actorIdentity: { fullName: "Alice" } },
    );

    expect(conversationMessageCount(conversation)).toBe(2);
    expect(summarizeToolCalls(conversation)).toEqual({
      items: [{ count: 1, name: "search" }],
      total: 1,
    });
    expect(summarizeMessages(conversation)).toEqual({
      items: [
        { author: "Taylor Chen", bytes: 10 },
        { author: "Junior", bytes: 4 },
      ],
      total: 2,
    });
    expect(summarizeTurns(conversation)).toEqual({
      items: [{ author: "Taylor Chen", bytes: 10 }],
      total: 1,
    });
  });

  it("does not count assistant-only history as actor turns", () => {
    const conversation = transcript([
      event(0, {
        type: "message",
        messageId: "assistant",
        role: "assistant",
        text: "proactive update",
      }),
    ]);
    expect(summarizeTurns(conversation)).toBeUndefined();
  });

  it("uses canonical detail metadata without carrying absent fields", () => {
    const detail = transcript([], {
      channel: "C1",
      channelName: "proj-alpha",
      conversationId: "slack:C1:123",
      displayTitle: "Detail Title",
      actorIdentity: { email: "alice@example.com" },
    });
    const conversation = conversationFromDetail(detail);
    expect(conversationDisplayTitle(conversation)).toBe("Detail Title");
    expect(conversationIdentityMeta(conversation, conversation?.id)).toBe(
      "alice@example.com · slack:C1:123",
    );
  });

  it("uses the most recent API-supplied display title", () => {
    const base = {
      conversationId: "slack:C1:123",
      cumulativeDurationMs: 0,
      isParticipant: false,
      lastProgressAt: "2026-06-01T10:05:00.000Z",
      startedAt: "2026-06-01T10:00:00.000Z",
      status: "completed" as const,
      surface: "slack" as const,
    };
    const [conversation] = buildConversations([
      {
        ...base,
        displayTitle: "Older",
        lastSeenAt: "2026-06-01T10:05:00.000Z",
      },
      {
        ...base,
        displayTitle: "Newer",
        lastSeenAt: "2026-06-01T11:05:00.000Z",
      },
    ]);
    expect(conversationDisplayTitle(conversation)).toBe("Newer");
  });

  it("filters conversation rows by text and source", () => {
    const summaries: ConversationSummaryReport[] = [
      {
        conversationId: "slack:C1:1",
        cumulativeDurationMs: 0,
        displayTitle: "Checkout incident",
        isParticipant: false,
        lastProgressAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "failed",
        surface: "slack",
      },
      {
        conversationId: "scheduler:1",
        cumulativeDurationMs: 0,
        displayTitle: "Daily digest",
        isParticipant: false,
        lastProgressAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        surface: "scheduler",
      },
    ];
    const rows = buildConversations(summaries);
    expect(filterConversationList(rows, { query: "checkout" })).toHaveLength(1);
    expect(filterConversationList(rows, { source: "scheduler" })).toHaveLength(
      1,
    );
  });

  it("formats actor and Slack labels", () => {
    expect(actorLabel({ slackUserName: "Alice Reviewer" })).toBe(
      "Alice Reviewer",
    );
    expect(
      conversationActorLabel({
        id: "1",
        cumulativeDurationMs: 0,
        displayTitle: "x",
        lastProgressAt: "x",
        lastSeenAt: "x",
        startedAt: "x",
        status: "completed",
        surface: "slack",
        actorIdentity: { email: "alice@example.com" },
      }),
    ).toBe("alice@example.com");
    expect(
      slackLocationLabel({
        channel: "C1",
        channelName: "proj-alpha",
        channelNameRedacted: false,
      }),
    ).toBe("#proj-alpha (C1)");
  });
});

describe("transcript blocks", () => {
  it("keeps prose as markdown and preserves fenced languages", () => {
    expect(
      parseMarkdownBlocks("The function returns a const value.")[0],
    ).toMatchObject({
      fenced: false,
      language: "markdown",
    });
    expect(parseMarkdownBlocks('```json\n{"ok":true}\n```')[0]).toMatchObject({
      fenced: true,
      language: "json",
    });
    expect(parseMarkdownBlocks("```xml\n<root />\n```")[0]).toMatchObject({
      fenced: true,
      language: "xml",
    });
  });
});
