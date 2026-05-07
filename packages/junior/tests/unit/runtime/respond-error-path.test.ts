import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/chat/skills", () => ({
  discoverSkills: vi.fn(async () => {
    throw new Error("discover failed");
  }),
  findSkillByName: vi.fn(),
  parseSkillInvocation: vi.fn(),
}));

describe("generateAssistantReply error path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves sandbox dependency hash on non-retryable failures", async () => {
    vi.resetModules();
    vi.stubEnv("AI_MODEL", "openai/gpt-5.4");
    const { generateAssistantReply } = await import("@/chat/respond");

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
    expect(reply.diagnostics.thinkingLevel).toBeUndefined();
  });
});
