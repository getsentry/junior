import { describe, expect, it, vi } from "vitest";

vi.mock("@/chat/skills", () => ({
  discoverSkills: vi.fn(async () => {
    throw new Error("discover failed");
  }),
  findSkillByName: vi.fn(),
  parseSkillInvocation: vi.fn(),
}));

import { generateAssistantReply } from "@/chat/respond";

describe("generateAssistantReply error path", () => {
  it("preserves sandbox dependency hash on non-retryable failures", async () => {
    const reply = await generateAssistantReply("hello", {
      sandbox: {
        sandboxId: "sb-123",
        sandboxDependencyProfileHash: "hash-abc",
      },
    });

    expect(reply.text).toContain("Error: discover failed");
    expect(reply.sandboxId).toBe("sb-123");
    expect(reply.sandboxDependencyProfileHash).toBe("hash-abc");
    expect(reply.diagnostics.outcome).toBe("provider_error");
    expect(reply.diagnostics.modelId).toBe("openai/gpt-5.4");
    expect(reply.diagnostics.reasoningEffort).toBeUndefined();
  });
});
