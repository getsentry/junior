import { describe, expect, it } from "vitest";
import {
  canExposeConversationPayload,
  resolveConversationPrivacy,
  toGenAiPayloadMetadata,
  toGenAiPayloadTraceAttributes,
} from "@/chat/conversation-privacy";

describe("conversation privacy classification", () => {
  it("never classifies a conversation public from a C-prefixed id alone", () => {
    expect(resolveConversationPrivacy({ channelId: "C123" })).toBeUndefined();
    expect(
      resolveConversationPrivacy({ conversationId: "slack:C123:1712345.0001" }),
    ).toBeUndefined();
    expect(canExposeConversationPayload({ channelId: "C123" })).toBe(false);
  });

  it("classifies public only from an explicit visibility signal", () => {
    expect(
      resolveConversationPrivacy({ channelId: "C123", visibility: "public" }),
    ).toBe("public");
    expect(
      resolveConversationPrivacy({
        conversationId: "slack:C123:details-only",
        visibility: "public",
      }),
    ).toBe("public");
    // Slack reported channel_type group despite the C prefix.
    expect(
      resolveConversationPrivacy({ channelId: "C123", visibility: "private" }),
    ).toBe("private");
  });

  it("narrows toward private from D/G prefixes even against a public claim", () => {
    expect(resolveConversationPrivacy({ channelId: "D123" })).toBe("private");
    expect(resolveConversationPrivacy({ channelId: "G123" })).toBe("private");
    expect(
      resolveConversationPrivacy({ channelId: "D123", visibility: "public" }),
    ).toBe("private");
  });

  it("classifies non-Slack conversations private", () => {
    expect(
      resolveConversationPrivacy({ conversationId: "local:workspace:run-1" }),
    ).toBe("private");
    expect(
      resolveConversationPrivacy({ conversationId: "agent-dispatch:run-2" }),
    ).toBe("private");
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
});
