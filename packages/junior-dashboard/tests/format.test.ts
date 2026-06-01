import { describe, expect, it } from "vitest";

import {
  buildConversations,
  canRenderStructuredMarkup,
  conversationDisplayTitle,
  conversationIdentityMeta,
  conversationRequesterLabel,
  formatConversationDuration,
  formatDurationTotal,
  formatDurationTick,
  formatTokenTotal,
  formatUsageTotal,
  parseMarkdownBlocks,
  summarizeMessages,
  summarizeToolCalls,
  summarizeUsage,
  turnMessageCount,
} from "../src/client/format";
import type { ConversationTurn, Session } from "../src/client/types";

describe("dashboard token formatting", () => {
  it("sums turn usage for conversation totals", () => {
    expect(
      formatUsageTotal([
        { totalTokens: 125 },
        {
          cachedInputTokens: 25,
          cacheCreationTokens: 30,
          inputTokens: 10,
          outputTokens: 15,
          totalTokens: 999,
        },
      ]),
    ).toBe("205 tokens");
  });

  it("uses component counters for token totals when present", () => {
    expect(
      formatTokenTotal({
        cachedInputTokens: 10,
        inputTokens: 20,
        outputTokens: 30,
        totalTokens: 999,
      }),
    ).toBe("60 tokens");
  });

  it("sums turn runtime when duration data exists", () => {
    expect(formatDurationTotal([1_000, 2_500, undefined])).toBe("3.5s");
  });

  it("rounds long chart duration ticks to whole minutes", () => {
    expect(formatDurationTick(17 * 60_000 + 38_000)).toBe("18m");
    expect(formatDurationTick(9 * 60_000 + 38_000)).toBe("9m 38s");
    expect(formatDurationTick(9 * 60_000 + 59_900)).toBe("10m");
  });

  it("counts conversational transcript messages instead of tool events", () => {
    const turn = {
      id: "turn-1",
      status: "completed",
      transcriptAvailable: true,
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
    } as ConversationTurn;

    expect(turnMessageCount(turn)).toBe(2);
  });

  it("summarizes tooltip metrics from visible transcripts", () => {
    const turn = {
      id: "turn-1",
      requester: "alice",
      status: "completed",
      transcriptAvailable: true,
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
    } as ConversationTurn;

    expect(summarizeToolCalls([turn])).toEqual({
      items: [{ count: 1, name: "search", totalDurationMs: 1_500 }],
      total: 1,
    });
    expect(summarizeMessages([turn])).toEqual({
      items: [
        { author: "alice", bytes: 10 },
        { author: "Junior", bytes: 4 },
      ],
      total: 2,
    });
    expect(
      summarizeUsage([
        { cachedInputTokens: 2, inputTokens: 3, outputTokens: 5 },
        { totalTokens: 7 },
      ]),
    ).toMatchObject({
      cachedInputTokens: 2,
      inputTokens: 3,
      outputTokens: 5,
      providerTotalTokens: 7,
      totalTokens: 17,
    });
  });

  it("does not match tool durations across different turns", () => {
    const turns = [
      {
        id: "turn-1",
        status: "completed",
        transcriptAvailable: true,
        transcript: [
          {
            role: "assistant",
            timestamp: 1_000,
            parts: [{ type: "tool_call", name: "search" }],
          },
        ],
      },
      {
        id: "turn-2",
        status: "completed",
        transcriptAvailable: true,
        transcript: [
          {
            role: "toolResult",
            timestamp: 2_000,
            parts: [{ type: "tool_result", name: "search" }],
          },
        ],
      },
    ] as ConversationTurn[];

    expect(summarizeToolCalls(turns)).toEqual({
      items: [{ count: 1, name: "search" }],
      total: 1,
    });
  });

  it("does not match id-bearing tool calls to name-only results", () => {
    const turn = {
      id: "turn-1",
      status: "completed",
      transcriptAvailable: true,
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
    } as ConversationTurn;

    expect(summarizeToolCalls([turn])).toEqual({
      items: [{ count: 2, name: "search" }],
      total: 2,
    });
  });

  it("does not synthesize conversation titles from requester display names", () => {
    const sessions: Session[] = [
      {
        channel: "C1",
        conversationId: "slack:C1:123",
        id: "turn-1",
        lastSeenAt: "2026-06-01T10:05:00.000Z",
        requesterIdentity: {
          slackUserId: "U1",
          slackUserName: "Alice Reviewer",
        },
        startedAt: "2026-06-01T10:00:00.000Z",
        status: "completed",
        surface: "slack",
        title: "Turn turn-1",
      },
    ];
    const [conversation] = buildConversations(sessions);

    expect(conversationDisplayTitle(conversation)).toBe("Public Channel");
    expect(conversationIdentityMeta(conversation, conversation?.id)).toBe(
      "U1 · slack:C1:123",
    );
  });

  it("suppresses redundant conversation requester labels", () => {
    const sessions: Session[] = [
      {
        channel: "C1",
        channelName: "alice",
        conversationId: "slack:C1:123",
        conversationTitle: "Alice",
        id: "turn-1",
        lastSeenAt: "2026-06-01T10:05:00.000Z",
        requesterIdentity: {
          fullName: "alice",
          slackUserId: "U1",
        },
        startedAt: "2026-06-01T10:00:00.000Z",
        status: "completed",
        surface: "slack",
        title: "Turn turn-1",
      },
    ];
    const [conversation] = buildConversations(sessions);

    expect(conversationRequesterLabel(conversation)).toBeUndefined();
    expect(conversationIdentityMeta(conversation, conversation?.id)).toBe(
      "slack:C1:123",
    );
  });

  it("formats conversation spans with the compact conversation duration rules", () => {
    const [conversation] = buildConversations([
      {
        conversationId: "slack:C1:123",
        id: "turn-1",
        lastSeenAt: "2026-06-01T10:02:29.000Z",
        startedAt: "2026-06-01T10:00:00.000Z",
        status: "completed",
        title: "Turn turn-1",
      },
    ]);

    expect(formatConversationDuration(conversation!)).toBe("2m");
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
