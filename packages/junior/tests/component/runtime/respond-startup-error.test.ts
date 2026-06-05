import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  configureRespondRuntimeEnv,
  restoreRespondRuntimeEnv,
} from "../../fixtures/respond-env";

const originalEnv = configureRespondRuntimeEnv();

const { generateAssistantReply } = await import("@/chat/respond");
const { disconnectStateAdapter } = await import("@/chat/state/adapter");

describe("generateAssistantReply startup errors", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  afterAll(() => {
    restoreRespondRuntimeEnv(originalEnv);
  });

  it("preserves sandbox reuse metadata on non-retryable startup failures", async () => {
    const reply = await generateAssistantReply("hello", {
      sandbox: {
        sandboxId: "sb-123",
        sandboxDependencyProfileHash: "hash-abc",
      },
      sandboxExecutorFactory: () => {
        throw new Error("sandbox executor failed");
      },
    });

    expect(reply.text).toContain("Error: sandbox executor failed");
    expect(reply.sandboxId).toBe("sb-123");
    expect(reply.sandboxDependencyProfileHash).toBe("hash-abc");
    expect(reply.diagnostics.outcome).toBe("provider_error");
    expect(reply.diagnostics.modelId).toBe("openai/gpt-5.4");
    expect(reply.diagnostics.thinkingLevel).toBeUndefined();
  });

  it("propagates startup failures when durable input commit is required", async () => {
    await expect(
      generateAssistantReply("hello", {
        onInputCommitted: async () => {
          throw new Error("input should not commit before startup succeeds");
        },
        sandboxExecutorFactory: () => {
          throw new Error("sandbox executor failed");
        },
      }),
    ).rejects.toThrow("sandbox executor failed");
  });
});
