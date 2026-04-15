import { describe, expect, it } from "vitest";
import {
  buildSlackOutputMessage,
  ensureBlockSpacing,
  fitsSlackInlineBudget,
  getSlackContinuationMarker,
  getSlackInterruptionMarker,
  slackOutputPolicy,
  splitSlackReplyText,
} from "@/chat/slack/output";

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

  it("includes provided files on inline responses", () => {
    const message = buildSlackOutputMessage("Image generated.", [
      {
        data: Buffer.from("img-bytes"),
        filename: "generated-image-1.png",
        mimeType: "image/png",
      },
    ]) as {
      markdown: string;
      files?: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };

    expect(message.markdown).toBe("Image generated.");
    expect(message.files?.length).toBe(1);
    expect(message.files?.[0].filename).toBe("generated-image-1.png");
    expect(message.files?.[0].mimeType).toBe("image/png");
  });

  it("returns raw empty content for file-only payloads", () => {
    const message = buildSlackOutputMessage("", [
      {
        data: Buffer.from("img-bytes"),
        filename: "generated-image-1.png",
        mimeType: "image/png",
      },
    ]) as {
      raw?: string;
      files?: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };

    expect(message.raw).toBe("");
    expect(message.files?.length).toBe(1);
    expect(message.files?.[0].filename).toBe("generated-image-1.png");
    expect(message.files?.[0].mimeType).toBe("image/png");
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
    expect(chunks[0]?.endsWith(getSlackContinuationMarker())).toBe(true);
    expect(chunks[1]?.endsWith(getSlackInterruptionMarker())).toBe(true);
    expect(chunks.every((chunk) => fitsSlackInlineBudget(chunk))).toBe(true);
    expect(
      chunks
        .map((chunk, index) => {
          if (index === chunks.length - 1) {
            return chunk.slice(0, -getSlackInterruptionMarker().length);
          }
          return chunk.slice(0, -getSlackContinuationMarker().length);
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
    expect(chunks[0]).toContain(`\`\`\`${getSlackContinuationMarker()}`);
    expect(chunks[1]?.startsWith("```ts\n")).toBe(true);
    expect(chunks.every((chunk) => fitsSlackInlineBudget(chunk))).toBe(true);
  });

  it("keeps pre-normalized continuation chunks stable when posting", () => {
    const code = Array.from(
      { length: slackOutputPolicy.maxInlineLines + 20 },
      (_, i) => `const value${i + 1} = ${i + 1};`,
    ).join("\n");
    const normalized = (
      buildSlackOutputMessage(`\`\`\`ts\n${code}\n\`\`\``) as {
        markdown: string;
      }
    ).markdown;
    const chunks = splitSlackReplyText(normalized, {
      normalized: true,
    });
    const message = buildSlackOutputMessage(chunks[0] ?? "", undefined, {
      normalized: true,
    }) as { markdown: string };

    expect(chunks[0]).toContain(`\`\`\`${getSlackContinuationMarker()}`);
    expect(message.markdown).toBe(chunks[0]);
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
