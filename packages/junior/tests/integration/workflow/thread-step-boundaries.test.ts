import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBotDepsForTests, setBotDepsForTests } from "@/chat/bot";
import { processThreadMessageStep } from "@/chat/workflow/thread-steps";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import type { TestThread } from "../../fixtures/slack-harness";
import { createTestMessage, createTestThread } from "../../fixtures/slack-harness";

const workflowMessageState = new Map<string, { status: "started" | "completed" | "failed"; updatedAtMs: number }>();

vi.mock("@/chat/state", () => ({
  getStateAdapter: () => ({
    connect: async () => undefined
  }),
  getWorkflowMessageProcessingState: async (rawKey: string) => workflowMessageState.get(rawKey),
  markWorkflowMessageStarted: async (rawKey: string) => {
    if (workflowMessageState.has(rawKey)) {
      return false;
    }
    workflowMessageState.set(rawKey, { status: "started", updatedAtMs: Date.now() });
    return true;
  },
  markWorkflowMessageCompleted: async (rawKey: string) => {
    workflowMessageState.set(rawKey, { status: "completed", updatedAtMs: Date.now() });
  },
  markWorkflowMessageFailed: async (rawKey: string) => {
    workflowMessageState.set(rawKey, { status: "failed", updatedAtMs: Date.now() });
  }
}));

function createPayload(
  kind: ThreadMessagePayload["kind"],
  text: string
): {
  payload: ThreadMessagePayload;
  thread: TestThread;
} {
  const threadId = "slack:C_STEP:1700001234.100";
  const thread = createTestThread({ id: threadId });
  const message = createTestMessage({
    id: `m-${kind}`,
    threadId,
    text,
    isMention: true,
    author: {
      userId: "U_TESTER",
      userName: "tester"
    }
  });

  return {
    payload: {
      dedupKey: `${threadId}:${message.id}`,
      kind,
      message,
      normalizedThreadId: threadId,
      thread
    },
    thread
  };
}

describe("thread workflow step integration", () => {
  afterEach(() => {
    resetBotDepsForTests();
    workflowMessageState.clear();
  });

  it("runs new mention handling through real runtime wiring", async () => {
    const prompts: string[] = [];
    setBotDepsForTests({
      generateAssistantReply: async (prompt) => {
        prompts.push(prompt);
        return {
          text: "Mention received and processed.",
          diagnostics: {
            assistantMessageCount: 1,
            modelId: "fake-agent-model",
            outcome: "success",
            toolCalls: [],
            toolErrorCount: 0,
            toolResultCount: 0,
            usedPrimaryText: true
          }
        };
      }
    });

    const { payload, thread } = createPayload("new_mention", "<@U_APP> tell me the latest");

    await processThreadMessageStep(payload, "wrun-step-1");

    expect((processThreadMessageStep as { maxRetries?: number }).maxRetries).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(thread.subscribeCalls).toBe(1);
    expect(thread.posts).toHaveLength(1);
  });

  it("runs subscribed-message handling through real runtime wiring", async () => {
    const prompts: string[] = [];
    setBotDepsForTests({
      generateAssistantReply: async (prompt) => {
        prompts.push(prompt);
        return {
          text: "Subscribed message handled.",
          diagnostics: {
            assistantMessageCount: 1,
            modelId: "fake-agent-model",
            outcome: "success",
            toolCalls: [],
            toolErrorCount: 0,
            toolResultCount: 0,
            usedPrimaryText: true
          }
        };
      }
    });

    const { payload, thread } = createPayload("subscribed_message", "Update from thread participant");

    await processThreadMessageStep(payload, "wrun-step-2");

    expect(prompts).toHaveLength(1);
    expect(thread.posts).toHaveLength(1);
  });

  it("skips replayed payload once message state is completed", async () => {
    const prompts: string[] = [];
    setBotDepsForTests({
      generateAssistantReply: async (prompt) => {
        prompts.push(prompt);
        return {
          text: "Handled once.",
          diagnostics: {
            assistantMessageCount: 1,
            modelId: "fake-agent-model",
            outcome: "success",
            toolCalls: [],
            toolErrorCount: 0,
            toolResultCount: 0,
            usedPrimaryText: true
          }
        };
      }
    });

    const { payload } = createPayload("new_mention", "<@U_APP> run once");

    await processThreadMessageStep(payload, "wrun-step-3");
    await processThreadMessageStep(payload, "wrun-step-3");

    expect(prompts).toHaveLength(1);
  });
});
