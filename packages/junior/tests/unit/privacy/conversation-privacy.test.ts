import { describe, expect, it } from "vitest";
import {
  canExposeConversationPayload,
  resolveConversationPrivacy,
  toCanonicalInputMessage,
  toGenAiPayloadMetadata,
  toGenAiPayloadTraceAttributes,
} from "@/chat/conversation-privacy";

describe("conversation privacy classification", () => {
  it.each(["public", "private"] as const)(
    "uses confirmed %s visibility",
    (visibility) => {
      expect(resolveConversationPrivacy({ visibility })).toBe(visibility);
    },
  );

  it.each(["direct", "unknown"] as const)(
    "treats confirmed %s visibility as private",
    (visibility) => {
      expect(resolveConversationPrivacy({ visibility })).toBe("private");
      expect(canExposeConversationPayload({ visibility })).toBe(false);
    },
  );

  it("defaults missing visibility to private", () => {
    expect(resolveConversationPrivacy({})).toBe("private");
    expect(canExposeConversationPayload({})).toBe(false);
  });
});

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
      "gen_ai.tool.call.arguments",
      payload,
    );

    expect(metadata.keys).toHaveLength(20);
    expect(metadata.keys).toContain("privateKey0");
    expect(metadata.keys).not.toContain("privateKey20");
    expect(attributes["gen_ai.tool.call.arguments.keys"]).toHaveLength(20);
    expect(attributes["gen_ai.tool.call.arguments.keys"]).toContain(
      "privateKey0",
    );
    expect(attributes["gen_ai.tool.call.arguments.keys"]).not.toContain(
      "privateKey20",
    );
    expect(attributes["gen_ai.tool.call.arguments.size"]).toBe(
      JSON.stringify(payload).length,
    );
    expect(JSON.stringify(metadata)).not.toContain("private value");
  });
});

describe("canonical GenAI messages", () => {
  it("represents tool results as tool_call_response parts", () => {
    expect(
      toCanonicalInputMessage({
        role: "toolResult",
        toolCallId: "call_123",
        toolName: "weather",
        content: [{ type: "text", text: "sunny" }],
        timestamp: 0,
      } as any),
    ).toEqual({
      role: "tool",
      parts: [
        {
          type: "tool_call_response",
          id: "call_123",
          response: [{ type: "text", content: "sunny" }],
        },
      ],
    });
  });
});
