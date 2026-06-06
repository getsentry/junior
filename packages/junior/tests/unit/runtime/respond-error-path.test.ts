import { afterAll, describe, expect, it, vi } from "vitest";

const originalAiModel = process.env.AI_MODEL;

process.env.AI_MODEL = "openai/gpt-5.4";

vi.mock("@/chat/skills", () => ({
  discoverSkills: vi.fn(async () => {
    throw new Error("discover failed");
  }),
  findSkillByName: vi.fn(),
  parseSkillInvocation: vi.fn(),
}));

const { generateAssistantReply } = await import("@/chat/respond");

describe("generateAssistantReply error path", () => {
  afterAll(() => {
    if (originalAiModel === undefined) {
      delete process.env.AI_MODEL;
    } else {
      process.env.AI_MODEL = originalAiModel;
    }
  });

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
    expect(reply.diagnostics.thinkingLevel).toBeUndefined();
  }, 10_000);

  it("propagates pre-commit failures when durable input commit is required", async () => {
    await expect(
      generateAssistantReply("hello", {
        onInputCommitted: async () => {
          throw new Error("input should not commit before startup succeeds");
        },
      }),
    ).rejects.toThrow("discover failed");
  }, 10_000);
});
