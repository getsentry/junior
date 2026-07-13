import { describe, expect, it } from "vitest";
import { serializeGenAiAttribute } from "@/chat/logging";

describe("serializeGenAiAttribute", () => {
  it("redacts secret-looking strings before emitting trace attributes", () => {
    const slackToken = [
      "xoxb",
      "1234567890",
      "abcdefghijklmnopqrstuvwxyz",
    ].join("-");
    const serialized = serializeGenAiAttribute({
      bearer: "Bearer abcdefghijklmnopqrstuvwxyz1234567890",
      openai: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
      slack: slackToken,
      nested: {
        privateKey: [
          "-----BEGIN PRIVATE KEY-----",
          "super-secret-material",
          "-----END PRIVATE KEY-----",
        ].join("\n"),
      },
    });

    expect(serialized).toContain("Bearer abcd...7890");
    expect(serialized).toContain("sk-a...7890");
    expect(serialized).toContain("xoxb...wxyz");
    expect(serialized).toContain("...redacted...");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
    expect(serialized).not.toContain("super-secret-material");
  });

  it("omits oversized values instead of emitting invalid JSON", () => {
    expect(serializeGenAiAttribute({ value: "abcdef" }, 5)).toBeUndefined();
  });
});
