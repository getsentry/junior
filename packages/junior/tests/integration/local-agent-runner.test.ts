import { describe, expect, it, vi } from "vitest";
import type {
  AssistantReply,
  generateAssistantReply,
  ReplyRequestContext,
} from "@/chat/respond";
import { normalizeLocalConversationId } from "@/chat/local/conversation";
import { runLocalAgentTurn } from "@/chat/local/runner";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";

function successReply(text: string): AssistantReply {
  return {
    text,
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "fake-local-agent",
      outcome: "success",
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true,
    },
  };
}

describe("local agent runner", () => {
  it("runs a local message without Slack requester or destination state", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "demo",
      cwd: "/tmp/local-agent-runner-one",
    });
    expect(conversationId).toBeDefined();

    const contexts: ReplyRequestContext[] = [];
    const generateReply = vi.fn<typeof generateAssistantReply>(
      async (_text, context = {}) => {
        contexts.push(context);
        return successReply("hello from local");
      },
    );
    const delivered: string[] = [];

    await runLocalAgentTurn(
      {
        conversationAlias: "demo",
        conversationId: conversationId!,
        message: "hello",
        mode: "once",
      },
      {
        deliverReply: async (reply) => {
          delivered.push(reply.text);
        },
        generateAssistantReply: generateReply,
      },
    );

    expect(generateReply).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        authorizationFlowMode: "disabled",
        credentialContext: {
          actor: { type: "system", id: "local-cli" },
        },
        destination: {
          platform: "local",
          conversationId,
        },
        surface: "internal",
      }),
    );
    expect(contexts[0]?.requester).toBeUndefined();
    expect(contexts[0]?.slackConversation).toBeUndefined();
    expect(contexts[0]?.correlation?.channelId).toBeUndefined();
    expect(delivered).toEqual(["hello from local"]);

    const state = await getPersistedThreadState(conversationId!);
    const conversation = coerceThreadConversationState(state);
    expect(conversation.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(conversation.messages[0]).toMatchObject({
      text: "hello",
      author: {
        userId: "local-cli",
        userName: "local",
      },
      meta: {
        replied: true,
      },
    });
    expect(conversation.messages[1]).toMatchObject({
      text: "hello from local",
      author: {
        isBot: true,
      },
      meta: {
        replied: true,
      },
    });
  });

  it("preserves visible local conversation context across messages", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "followup",
      cwd: "/tmp/local-agent-runner-two",
    });
    expect(conversationId).toBeDefined();

    const contexts: ReplyRequestContext[] = [];
    const generateReply = vi.fn<typeof generateAssistantReply>(
      async (text, context = {}) => {
        contexts.push(context);
        return successReply(`reply to ${text}`);
      },
    );

    await runLocalAgentTurn(
      {
        conversationAlias: "followup",
        conversationId: conversationId!,
        message: "first question",
        mode: "once",
      },
      {
        deliverReply: async () => undefined,
        generateAssistantReply: generateReply,
      },
    );
    await runLocalAgentTurn(
      {
        conversationAlias: "followup",
        conversationId: conversationId!,
        message: "second question",
        mode: "once",
      },
      {
        deliverReply: async () => undefined,
        generateAssistantReply: generateReply,
      },
    );

    expect(contexts[1]?.conversationContext).toContain("first question");
    expect(contexts[1]?.conversationContext).toContain(
      "reply to first question",
    );

    const state = await getPersistedThreadState(conversationId!);
    const conversation = coerceThreadConversationState(state);
    expect(conversation.messages.map((message) => message.text)).toEqual([
      "first question",
      "reply to first question",
      "second question",
      "reply to second question",
    ]);
  });

  it("requires local delivery before running a turn", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "missing-delivery",
      cwd: "/tmp/local-agent-runner-three",
    });
    expect(conversationId).toBeDefined();

    const generateReply = vi.fn<typeof generateAssistantReply>(async () =>
      successReply("not delivered"),
    );

    await expect(
      runLocalAgentTurn(
        {
          conversationAlias: "missing-delivery",
          conversationId: conversationId!,
          message: "hello",
          mode: "once",
        },
        {
          generateAssistantReply: generateReply,
        } as unknown as Parameters<typeof runLocalAgentTurn>[1],
      ),
    ).rejects.toThrow("Local reply delivery is required");
    expect(generateReply).not.toHaveBeenCalled();

    const state = await getPersistedThreadState(conversationId!);
    const conversation = coerceThreadConversationState(state);
    expect(conversation.messages).toEqual([]);
  });
});
