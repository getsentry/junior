import { describe, expect, it } from "vitest";
import { buildSlackOutputMessage, ensureBlockSpacing, slackOutputPolicy } from "@/chat/output";
import { createNormalizingStream } from "@/chat/bot";

describe("buildSlackOutputMessage", () => {
  it("returns inline markdown for short content", () => {
    const message = buildSlackOutputMessage("hello\nworld");

    expect(typeof message).toBe("object");
    expect("markdown" in (message as object)).toBe(true);
    expect((message as { markdown: string }).markdown).toBe("hello\n\nworld");
    expect((message as { files?: unknown[] }).files).toBeUndefined();
  });

  it("keeps long content inline by default", () => {
    const longText = Array.from({ length: slackOutputPolicy.maxInlineLines + 8 }, (_, i) => `line ${i + 1}`).join("\n");
    const expectedText = Array.from({ length: slackOutputPolicy.maxInlineLines + 8 }, (_, i) => `line ${i + 1}`).join("\n\n");
    const message = buildSlackOutputMessage(longText) as {
      markdown: string;
      files?: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };

    expect(message.markdown).toBe(expectedText);
    expect(message.files).toBeUndefined();
  });

  it("includes provided files on inline responses", () => {
    const message = buildSlackOutputMessage("Image generated.", {
      files: [
        {
          data: Buffer.from("img-bytes"),
          filename: "generated-image-1.png",
          mimeType: "image/png"
        }
      ]
    }) as {
      markdown: string;
      files?: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };

    expect(message.markdown).toBe("Image generated.");
    expect(message.files?.length).toBe(1);
    expect(message.files?.[0].filename).toBe("generated-image-1.png");
    expect(message.files?.[0].mimeType).toBe("image/png");
  });

  it("normalizes whitespace and line endings", () => {
    const message = buildSlackOutputMessage("one\r\n\r\n\r\n\r\ntwo   \n") as { markdown: string };

    expect(message.markdown).toBe("one\n\ntwo");
  });
});

describe("ensureBlockSpacing", () => {
  it("inserts blank line between prose and list", () => {
    expect(ensureBlockSpacing("done.\n- #37\n- #38")).toBe("done.\n\n- #37\n- #38");
  });

  it("preserves existing blank line between prose and list", () => {
    expect(ensureBlockSpacing("done.\n\n- #37\n- #38")).toBe("done.\n\n- #37\n- #38");
  });

  it("keeps consecutive list items compact", () => {
    expect(ensureBlockSpacing("- #37\n- #38")).toBe("- #37\n- #38");
  });

  it("inserts blank line between prose lines", () => {
    expect(ensureBlockSpacing("sentence one.\nsentence two.")).toBe("sentence one.\n\nsentence two.");
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
    expect(ensureBlockSpacing("done:\n* a\n* b\nfin.")).toBe("done:\n\n* a\n* b\n\nfin.");
  });

  it("handles ordered list items", () => {
    expect(ensureBlockSpacing("intro\n1. first\n2. second\nend")).toBe("intro\n\n1. first\n2. second\n\nend");
  });

  it("handles bullet list with •", () => {
    expect(ensureBlockSpacing("intro\n• a\n• b")).toBe("intro\n\n• a\n• b");
  });
});

async function collectStream(stream: AsyncIterable<string>): Promise<string> {
  let result = "";
  for await (const chunk of stream) {
    result += chunk;
  }
  return result;
}

async function* chunksToIterable(chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("createNormalizingStream", () => {
  it("produces same result as direct normalization", async () => {
    const chunks = ["Hello\n", "World\n"];
    const stream = createNormalizingStream(chunksToIterable(chunks), ensureBlockSpacing);
    const result = await collectStream(stream);
    expect(result).toBe(ensureBlockSpacing("Hello\nWorld\n"));
  });

  it("handles partial list item across chunk boundary", async () => {
    // "-" alone is not a list item, but "- b" is
    const chunks = ["- a\n-", " b"];
    const stream = createNormalizingStream(chunksToIterable(chunks), ensureBlockSpacing);
    const result = await collectStream(stream);
    expect(result).toBe(ensureBlockSpacing("- a\n- b"));
  });

  it("handles code fence split across chunks", async () => {
    const chunks = ["text\n`", "``\ncode\n```\nmore"];
    const stream = createNormalizingStream(chunksToIterable(chunks), ensureBlockSpacing);
    const result = await collectStream(stream);
    expect(result).toBe(ensureBlockSpacing("text\n```\ncode\n```\nmore"));
  });

  it("flushes final incomplete line", async () => {
    const chunks = ["hello"];
    const stream = createNormalizingStream(chunksToIterable(chunks), ensureBlockSpacing);
    const result = await collectStream(stream);
    expect(result).toBe("hello");
  });
});
