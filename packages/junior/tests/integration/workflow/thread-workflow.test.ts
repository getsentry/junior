import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBotDepsForTests, setBotDepsForTests } from "@/chat/bot";
import { processThreadPayloadStream } from "@/chat/workflow/thread-workflow";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import { createTestMessage, createTestThread } from "../../fixtures/slack-harness";

const workflowMessageState = new Map<
  string,
  { status: "processing" | "completed" | "failed"; updatedAtMs: number; ownerToken?: string }
>();

vi.mock("@/chat/state", () => ({
  getStateAdapter: () => ({
    connect: async () => undefined
  }),
  getWorkflowMessageProcessingState: async (rawKey: string) => workflowMessageState.get(rawKey),
  acquireWorkflowMessageProcessingOwnership: async (args: { rawKey: string; ownerToken: string }) => {
    if (workflowMessageState.has(args.rawKey)) {
      return "blocked" as const;
    }
    workflowMessageState.set(args.rawKey, {
      status: "processing",
      updatedAtMs: Date.now(),
      ownerToken: args.ownerToken
    });
    return "acquired" as const;
  },
  refreshWorkflowMessageProcessingOwnership: async (args: { rawKey: string; ownerToken: string }) => {
    const existing = workflowMessageState.get(args.rawKey);
    if (!existing || existing.ownerToken !== args.ownerToken) {
      return false;
    }
    workflowMessageState.set(args.rawKey, { ...existing, updatedAtMs: Date.now() });
    return true;
  },
  completeWorkflowMessageProcessingOwnership: async (args: { rawKey: string; ownerToken: string }) => {
    const existing = workflowMessageState.get(args.rawKey);
    if (!existing || existing.ownerToken !== args.ownerToken) {
      return false;
    }
    workflowMessageState.set(args.rawKey, { status: "completed", updatedAtMs: Date.now() });
    return true;
  },
  failWorkflowMessageProcessingOwnership: async (args: { rawKey: string; ownerToken: string }) => {
    const existing = workflowMessageState.get(args.rawKey);
    if (!existing || existing.ownerToken !== args.ownerToken) {
      return false;
    }
    workflowMessageState.set(args.rawKey, { status: "failed", updatedAtMs: Date.now() });
    return true;
  }
}));

function buildPayload(args: {
  dedupKey: string;
  messageId: string;
  text: string;
  threadId: string;
}): ThreadMessagePayload {
  const thread = createTestThread({ id: args.threadId });
  const message = createTestMessage({
    id: args.messageId,
    threadId: args.threadId,
    text: args.text,
    isMention: true,
    author: {
      userId: "U_TESTER",
      userName: "tester"
    }
  });

  return {
    dedupKey: args.dedupKey,
    kind: "new_mention",
    message,
    normalizedThreadId: args.threadId,
    thread
  };
}

async function* toAsyncIterable(items: ThreadMessagePayload[]): AsyncIterable<ThreadMessagePayload> {
  for (const item of items) {
    yield item;
  }
}

describe("thread workflow integration", () => {
  afterEach(() => {
    resetBotDepsForTests();
    workflowMessageState.clear();
  });

  it("processes unique payloads and skips duplicate dedup keys", async () => {
    const prompts: string[] = [];

    setBotDepsForTests({
      generateAssistantReply: async (prompt) => {
        prompts.push(prompt);
        return {
          text: "Acknowledged. Workflow turn complete.",
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

    const threadId = "slack:C_WORKFLOW:1700000000.100";
    const payloadA = buildPayload({
      dedupKey: `${threadId}:1`,
      messageId: "1",
      text: "<@U_APP> summarize incident status",
      threadId
    });
    const payloadADuplicate = {
      ...payloadA,
      message: createTestMessage({
        id: "1",
        threadId,
        text: "<@U_APP> summarize incident status",
        isMention: true,
        author: {
          userId: "U_TESTER",
          userName: "tester"
        }
      })
    };
    const payloadB = buildPayload({
      dedupKey: `${threadId}:2`,
      messageId: "2",
      text: "<@U_APP> now give next actions",
      threadId
    });

    await processThreadPayloadStream(toAsyncIterable([payloadA, payloadADuplicate, payloadB]), "wrun-int-1");

    expect(prompts).toHaveLength(2);
  });

  it("continues processing subsequent payloads when one turn fails", async () => {
    const prompts: string[] = [];

    setBotDepsForTests({
      generateAssistantReply: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes("fail-first")) {
          throw new Error("forced integration failure");
        }

        return {
          text: "Recovered on second message.",
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

    const threadId = "slack:C_WORKFLOW:1700000000.200";
    const payloadA = buildPayload({
      dedupKey: `${threadId}:1`,
      messageId: "1",
      text: "<@U_APP> fail-first",
      threadId
    });
    const payloadB = buildPayload({
      dedupKey: `${threadId}:2`,
      messageId: "2",
      text: "<@U_APP> still respond",
      threadId
    });

    await expect(processThreadPayloadStream(toAsyncIterable([payloadA, payloadB]), "wrun-int-2")).resolves.toBeUndefined();
    expect(prompts).toHaveLength(2);
  });
});
