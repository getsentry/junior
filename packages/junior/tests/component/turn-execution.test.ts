import { describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import type { AgentRun } from "@/chat/agent/types";
import { AgentRunError, executeTurn } from "@/chat/runtime/turn-execution";

const conversationId = "local:test:turn-execution";
const run = {
  conversationId,
  destination: { conversationId, platform: "local" },
  instruction: { text: "Run the task." },
  source: createLocalSource(conversationId),
  turnId: "turn-1",
} satisfies AgentRun;

describe("Turn execution", () => {
  it("marks agent errors so the worker can apply agent retry rules", async () => {
    const agentError = new Error("model request failed");

    await expect(
      executeTurn(
        {
          run: vi.fn(async () => {
            throw agentError;
          }),
        },
        run,
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      cause: agentError,
      message: agentError.message,
      name: "AgentRunError",
    } satisfies Partial<AgentRunError>);
  });

  it("leaves save errors for the worker to retry", async () => {
    const saveError = new Error("result save failed");

    await expect(
      executeTurn(
        {
          run: vi.fn(async () => ({
            status: "completed" as const,
            result: {
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
              text: "Done",
            },
          })),
        },
        run,
        async () => {
          throw saveError;
        },
      ),
    ).rejects.toBe(saveError);
  });
});
