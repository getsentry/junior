import { describe, expect, it } from "vitest";
import {
  toGenAiMessageMetadata,
  toGenAiMessagesTraceAttributes,
  toGenAiPayloadMetadata,
  toGenAiPayloadTraceAttributes,
  toGenAiTextMetadata,
} from "@/chat/conversation-privacy";

describe("conversation privacy metadata", () => {
  it("bounds top-level private payload keys", () => {
    const payload = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `privateKey${index}`,
        `private value ${index}`,
      ]),
    );

    const metadata = toGenAiPayloadMetadata(payload);
    const attributes = toGenAiPayloadTraceAttributes(
      "app.ai.tool.call.arguments",
      payload,
    );

    expect(metadata.keys).toHaveLength(20);
    expect(metadata.keys).toContain("privateKey0");
    expect(metadata.keys).not.toContain("privateKey20");
    expect(attributes["app.ai.tool.call.arguments.keys"]).toHaveLength(20);
    expect(attributes["app.ai.tool.call.arguments.keys"]).toContain(
      "privateKey0",
    );
    expect(attributes["app.ai.tool.call.arguments.keys"]).not.toContain(
      "privateKey20",
    );
    expect(JSON.stringify(metadata)).not.toContain("private value");
  });

  it("summarizes private message content without exposing raw text", () => {
    const message = {
      role: "user",
      content: [
        {
          type: "text",
          text: "private roadmap launch date",
        },
        {
          type: "image",
          mimeType: "image/png",
          data: "base64-image-data",
        },
      ],
    };

    const metadata = toGenAiMessageMetadata(message);
    const textMetadata = toGenAiTextMetadata("private system prompt");
    const attributes = toGenAiMessagesTraceAttributes("app.ai.input", [
      message,
    ]);

    expect(metadata).toEqual({
      role: "user",
      content: [
        { type: "text", chars: 27 },
        { type: "image", mimeType: "image/png", dataChars: 17 },
      ],
    });
    expect(textMetadata).toEqual({ type: "text", chars: 21 });
    expect(attributes).toEqual({
      "app.ai.input.message_count": 1,
      "app.ai.input.content_chars": 44,
      "app.ai.input.roles": ["user"],
      "app.ai.input.part_types": ["text", "image"],
    });
    expect(
      JSON.stringify({ metadata, textMetadata, attributes }),
    ).not.toContain("private roadmap");
    expect(
      JSON.stringify({ metadata, textMetadata, attributes }),
    ).not.toContain("private system prompt");
    expect(
      JSON.stringify({ metadata, textMetadata, attributes }),
    ).not.toContain("base64-image-data");
  });
});
