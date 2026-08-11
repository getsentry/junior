import { describe, expect, it } from "vitest";

import { conversationModelIdFromAssistantFields } from "@/chat/pi/sql-model-usage";

describe("conversationModelIdFromAssistantFields", () => {
  it("keeps vendor-prefixed gateway model ids", () => {
    expect(
      conversationModelIdFromAssistantFields({
        model: "openai/gpt-5.6-sol",
        provider: "vercel-ai-gateway",
      }),
    ).toBe("openai/gpt-5.6-sol");
  });

  it("joins bare model names with their vendor provider", () => {
    expect(
      conversationModelIdFromAssistantFields({
        model: "gpt-5",
        provider: "openai",
      }),
    ).toBe("openai/gpt-5");
  });
});
