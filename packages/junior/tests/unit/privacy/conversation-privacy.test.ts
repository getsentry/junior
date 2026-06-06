import { describe, expect, it } from "vitest";
import {
  toGenAiPayloadMetadata,
  toGenAiPayloadTraceAttributes,
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
});
