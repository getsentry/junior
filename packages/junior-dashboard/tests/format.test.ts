import { describe, expect, it } from "vitest";

import {
  canRenderStructuredMarkup,
  formatDurationTotal,
  formatTokenTotal,
  formatUsageTotal,
  parseMarkdownBlocks,
  turnMessageCount,
} from "../src/client/format";
import type { ConversationTurn } from "../src/client/types";

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
});

describe("parseMarkdownBlocks output language detection", () => {
  it("treats XML-looking prose as markdown, never auto-detects XML", () => {
    const [block] = parseMarkdownBlocks("<foo>bar</foo>");
    expect(block?.language).toBe("markdown");
    expect(block?.fenced).toBe(false);
  });

  it("treats HTML-looking prose as markdown", () => {
    const [block] = parseMarkdownBlocks("<div>Hello</div>");
    expect(block?.language).toBe("markdown");
  });

  it("treats TypeScript-looking prose as markdown", () => {
    const [block] = parseMarkdownBlocks("const value = 1;");
    expect(block?.language).toBe("markdown");
  });

  it("treats shell-looking prose as markdown", () => {
    const [block] = parseMarkdownBlocks("npm install");
    expect(block?.language).toBe("markdown");
  });

  it("detects valid JSON prose as json and pretty-prints it", () => {
    const [block] = parseMarkdownBlocks('{"a":1}');
    expect(block?.language).toBe("json");
    expect(block?.code).toBe('{\n  "a": 1\n}');
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

  it("keeps prose blocks as markdown when fenced XML is present", () => {
    const blocks = parseMarkdownBlocks("before\n```xml\n<foo/>\n```\nafter");
    expect(blocks[0]?.language).toBe("markdown");
    expect(blocks[0]?.fenced).toBe(false);
    expect(blocks[2]?.language).toBe("markdown");
    expect(blocks[2]?.fenced).toBe(false);
  });
});

describe("canRenderStructuredMarkup", () => {
  it("returns false for auto-detected prose (fenced: false)", () => {
    expect(
      canRenderStructuredMarkup({ code: "<foo/>", language: "xml", fenced: false }),
    ).toBe(false);
  });

  it("returns true for explicitly-fenced xml", () => {
    expect(
      canRenderStructuredMarkup({ code: "<foo/>", language: "xml", fenced: true }),
    ).toBe(true);
  });

  it("returns true for explicitly-fenced html", () => {
    expect(
      canRenderStructuredMarkup({ code: "<div/>", language: "html", fenced: true }),
    ).toBe(true);
  });

  it("returns false for fenced non-xml/html blocks", () => {
    expect(
      canRenderStructuredMarkup({ code: "const x = 1", language: "typescript", fenced: true }),
    ).toBe(false);
  });

  it("returns false when fenced is undefined", () => {
    expect(
      canRenderStructuredMarkup({ code: "<foo/>", language: "xml" }),
    ).toBe(false);
  });
});
