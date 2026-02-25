import { describe, expect, it } from "vitest";
import { buildSlackOutputMessage, slackOutputPolicy } from "@/chat/output";

describe("buildSlackOutputMessage", () => {
  it("returns inline markdown for short content", () => {
    const message = buildSlackOutputMessage("hello\nworld");

    expect(typeof message).toBe("object");
    expect("markdown" in (message as object)).toBe(true);
    expect((message as { markdown: string }).markdown).toBe("hello\nworld");
    expect((message as { files?: unknown[] }).files).toBeUndefined();
  });

  it("attaches markdown file for long content", () => {
    const longText = Array.from({ length: slackOutputPolicy.maxInlineLines + 8 }, (_, i) => `line ${i + 1}`).join("\n");
    const message = buildSlackOutputMessage(longText) as {
      markdown: string;
      files?: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };

    expect(message.markdown).toContain("Summary:");
    expect(message.markdown).toContain("Full response attached as");
    expect(message.files?.length).toBe(1);
    expect(message.files?.[0].mimeType).toBe("text/markdown");
    expect(message.files?.[0].filename.endsWith(".md")).toBe(true);
    expect(message.files?.[0].data.toString("utf8")).toBe(longText);
  });

  it("can force attachment even for short content", () => {
    const message = buildSlackOutputMessage("short summary", {
      forceAttachment: true,
      attachmentPrefix: "candidate-summary"
    }) as {
      markdown: string;
      files?: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };

    expect(message.markdown).toContain("Summary:");
    expect(message.files?.length).toBe(1);
    expect(message.files?.[0].filename.startsWith("candidate-summary-")).toBe(true);
    expect(message.files?.[0].data.toString("utf8")).toBe("short summary");
  });

  it("respects inline delivery directives embedded in model output", () => {
    const response = [
      "<delivery>",
      "mode: attachment",
      "attachment_prefix: candidate-summary",
      "</delivery>",
      "",
      "Snapshot",
      "- strong OSS track record"
    ].join("\n");

    const message = buildSlackOutputMessage(response) as {
      markdown: string;
      files?: Array<{ data: Buffer; filename: string; mimeType?: string }>;
    };

    expect(message.files?.length).toBe(1);
    expect(message.files?.[0].filename.startsWith("candidate-summary-")).toBe(true);
    expect(message.files?.[0].data.toString("utf8")).toContain("Snapshot");
    expect(message.markdown).not.toContain("<delivery>");
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
