import { describe, expect, it } from "vitest";
import {
  buildSlackOutputMessage,
  ensureBlockSpacing,
  resolveMentions,
  slackOutputPolicy,
} from "@/chat/slack/output";

describe("buildSlackOutputMessage", () => {
  it("returns inline markdown for short content", async () => {
    const message = await buildSlackOutputMessage("hello\nworld");

    expect(typeof message).toBe("object");
    expect("markdown" in (message as object)).toBe(true);
    expect((message as { markdown: string }).markdown).toBe("hello\n\nworld");
    expect((message as { files?: unknown[] }).files).toBeUndefined();
  });

  it("keeps long content inline by default", async () => {
    const longText = Array.from(
      { length: slackOutputPolicy.maxInlineLines + 8 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const expectedText = Array.from(
      { length: slackOutputPolicy.maxInlineLines + 8 },
      (_, i) => `line ${i + 1}`,
    ).join("\n\n");
    const message = (await buildSlackOutputMessage(longText)) as {
      markdown: string;
      files?: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };

    expect(message.markdown).toBe(expectedText);
    expect(message.files).toBeUndefined();
  });

  it("includes provided files on inline responses", async () => {
    const message = (await buildSlackOutputMessage("Image generated.", [
      {
        data: Buffer.from("img-bytes"),
        filename: "generated-image-1.png",
        mimeType: "image/png",
      },
    ])) as {
      markdown: string;
      files?: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };

    expect(message.markdown).toBe("Image generated.");
    expect(message.files?.length).toBe(1);
    expect(message.files?.[0].filename).toBe("generated-image-1.png");
    expect(message.files?.[0].mimeType).toBe("image/png");
  });

  it("returns raw empty content for file-only payloads", async () => {
    const message = (await buildSlackOutputMessage("", [
      {
        data: Buffer.from("img-bytes"),
        filename: "generated-image-1.png",
        mimeType: "image/png",
      },
    ])) as {
      raw?: string;
      files?: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };

    expect(message.raw).toBe("");
    expect(message.files?.length).toBe(1);
    expect(message.files?.[0].filename).toBe("generated-image-1.png");
    expect(message.files?.[0].mimeType).toBe("image/png");
  });

  it("normalizes whitespace and line endings", async () => {
    const message = (await buildSlackOutputMessage(
      "one\r\n\r\n\r\n\r\ntwo   \n",
    )) as {
      markdown: string;
    };

    expect(message.markdown).toBe("one\n\ntwo");
  });
});

describe("resolveMentions", () => {
  it("replaces @name with <@USERID> when participant is known", async () => {
    const participants = new Map([
      ["david.quintas", "U12345"],
      ["jane", "U99999"],
    ]);
    const result = await resolveMentions(
      "hey @david.quintas can you check this?",
      participants,
    );
    expect(result).toBe("hey <@U12345> can you check this?");
  });

  it("replaces multiple mentions", async () => {
    const participants = new Map([
      ["alice", "UA11111"],
      ["bob", "UB22222"],
    ]);
    const result = await resolveMentions("@alice and @bob", participants);
    expect(result).toBe("<@UA11111> and <@UB22222>");
  });

  it("leaves unresolvable names unchanged", async () => {
    const result = await resolveMentions("ping @unknownperson", new Map());
    // no workspace lookup in tests (no token); should leave unchanged
    expect(result).toBe("ping @unknownperson");
  });

  it("does not double-resolve already-formatted Slack mentions", async () => {
    const participants = new Map([["alice", "UA11111"]]);
    const result = await resolveMentions("<@UA11111> and @alice", participants);
    // <@UA11111> should not be touched; @alice should be resolved
    expect(result).toBe("<@UA11111> and <@UA11111>");
  });

  it("skips patterns that look like email addresses", async () => {
    const participants = new Map([["user", "U12345"]]);
    const result = await resolveMentions("send to user@example.com", participants);
    // email addresses should not be touched
    expect(result).toBe("send to user@example.com");
  });

  it("returns text unchanged when no @ patterns present", async () => {
    const result = await resolveMentions("no mentions here", new Map());
    expect(result).toBe("no mentions here");
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
