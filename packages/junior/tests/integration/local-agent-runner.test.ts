import { describe, expect, it, vi } from "vitest";
import type {
  AssistantReply,
  generateAssistantReply,
  ReplyRequestContext,
} from "@/chat/respond";
import { normalizeLocalConversationId } from "@/chat/local/conversation";
import { runLocalAgentTurn } from "@/chat/local/runner";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
} from "@/chat/runtime/thread-state";
import { commitMessages, loadProjection } from "@/chat/state/session-log";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";

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
        conversationId: conversationId!,
        message: "hello",
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
    expect(contexts[0]?.correlation?.threadId).toBeUndefined();
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
        conversationId: conversationId!,
        message: "first question",
      },
      {
        deliverReply: async () => undefined,
        generateAssistantReply: generateReply,
      },
    );
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "second question",
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
          conversationId: conversationId!,
          message: "hello",
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

  it("rejects malformed local conversation ids before generation", async () => {
    const generateReply = vi.fn<typeof generateAssistantReply>(async () => {
      throw new Error("generation should not run");
    });

    await expect(
      runLocalAgentTurn(
        {
          conversationId: "slack:C123:123.456",
          message: "hello",
        },
        {
          deliverReply: async () => undefined,
          generateAssistantReply: generateReply,
        },
      ),
    ).rejects.toThrow("Invalid local conversation id");
  });

  it("uses durable Pi projection for follow-up local turns", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "pi-history",
      cwd: "/tmp/local-agent-runner-four",
    });
    expect(conversationId).toBeDefined();
    const projectedMessage = {
      role: "user",
      content: [{ type: "text", text: "projected history" }],
    } as PiMessage;
    await commitMessages({
      conversationId: conversationId!,
      messages: [projectedMessage],
      ttlMs: 60_000,
    });

    const contexts: ReplyRequestContext[] = [];
    const generateReply = vi.fn<typeof generateAssistantReply>(
      async (_text, context = {}) => {
        contexts.push(context);
        return successReply("uses projection");
      },
    );

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "follow up",
      },
      {
        deliverReply: async () => undefined,
        generateAssistantReply: generateReply,
      },
    );

    expect(contexts[0]?.piMessages).toEqual([projectedMessage]);
  });

  it("rolls back generated Pi output when local delivery fails", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "delivery-pi-rollback",
      cwd: "/tmp/local-agent-runner-five",
    });
    expect(conversationId).toBeDefined();

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "undelivered pi output" }],
    } as PiMessage;
    const generateReply = vi.fn<typeof generateAssistantReply>(
      async (_text, context = {}) => {
        await context.onArtifactStateUpdated?.({
          lastCanvasId: "canvas-undelivered",
          lastCanvasUrl: "https://example.invalid/canvas",
        });
        await context.onSandboxAcquired?.({
          sandboxDependencyProfileHash: "profile-undelivered",
          sandboxId: "sandbox-undelivered",
        });
        await commitMessages({
          conversationId: conversationId!,
          messages: [assistantMessage],
          ttlMs: 60_000,
        });
        return successReply("not delivered");
      },
    );

    await expect(
      runLocalAgentTurn(
        {
          conversationId: conversationId!,
          message: "hello",
        },
        {
          deliverReply: async () => {
            throw new Error("stdout closed");
          },
          generateAssistantReply: generateReply,
        },
      ),
    ).rejects.toThrow("stdout closed");

    expect(await loadProjection({ conversationId: conversationId! })).toEqual(
      [],
    );
    const state = await getPersistedThreadState(conversationId!);
    expect(coerceThreadArtifactsState(state).lastCanvasId).toBeUndefined();
    expect(getPersistedSandboxState(state)).toEqual({});
  });
});
