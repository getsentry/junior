import { describe, expect, it } from "vitest";
import {
  buildSlackOutputMessage,
  fitsSlackInlineBudget,
  getSlackContinuationMarker,
  getSlackInterruptionMarker,
  slackOutputPolicy,
  splitSlackReplyText,
} from "@/chat/slack/output";
import {
  ensureBlockSpacing,
  normalizeSlackReplyMarkdown,
} from "@/chat/slack/mrkdwn";

describe("normalizeSlackReplyMarkdown", () => {
  it("normalizes line endings and block spacing for Slack replies", () => {
    expect(
      normalizeSlackReplyMarkdown("one\r\n- item a\n- item b\r\n\r\ntwo   "),
    ).toBe("one\n\n- item a\n- item b\n\ntwo");
  });

  it("wraps a bare URL adjacent to bold markers — the core bug", () => {
    expect(
      normalizeSlackReplyMarkdown(
        "**PR is up: https://github.com/getsentry/sentry-docs/pull/18263**",
      ),
    ).toBe(
      "**PR is up: <https://github.com/getsentry/sentry-docs/pull/18263>**",
    );
  });

  it("does not convert CommonMark bold — markdown_text renders it natively", () => {
    expect(normalizeSlackReplyMarkdown("**bold text**")).toBe("**bold text**");
  });

  it("wraps a standalone bare URL", () => {
    expect(
      normalizeSlackReplyMarkdown("See https://example.com for details."),
    ).toBe("See <https://example.com> for details.");
  });

  it("does not double-wrap an already-explicit Slack link", () => {
    expect(normalizeSlackReplyMarkdown("<https://example.com>")).toBe(
      "<https://example.com>",
    );
  });

  it("does not double-wrap an existing labeled Slack link", () => {
    expect(normalizeSlackReplyMarkdown("<https://example.com|label>")).toBe(
      "<https://example.com|label>",
    );
  });

  it("preserves URL inside inline code", () => {
    expect(normalizeSlackReplyMarkdown("`https://example.com/*`")).toBe(
      "`https://example.com/*`",
    );
  });

  it("preserves URL inside a fenced code block", () => {
    const input = "before\n```\nhttps://example.com/*\n```\nafter";
    expect(normalizeSlackReplyMarkdown(input)).toBe(
      "before\n\n```\nhttps://example.com/*\n```\n\nafter",
    );
  });

  it("preserves a Markdown link without converting it", () => {
    expect(
      normalizeSlackReplyMarkdown("[PR](https://github.com/org/repo/pull/1)"),
    ).toBe("[PR](https://github.com/org/repo/pull/1)");
  });

  it("peels trailing sentence punctuation outside the URL", () => {
    expect(normalizeSlackReplyMarkdown("See https://example.com/foo.")).toBe(
      "See <https://example.com/foo>.",
    );
  });

  it("preserves balanced parentheses inside a URL", () => {
    expect(
      normalizeSlackReplyMarkdown(
        "See https://en.wikipedia.org/wiki/Foo_(bar) for info.",
      ),
    ).toBe("See <https://en.wikipedia.org/wiki/Foo_(bar)> for info.");
  });

  it("preserves URL query strings and fragments", () => {
    expect(
      normalizeSlackReplyMarkdown(
        "https://example.com/search?q=foo&bar=1#section",
      ),
    ).toBe("<https://example.com/search?q=foo&bar=1#section>");
  });

  it("preserves URLs with underscores", () => {
    expect(normalizeSlackReplyMarkdown("https://example.com/foo_bar/baz")).toBe(
      "<https://example.com/foo_bar/baz>",
    );
  });

  it("preserves a Markdown link whose URL contains balanced parentheses", () => {
    expect(
      normalizeSlackReplyMarkdown(
        "[wiki](https://en.wikipedia.org/wiki/Foo_(bar))",
      ),
    ).toBe("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))");
  });

  it("peels an enclosing closing parenthesis outside a bare URL", () => {
    expect(normalizeSlackReplyMarkdown("(https://example.com/foo)")).toBe(
      "(<https://example.com/foo>)",
    );
  });

  it("stops URL scan at pipe to prevent Slack link label spoofing", () => {
    expect(normalizeSlackReplyMarkdown("https://evil.com|trusted.com")).toBe(
      "<https://evil.com>|trusted.com",
    );
  });

  it("stops URL scan at * so glued emphasis markers stay outside", () => {
    expect(
      normalizeSlackReplyMarkdown("see https://example.com**bold** here"),
    ).toBe("see <https://example.com>**bold** here");
  });

  it("peels mixed trailing suffix in correct order (_ then .)", () => {
    expect(normalizeSlackReplyMarkdown("https://example.com/foo_.")).toBe(
      "<https://example.com/foo>_.",
    );
  });

  it("resumes URL wrapping after a fenced code block", () => {
    const input =
      "```python\nhttps://example.com/code**\n```\nhttps://example.com/outside**";
    expect(normalizeSlackReplyMarkdown(input)).toBe(
      "```python\nhttps://example.com/code**\n```\n\n<https://example.com/outside>**",
    );
  });
});

describe("buildSlackOutputMessage", () => {
  it("returns inline markdown for short content", () => {
    const message = buildSlackOutputMessage("hello\nworld");

    expect(typeof message).toBe("object");
    expect("markdown" in (message as object)).toBe(true);
    expect((message as { markdown: string }).markdown).toBe("hello\n\nworld");
    expect((message as { files?: unknown[] }).files).toBeUndefined();
  });

  it("keeps long content inline by default", () => {
    const longText = Array.from(
      { length: slackOutputPolicy.maxInlineLines + 8 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const expectedText = Array.from(
      { length: slackOutputPolicy.maxInlineLines + 8 },
      (_, i) => `line ${i + 1}`,
    ).join("\n\n");
    const message = buildSlackOutputMessage(longText) as {
      markdown: string;
      files?: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };

    expect(message.markdown).toBe(expectedText);
    expect(message.files).toBeUndefined();
  });

  it("normalizes whitespace and line endings", () => {
    const message = buildSlackOutputMessage("one\r\n\r\n\r\n\r\ntwo   \n") as {
      markdown: string;
    };

    expect(message.markdown).toBe("one\n\ntwo");
  });
});

describe("splitSlackReplyText", () => {
  it("splits long replies into inline-safe continuation chunks", () => {
    const longText = Array.from(
      { length: slackOutputPolicy.maxInlineLines + 24 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");

    const chunks = splitSlackReplyText(longText);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.endsWith(getSlackContinuationMarker())).toBe(true);
    expect(
      chunks
        .slice(0, -1)
        .every((chunk) => chunk.endsWith(getSlackContinuationMarker())),
    ).toBe(true);
    expect(chunks.every((chunk) => fitsSlackInlineBudget(chunk))).toBe(true);
  });

  it("preserves every line when reserving continuation marker space", () => {
    const longList = Array.from(
      { length: slackOutputPolicy.maxInlineLines + 1 },
      (_, i) => `- item ${i + 1}`,
    ).join("\n");

    const chunks = splitSlackReplyText(longList);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => fitsSlackInlineBudget(chunk))).toBe(true);
    for (let i = 1; i <= slackOutputPolicy.maxInlineLines + 1; i++) {
      expect(chunks.some((chunk) => chunk.includes(`- item ${i}`))).toBe(true);
    }
  });

  it("omits the continuation marker when a reply only needs two posts", () => {
    const text = "a".repeat(slackOutputPolicy.maxInlineChars + 1);
    const chunks = splitSlackReplyText(text);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.endsWith(getSlackContinuationMarker())).toBe(false);
    expect(chunks.every((chunk) => fitsSlackInlineBudget(chunk))).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("marks interrupted final replies explicitly", () => {
    const chunks = splitSlackReplyText("Partial output", {
      interrupted: true,
    });

    expect(chunks).toEqual([`Partial output${getSlackInterruptionMarker()}`]);
  });

  it("keeps interrupted continuation chunks within the inline budget", () => {
    const text = "a".repeat(
      slackOutputPolicy.maxInlineChars -
        getSlackInterruptionMarker().length +
        1,
    );

    const chunks = splitSlackReplyText(text, {
      interrupted: true,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.endsWith(getSlackContinuationMarker())).toBe(false);
    expect(chunks[1]?.endsWith(getSlackInterruptionMarker())).toBe(true);
    expect(chunks.every((chunk) => fitsSlackInlineBudget(chunk))).toBe(true);
    expect(
      chunks
        .map((chunk, index) => {
          if (index === chunks.length - 1) {
            return chunk.slice(0, -getSlackInterruptionMarker().length);
          }
          return chunk;
        })
        .join(""),
    ).toBe(text);
  });

  it("closes and reopens code fences across continuation chunks", () => {
    const code = Array.from(
      { length: slackOutputPolicy.maxInlineLines + 20 },
      (_, i) => `const value${i + 1} = ${i + 1};`,
    ).join("\n");
    const chunks = splitSlackReplyText(`\`\`\`ts\n${code}\n\`\`\``);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.endsWith("```")).toBe(true);
    expect(chunks[1]?.startsWith("```ts\n")).toBe(true);
    expect(chunks.every((chunk) => fitsSlackInlineBudget(chunk))).toBe(true);
  });
});

describe("ensureBlockSpacing", () => {
  it("inserts blank line between prose and list", () => {
    expect(ensureBlockSpacing("done.\n- #37\n- #38")).toBe(
      "done.\n\n- #37\n- #38",
    );
  });

  it("preserves existing blank line between prose and list", () => {
    expect(ensureBlockSpacing("done.\n\n- #37\n- #38")).toBe(
      "done.\n\n- #37\n- #38",
    );
  });

  it("keeps consecutive list items compact", () => {
    expect(ensureBlockSpacing("- #37\n- #38")).toBe("- #37\n- #38");
  });

  it("inserts blank line between prose lines", () => {
    expect(ensureBlockSpacing("sentence one.\nsentence two.")).toBe(
      "sentence one.\n\nsentence two.",
    );
  });

  it("preserves code block contents", () => {
    const input = "text\n```\ncode\ncode\n```\ntext";
    const result = ensureBlockSpacing(input);
    expect(result).toBe("text\n\n```\ncode\ncode\n```\n\ntext");
  });

  it("preserves already-spaced blocks", () => {
    expect(ensureBlockSpacing("a\n\nb")).toBe("a\n\nb");
  });

  it("inserts blank lines around list block within prose", () => {
    expect(ensureBlockSpacing("done:\n* a\n* b\nfin.")).toBe(
      "done:\n\n* a\n* b\n\nfin.",
    );
  });

  it("handles ordered list items", () => {
    expect(ensureBlockSpacing("intro\n1. first\n2. second\nend")).toBe(
      "intro\n\n1. first\n2. second\n\nend",
    );
  });

  it("handles bullet list with •", () => {
    expect(ensureBlockSpacing("intro\n• a\n• b")).toBe("intro\n\n• a\n• b");
  });
});
