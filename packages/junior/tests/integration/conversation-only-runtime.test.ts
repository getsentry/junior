import { describe, expect, it } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { runConversationOnlyTurn } from "@/chat/runtime/conversation-only";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { getTurnRecord } from "@/chat/task-execution/checkpoint";

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "fake-conversation-only",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("conversation-only runtime", () => {
  it("accepts replies into the conversation log without an output observer", async () => {
    const conversationId = "local:runtime:conversation-only";
    const destination = { platform: "local", conversationId } as const;
    const source = createLocalSource(conversationId);
    const reply = assistantMessage("Stored only in Junior.");
    let turnId = "";

    await runConversationOnlyTurn(
      {
        actor: {
          platform: "local",
          userId: "dashboard-user",
          userName: "Dashboard User",
        },
        conversationId,
        destination,
        message: "Keep this reply in Junior.",
        source,
        // Surface may be api later; local destination still owns activity source.
        surface: "api",
      },
      {
        agentRunner: {
          run: async (request) => {
            turnId = request.turnId;
            expect(request.routing.publishExternally).toBe(false);
            await request.delivery?.(reply);
            return completedAgentRun({
              text: "Stored only in Junior.",
              piMessages: [reply],
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-conversation-only",
                outcome: "success",
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            });
          },
        },
      },
    );

    const messages = (
      await getConversationEventStore().loadMessageHistory(conversationId)
    ).events.filter((event) => event.data.type === "message");
    expect(messages.map((event) => event.data)).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Keep this reply in Junior.",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "Stored only in Junior.",
      }),
    ]);

    await expect(
      getConversationStore().get({ conversationId }),
    ).resolves.toMatchObject({
      source: "local",
      sessionSource: source,
    });
    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      publishExternally: false,
      state: "completed",
    });
  });
});
