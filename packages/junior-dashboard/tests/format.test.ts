import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummaryReport } from "@sentry/junior/api/schema";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import {
  buildConversations,
  canRenderStructuredMarkup,
  conversationDisplayTitle,
  conversationFromDetail,
  conversationIdentityMeta,
  conversationActorLabel,
  conversationActorOptions,
  conversationSourceOptions,
  filterConversationList,
  formatConversationDuration,
  formatCostTotal,
  formatRuntime,
  formatDurationTick,
  formatTranscriptDuration,
  formatUsageTotal,
  parseMarkdownBlocks,
  actorLabel,
  slackLocationLabel,
  summarizeMessages,
  summarizeCost,
  summarizeToolCalls,
  summarizeUsage,
  conversationMessageCount,
} from "../src/client/format";
import type { ConversationTranscript } from "../src/client/types";

afterEach(() => {
  vi.useRealTimers();
});

function transcript(
  overrides: Partial<ConversationTranscript> = {},
): ConversationTranscript {
  const startedAt = "2026-01-01T00:00:00.000Z";
  return {
    conversationId: "conversation-1",
    cumulativeDurationMs: 0,
    displayTitle: "Conversation",
    lastProgressAt: startedAt,
    lastSeenAt: startedAt,
    startedAt,
    status: "completed",
    surface: "internal",
    transcript: [],
    transcriptAvailable: true,
    ...overrides,
  };
}

describe("dashboard token formatting", () => {
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
  });

  it("formats cumulative estimated conversation cost", () => {
    const usage = {
      cost: {
        input: 0.005,
        output: 0.007,
        cacheRead: 0.0001,
        total: 0.0121,
      },
    };

    expect(summarizeCost(usage)).toEqual({
      input: 0.005,
      output: 0.007,
      cacheRead: 0.0001,
      cacheWrite: undefined,
      total: 0.0121,
    });
    expect(formatCostTotal(usage)).toBe("$0.0121");
  });

  it("formats cumulative conversation runtime", () => {
    expect(formatRuntime(3_500)).toBe("3.5s");
    expect(formatRuntime(0)).toBe("");
  });

  it("rounds long chart duration ticks to whole minutes", () => {
    expect(formatDurationTick(17 * 60_000 + 38_000)).toBe("18m");
    expect(formatDurationTick(9 * 60_000 + 38_000)).toBe("9m 38s");
    expect(formatDurationTick(9 * 60_000 + 59_900)).toBe("10m");
  });

  it("formats transcript duration from cumulative execution time", () => {
    expect(
      formatTranscriptDuration({
        cumulativeDurationMs: 7_000,
      }),
    ).toBe("7.0s");
  });

  it("counts conversational transcript messages instead of tool events", () => {
    const conversation = transcript({
      transcript: [
        {
          role: "user",
          parts: [{ type: "text", text: "run the search" }],
        },
        {
          role: "assistant",
          parts: [{ type: "thinking", output: "I should search first" }],
        },
        {
          role: "assistant",
          parts: [{ type: "tool_call", name: "search", input: {} }],
        },
        {
          role: "toolResult",
          parts: [{ type: "tool_result", name: "search", output: [] }],
        },
        {
          role: "assistant",
          parts: [{ type: "text", text: "done" }],
        },
      ],
    });

    expect(conversationMessageCount(conversation)).toBe(2);
  });

  it("summarizes tooltip metrics from visible transcripts", () => {
    const conversation = transcript({
      actorIdentity: { fullName: "alice" },
      transcript: [
        {
          role: "user",
          parts: [{ type: "text", text: "run search" }],
        },
        {
          role: "assistant",
          timestamp: 1_000,
          parts: [{ type: "tool_call", id: "call-1", name: "search" }],
        },
        {
          role: "toolResult",
          timestamp: 2_500,
          parts: [{ type: "tool_result", id: "call-1", name: "search" }],
        },
        {
          role: "assistant",
          parts: [{ type: "text", text: "done" }],
        },
      ],
    });

    expect(summarizeToolCalls(conversation)).toEqual({
      items: [{ count: 1, name: "search", totalDurationMs: 1_500 }],
      total: 1,
    });
    expect(summarizeMessages(conversation)).toEqual({
      items: [
        { author: "alice", bytes: 10 },
        { author: "Junior", bytes: 4 },
      ],
      total: 2,
    });
    expect(
      summarizeUsage({
        cachedInputTokens: 2,
        inputTokens: 3,
        outputTokens: 5,
        reasoningTokens: 10,
      }),
    ).toMatchObject({
      cachedInputTokens: 2,
      inputTokens: 3,
      outputTokens: 5,
      reasoningTokens: 10,
      totalTokens: 10,
    });
  });

  it("counts activity-only tool calls in tool summaries", () => {
    const conversation = {
      conversationId: "conversation-activity",
      cumulativeDurationMs: 0,
      displayTitle: "Activity",
      lastProgressAt: "2026-01-01T00:00:01.000Z",
      lastSeenAt: "2026-01-01T00:00:01.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      surface: "internal",
      transcriptAvailable: true,
      transcript: [],
      activity: [
        {
          type: "tool_execution",
          id: "call-activity",
          toolCallId: "call-activity",
          toolName: "advisor",
          createdAt: "2026-01-01T00:00:01.000Z",
          status: "running",
          subagents: [],
        },
      ],
    } satisfies ConversationTranscript;

    expect(summarizeToolCalls(conversation)).toEqual({
      items: [{ count: 1, name: "advisor" }],
      total: 1,
    });
  });

  it("uses transcript message count when only activity rows are visible", () => {
    const conversation = {
      conversationId: "conversation-activity",
      cumulativeDurationMs: 0,
      displayTitle: "Activity",
      lastProgressAt: "2026-01-01T00:00:01.000Z",
      lastSeenAt: "2026-01-01T00:00:01.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      surface: "internal",
      transcriptAvailable: true,
      transcript: [],
      transcriptMessageCount: 3,
      activity: [
        {
          type: "tool_execution",
          id: "call-activity",
          toolCallId: "call-activity",
          toolName: "advisor",
          createdAt: "2026-01-01T00:00:01.000Z",
          status: "running",
          subagents: [],
        },
      ],
    } satisfies ConversationTranscript;

    expect(conversationMessageCount(conversation)).toBe(3);
    expect(summarizeToolCalls(conversation)).toEqual({
      items: [{ count: 1, name: "advisor" }],
      total: 1,
    });
  });

  it("does not match id-bearing tool calls to name-only results", () => {
    const conversation = transcript({
      transcript: [
        {
          role: "assistant",
          timestamp: 1_000,
          parts: [{ type: "tool_call", id: "call-1", name: "search" }],
        },
        {
          role: "assistant",
          timestamp: 1_200,
          parts: [{ type: "tool_call", id: "call-2", name: "search" }],
        },
        {
          role: "toolResult",
          timestamp: 1_800,
          parts: [{ type: "tool_result", name: "search" }],
        },
      ],
    });

    expect(summarizeToolCalls(conversation)).toEqual({
      items: [{ count: 2, name: "search" }],
      total: 2,
    });
  });

  it("does not infer tool durations for unnamed calls and results", () => {
    const conversation = transcript({
      transcript: [
        {
          role: "assistant",
          timestamp: 1_000,
          parts: [{ type: "tool_call" }],
        },
        {
          role: "toolResult",
          timestamp: 2_000,
          parts: [{ type: "tool_result" }],
        },
      ],
    });

    expect(summarizeToolCalls(conversation)).toEqual({
      items: [{ count: 1, name: "unknown" }],
      total: 1,
    });
  });

  it("uses the API-supplied displayTitle directly", () => {
    const conversations: ConversationSummaryReport[] = [
      {
        channel: "C1",
        conversationId: "slack:C1:123",
        cumulativeDurationMs: 0,
        displayTitle: "Public Channel",
        lastProgressAt: "2026-06-01T10:05:00.000Z",
        lastSeenAt: "2026-06-01T10:05:00.000Z",
        actorIdentity: {
          slackUserId: "U1",
          slackUserName: "Alice Reviewer",
        },
        startedAt: "2026-06-01T10:00:00.000Z",
        status: "completed",
        surface: "slack",
      },
    ];
    const [conversation] = buildConversations(conversations);

    expect(conversationDisplayTitle(conversation)).toBe("Public Channel");
    expect(conversationIdentityMeta(conversation, conversation?.id)).toBe(
      "Alice Reviewer · slack:C1:123",
    );
  });

  it("does not render a fake identity line before route data exists", () => {
    expect(conversationIdentityMeta(undefined, undefined)).toBe("");
  });

  it("keeps Slack display names with spaces as actor labels", () => {
    expect(
      actorLabel({ slackUserId: "U1", slackUserName: "Alice Reviewer" }),
    ).toBe("Alice Reviewer");
  });

  it("uses the displayTitle from the most recent turn", () => {
    const [conversation] = buildConversations([
      {
        conversationId: "slack:C1:123",
        cumulativeDurationMs: 0,
        displayTitle: "Older title",
        lastProgressAt: "2026-06-01T10:05:00.000Z",
        lastSeenAt: "2026-06-01T10:05:00.000Z",
        startedAt: "2026-06-01T10:00:00.000Z",
        status: "completed",
        surface: "slack",
      },
      {
        conversationId: "slack:C1:123",
        cumulativeDurationMs: 0,
        displayTitle: "Newer title",
        lastProgressAt: "2026-06-01T11:05:00.000Z",
        lastSeenAt: "2026-06-01T11:05:00.000Z",
        startedAt: "2026-06-01T11:00:00.000Z",
        status: "completed",
        surface: "slack",
      },
    ]);

    expect(conversationDisplayTitle(conversation)).toBe("Newer title");
  });

  it("builds permalink header metadata from conversation detail reports", () => {
    const conversation = conversationFromDetail({
      channel: "C1",
      channelName: "proj-alpha",
      conversationId: "slack:C1:123",
      cumulativeDurationMs: 0,
      displayTitle: "Detail Title",
      generatedAt: "2026-06-01T11:06:00.000Z",
      lastProgressAt: "2026-06-01T11:05:00.000Z",
      lastSeenAt: "2026-06-01T11:05:00.000Z",
      actorIdentity: { email: "alice@example.com" },
      sentryConversationUrl: "https://sentry.example/conversations/123",
      startedAt: "2026-06-01T10:00:00.000Z",
      status: "completed",
      surface: "slack",
      transcriptAvailable: true,
      transcript: [],
    } satisfies ConversationDetailReport);

    expect(conversationDisplayTitle(conversation)).toBe("Detail Title");
    expect(conversation?.channelName).toBe("proj-alpha");
    expect(conversationIdentityMeta(conversation, conversation?.id)).toBe(
      "alice@example.com · slack:C1:123",
    );
  });

  it("does not carry missing SQL fields across conversation rows", () => {
    const [conversation] = buildConversations([
      {
        channel: "C1",
        channelName: "proj-alpha",
        conversationId: "slack:C1:123",
        cumulativeDurationMs: 0,
        displayTitle: "#proj-alpha",
        lastProgressAt: "2026-06-01T10:05:00.000Z",
        lastSeenAt: "2026-06-01T10:05:00.000Z",
        startedAt: "2026-06-01T10:00:00.000Z",
        status: "completed",
        surface: "slack",
      },
      {
        channel: "C1",
        conversationId: "slack:C1:123",
        cumulativeDurationMs: 0,
        displayTitle: "Public Channel",
        lastProgressAt: "2026-06-01T11:05:00.000Z",
        lastSeenAt: "2026-06-01T11:05:00.000Z",
        startedAt: "2026-06-01T11:00:00.000Z",
        status: "completed",
        surface: "slack",
      },
    ]);

    expect(conversation?.channelName).toBeUndefined();
    expect(conversationDisplayTitle(conversation)).toBe("Public Channel");
  });

  it("keeps actor labels even when the title matches", () => {
    const conversations: ConversationSummaryReport[] = [
      {
        channel: "C1",
        channelName: "alice",
        conversationId: "slack:C1:123",
        displayTitle: "Alice",
        cumulativeDurationMs: 0,
        lastProgressAt: "2026-06-01T10:05:00.000Z",
        lastSeenAt: "2026-06-01T10:05:00.000Z",
        actorIdentity: {
          fullName: "alice",
          slackUserId: "U1",
        },
        startedAt: "2026-06-01T10:00:00.000Z",
        status: "completed",
        surface: "slack",
      },
    ];
    const [conversation] = buildConversations(conversations);

    expect(conversationActorLabel(conversation)).toBe("alice");
    expect(conversationIdentityMeta(conversation, conversation?.id)).toBe(
      "alice · slack:C1:123",
    );
  });

  it("filters conversation rows by text, source, and actor", () => {
    const conversations = buildConversations([
      {
        channel: "C1",
        channelName: "proj-checkout",
        conversationId: "slack:C1:123",
        cumulativeDurationMs: 0,
        displayTitle: "Checkout latency triage",
        lastProgressAt: "2026-06-01T10:05:00.000Z",
        lastSeenAt: "2026-06-01T10:05:00.000Z",
        actorIdentity: {
          email: "morgan@example.com",
          fullName: "Morgan Lee",
        },
        startedAt: "2026-06-01T10:00:00.000Z",
        status: "completed",
        surface: "slack",
      },
      {
        conversationId: "internal:memory:456",
        cumulativeDurationMs: 0,
        displayTitle: "Memory cleanup",
        lastProgressAt: "2026-06-01T11:05:00.000Z",
        lastSeenAt: "2026-06-01T11:05:00.000Z",
        actorIdentity: { fullName: "Casey" },
        startedAt: "2026-06-01T11:00:00.000Z",
        status: "completed",
        surface: "internal",
      },
    ]);

    expect(conversationSourceOptions(conversations)).toEqual([
      { label: "internal", value: "internal" },
      { label: "slack", value: "slack" },
    ]);
    expect(conversationActorOptions(conversations)).toEqual([
      { label: "Casey", value: "Casey" },
      { label: "Morgan Lee", value: "morgan@example.com" },
    ]);
    expect(
      filterConversationList(conversations, {
        query: "checkout",
        actor: "morgan@example.com",
        source: "slack",
      }).map((conversation) => conversation.id),
    ).toEqual(["slack:C1:123"]);
    expect(
      filterConversationList(conversations, {
        query: "checkout",
        actor: "Casey",
        source: "slack",
      }),
    ).toEqual([]);
  });

  it("formats cumulative runtime instead of the conversation wall time", () => {
    const [conversation] = buildConversations([
      {
        conversationId: "slack:C1:123",
        cumulativeDurationMs: 7_000,
        displayTitle: "Conversation",
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
        lastProgressAt: "2026-06-01T10:02:29.000Z",
        lastSeenAt: "not-a-date",
        startedAt: "2026-06-01T10:00:00.000Z",
        status: "completed",
        surface: "slack",
      },
    ]);

    expect(formatConversationDuration(conversation!)).toBe("none");
  });
});

describe("parseMarkdownBlocks prose language detection", () => {
  describe("default mode (detectLanguage — for user/system messages)", () => {
    it("detects XML-looking prose as xml", () => {
      const [block] = parseMarkdownBlocks("<foo>bar</foo>");
      expect(block?.language).toBe("xml");
      expect(block?.fenced).toBe(false);
    });

    it("detects HTML-looking prose as xml or html (collapsible)", () => {
      const [block] = parseMarkdownBlocks("<div>Hello</div>");
      expect(["xml", "html"]).toContain(block?.language);
    });

    it("detects mixed prose + block-level XML as xml (system prompt pattern)", () => {
      const text = [
        "You are a Slack-based helper assistant.",
        "",
        "<identity>",
        "Your Slack username is `junior`.",
        "</identity>",
        "",
        "<personality>",
        "## core identity",
        "- you are junior",
        "</personality>",
      ].join("\n");
      const [block] = parseMarkdownBlocks(text);
      expect(block?.language).toBe("xml");
    });

    it("does not detect an unclosed block tag as xml", () => {
      const text = [
        "Here is an example:",
        "",
        "<div>",
        "## heading",
        "- bullet",
      ].join("\n");
      expect(parseMarkdownBlocks(text)[0]?.language).not.toBe("xml");
    });

    it("keeps normal markdown without XML blocks as markdown", () => {
      const text = ["Intro", "", "## heading", "- bullet"].join("\n");
      expect(parseMarkdownBlocks(text)[0]?.language).toBe("markdown");
    });

    it("detects valid JSON prose as json", () => {
      const [block] = parseMarkdownBlocks('{"a":1}');
      expect(block?.language).toBe("json");
      expect(block?.fenced).toBe(false);
    });

    it("marks prose blocks as not fenced", () => {
      const blocks = parseMarkdownBlocks("some prose text");
      expect(blocks[0]?.fenced).toBe(false);
    });

    it("marks explicit fenced blocks as fenced", () => {
      const blocks = parseMarkdownBlocks("before\n```xml\n<foo/>\n```\nafter");
      expect(blocks[1]?.language).toBe("xml");
      expect(blocks[1]?.fenced).toBe(true);
    });
  });

  describe("outputOnly: true mode (detectOutputLanguage — for assistant messages)", () => {
    it("treats XML-looking prose as markdown, never auto-detects XML", () => {
      const [block] = parseMarkdownBlocks("<foo>bar</foo>", {
        outputOnly: true,
      });
      expect(block?.language).toBe("markdown");
      expect(block?.fenced).toBe(false);
    });

    it("treats HTML-looking prose as markdown", () => {
      const [block] = parseMarkdownBlocks("<div>Hello</div>", {
        outputOnly: true,
      });
      expect(block?.language).toBe("markdown");
    });

    it("treats TypeScript-looking prose as markdown", () => {
      const [block] = parseMarkdownBlocks("const value = 1;", {
        outputOnly: true,
      });
      expect(block?.language).toBe("markdown");
    });

    it("treats shell-looking prose as markdown", () => {
      const [block] = parseMarkdownBlocks("npm install", { outputOnly: true });
      expect(block?.language).toBe("markdown");
    });

    it("detects valid JSON prose as json and pretty-prints it", () => {
      const [block] = parseMarkdownBlocks('{"a":1}', { outputOnly: true });
      expect(block?.language).toBe("json");
      expect(block?.code).toBe('{\n  "a": 1\n}');
      expect(block?.fenced).toBe(false);
    });

    it("keeps prose blocks as markdown even when fenced XML is present", () => {
      const blocks = parseMarkdownBlocks("before\n```xml\n<foo/>\n```\nafter", {
        outputOnly: true,
      });
      expect(blocks[0]?.language).toBe("markdown");
      expect(blocks[0]?.fenced).toBe(false);
      expect(blocks[2]?.language).toBe("markdown");
      expect(blocks[2]?.fenced).toBe(false);
    });

    it("still detects fenced xml blocks as xml", () => {
      const blocks = parseMarkdownBlocks("before\n```xml\n<foo/>\n```\nafter", {
        outputOnly: true,
      });
      expect(blocks[1]?.language).toBe("xml");
      expect(blocks[1]?.fenced).toBe(true);
    });
  });
});

describe("canRenderStructuredMarkup", () => {
  it("returns true for xml blocks regardless of fenced status", () => {
    expect(
      canRenderStructuredMarkup({
        code: "<foo/>",
        language: "xml",
        fenced: false,
      }),
    ).toBe(true);
    expect(
      canRenderStructuredMarkup({
        code: "<foo/>",
        language: "xml",
        fenced: true,
      }),
    ).toBe(true);
    expect(canRenderStructuredMarkup({ code: "<foo/>", language: "xml" })).toBe(
      true,
    );
  });

  it("returns true for html blocks", () => {
    expect(
      canRenderStructuredMarkup({
        code: "<div/>",
        language: "html",
        fenced: true,
      }),
    ).toBe(true);
    expect(
      canRenderStructuredMarkup({ code: "<div/>", language: "html" }),
    ).toBe(true);
  });

  it("returns false for non-xml/html blocks", () => {
    expect(
      canRenderStructuredMarkup({
        code: "const x = 1",
        language: "typescript",
        fenced: true,
      }),
    ).toBe(false);
  });

  it("returns false for markdown blocks", () => {
    expect(
      canRenderStructuredMarkup({ code: "some text", language: "markdown" }),
    ).toBe(false);
  });

  // The guard against assistant prose misclassification is now at the
  // parseMarkdownBlocks level (outputOnly option), not canRenderStructuredMarkup.
  it("relies on caller to pass outputOnly:true for assistant prose", () => {
    // With outputOnly:true, XML-looking assistant prose stays as markdown
    const [block] = parseMarkdownBlocks("<foo>bar</foo>", { outputOnly: true });
    expect(block?.language).toBe("markdown");
    expect(canRenderStructuredMarkup(block!)).toBe(false);
  });
});

describe("slackLocationLabel redacted labels", () => {
  it("returns redacted type labels verbatim when the report marks them redacted", () => {
    expect(
      slackLocationLabel({
        channel: "C123",
        channelName: "Private Conversation",
        channelNameRedacted: true,
      }),
    ).toBe("Private Conversation (C123)");
    expect(
      slackLocationLabel(
        {
          channel: "C123",
          channelName: "Private Conversation",
          channelNameRedacted: true,
        },
        { includeId: false },
      ),
    ).toBe("Private Conversation");
  });

  it("still formats real channel names with a # prefix", () => {
    expect(
      slackLocationLabel(
        { channel: "C123", channelName: "proj-alpha" },
        { includeId: false },
      ),
    ).toBe("#proj-alpha");
    expect(
      slackLocationLabel(
        { channel: "C123", channelName: "Private Conversation" },
        { includeId: false },
      ),
    ).toBe("#Private Conversation");
  });
});
