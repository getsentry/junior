import { describe, expect, it, vi } from "vitest";
import type { AssistantReply } from "@/chat/respond";
import {
  defineJuniorPlugin,
  type PluginRunContext,
} from "@sentry/junior-plugin-api";
import { normalizeLocalConversationId } from "@/chat/local/conversation";
import {
  runLocalAgentTurn,
  type LocalAgentReply,
  type LocalToolInvocation,
  type LocalToolResult,
} from "@/chat/local/runner";
import type { PiMessage } from "@/chat/pi/messages";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { persistCompletedSessionRecord } from "@/chat/services/turn-session-record";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { commitMessages, loadProjection } from "@/chat/state/session-log";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { flattenReplyRequestForTest } from "../fixtures/agent-runner";

function successReply(
  text: string,
  options: Partial<
    Pick<AssistantReply, "piMessages"> & {
      toolCalls: string[];
    }
  > = {},
): AssistantReply {
  return {
    text,
    ...(options.piMessages ? { piMessages: options.piMessages } : {}),
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "fake-local-agent",
      outcome: "success",
      toolCalls: options.toolCalls ?? [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true,
    },
  };
}

type FlatReplyRequestContext = ReturnType<typeof flattenReplyRequestForTest>;

async function persistCompletedSessionForFakeReply(
  context: FlatReplyRequestContext,
  piMessages: PiMessage[],
): Promise<void> {
  const conversationId = context.correlation?.conversationId;
  const sessionId = context.correlation?.turnId;
  if (!conversationId || !sessionId) {
    throw new Error("Local fake reply requires session correlation ids");
  }
  await persistCompletedSessionRecord({
    conversationId,
    destination: context.destination,
    requester: context.requester,
    source: context.source,
    sessionId,
    sliceId: 1,
    allMessages: piMessages,
    logContext: {
      modelId: "fake-local-agent",
      runId: context.correlation?.runId,
    },
    surface: context.surface,
    turnStartMessageIndex: context.piMessages?.length ?? 0,
  });
}

describe("local agent runner", () => {
  it("runs a local message without Slack requester or destination state", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "demo",
      cwd: "/tmp/local-agent-runner-one",
    });
    expect(conversationId).toBeDefined();

    const contexts: FlatReplyRequestContext[] = [];
    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenReplyRequestForTest(request);

      contexts.push(context);
      return completedAgentRun(successReply("hello from local"));
    });
    const delivered: LocalAgentReply[] = [];

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "hello",
      },
      {
        deliverReply: async (reply) => {
          delivered.push(reply);
        },
        agentRunner: { run: generateReply },
      },
    );

    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ messageText: "hello" }),
        policy: expect.objectContaining({ authorizationFlowMode: "disabled" }),
        routing: expect.objectContaining({
          credentialContext: {
            actor: { type: "system", id: "local-cli" },
          },
          destination: {
            platform: "local",
            conversationId,
          },
          surface: "internal",
        }),
      }),
    );
    expect(contexts[0]?.requester).toEqual({
      fullName: "Local CLI",
      platform: "local",
      userId: "local-cli",
      userName: "local",
    });
    expect(contexts[0]?.slackConversation).toBeUndefined();
    expect(contexts[0]?.correlation?.channelId).toBeUndefined();
    expect(contexts[0]?.correlation?.teamId).toBeUndefined();
    expect(contexts[0]?.correlation?.threadId).toBeUndefined();
    expect(delivered).toEqual([
      {
        text: "hello from local",
      },
    ]);

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

  it("forwards tool events from the shared reply boundary", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "tools",
      cwd: "/tmp/local-agent-runner-tools",
    });
    expect(conversationId).toBeDefined();

    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenReplyRequestForTest(request);

      context.onToolInvocation?.({
        toolName: "createMemory",
        params: { content: "The requester prefers short updates." },
      });
      await context.onToolResult?.({
        ok: true,
        toolName: "createMemory",
        params: { content: "The requester prefers short updates." },
        result: { ok: true },
      });
      return completedAgentRun(
        successReply("saved", { toolCalls: ["createMemory"] }),
      );
    });
    const invocations: LocalToolInvocation[] = [];
    const results: LocalToolResult[] = [];

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "remember this",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: { run: generateReply },
        onToolInvocation: async (invocation) => {
          invocations.push(invocation);
        },
        onToolResult: async (result) => {
          results.push(result);
        },
      },
    );

    expect(invocations).toEqual([
      {
        toolName: "createMemory",
        params: { content: "The requester prefers short updates." },
      },
    ]);
    expect(results).toEqual([
      {
        ok: true,
        toolName: "createMemory",
        params: { content: "The requester prefers short updates." },
        result: { ok: true },
      },
    ]);
  });

  it("runs plugin tasks inline after completed local turns", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "plugin-task",
      cwd: "/tmp/local-agent-runner-plugin-task",
    });
    expect(conversationId).toBeDefined();

    const loadedRuns: PluginRunContext[] = [];
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "local-task-demo",
          displayName: "Local Task Demo",
          description: "Local task demo",
        },
        tasks: {
          captureSession: {
            async run(ctx) {
              loadedRuns.push(await ctx.run.load());
            },
          },
        },
      }),
    ]);

    try {
      await runLocalAgentTurn(
        {
          conversationId: conversationId!,
          message: "capture this local turn",
        },
        {
          deliverReply: async () => undefined,
          agentRunner: {
            run: async (request) => {
              const context = flattenReplyRequestForTest(request);

              const piMessages = [
                {
                  role: "user",
                  content: "capture this local turn",
                },
                {
                  role: "assistant",
                  content: "captured",
                },
              ] as PiMessage[];
              await persistCompletedSessionForFakeReply(context, piMessages);
              return completedAgentRun(
                successReply("captured", {
                  piMessages,
                }),
              );
            },
          },
        },
      );
    } finally {
      setPlugins([]);
    }

    expect(loadedRuns).toEqual([
      expect.objectContaining({
        conversationId,
        destination: {
          platform: "local",
          conversationId,
        },
        runId: "local-turn-1",
        transcript: [
          {
            type: "message",
            role: "user",
            text: "capture this local turn",
          },
          {
            type: "message",
            role: "assistant",
            text: "captured",
          },
        ],
        requester: expect.objectContaining({
          platform: "local",
          userId: "local-cli",
        }),
        source: {
          platform: "local",
          type: "priv",
          conversationId,
        },
      }),
    ]);
  });

  it("preserves visible local conversation context across messages", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "followup",
      cwd: "/tmp/local-agent-runner-two",
    });
    expect(conversationId).toBeDefined();

    const contexts: FlatReplyRequestContext[] = [];
    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      const text = request.input.messageText;
      const context = flattenReplyRequestForTest(request);

      contexts.push(context);
      return completedAgentRun(successReply(`reply to ${text}`));
    });

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "first question",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: { run: generateReply },
      },
    );
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "second question",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: { run: generateReply },
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

    const generateReply = vi.fn<AgentRunner["run"]>(async () =>
      completedAgentRun(successReply("not delivered")),
    );

    await expect(
      runLocalAgentTurn(
        {
          conversationId: conversationId!,
          message: "hello",
        },
        {
          agentRunner: { run: generateReply },
        } as unknown as Parameters<typeof runLocalAgentTurn>[1],
      ),
    ).rejects.toThrow("Local reply delivery is required");
    expect(generateReply).not.toHaveBeenCalled();

    const state = await getPersistedThreadState(conversationId!);
    const conversation = coerceThreadConversationState(state);
    expect(conversation.messages).toEqual([]);
  });

  it("rejects malformed local conversation ids before generation", async () => {
    const generateReply = vi.fn<AgentRunner["run"]>(async () => {
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
          agentRunner: { run: generateReply },
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

    const contexts: FlatReplyRequestContext[] = [];
    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenReplyRequestForTest(request);

      contexts.push(context);
      return completedAgentRun(successReply("uses projection"));
    });

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "follow up",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: { run: generateReply },
      },
    );

    expect(contexts[0]?.piMessages).toEqual([projectedMessage]);
  });

  it("commits generated Pi history after successful local delivery", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "pi-history-commit",
      cwd: "/tmp/local-agent-runner-six",
    });
    expect(conversationId).toBeDefined();

    const generatedMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "persisted pi output" }],
      },
    ] as PiMessage[];
    const generateReply = vi.fn<AgentRunner["run"]>(async () =>
      completedAgentRun(
        successReply("persisted visible output", {
          piMessages: generatedMessages,
        }),
      ),
    );

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "hello",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: { run: generateReply },
      },
    );

    expect(await loadProjection({ conversationId: conversationId! })).toEqual(
      generatedMessages,
    );
    const state = await getPersistedThreadState(conversationId!);
    const conversation = coerceThreadConversationState(state);
    expect(conversation.piMessages).toEqual(generatedMessages);

    const contexts: FlatReplyRequestContext[] = [];
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "follow up",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: {
          run: async (request) => {
            const context = flattenReplyRequestForTest(request);

            contexts.push(context);
            return completedAgentRun(successReply("follow up reply"));
          },
        },
      },
    );

    expect(contexts[0]?.piMessages).toEqual([generatedMessages[0]]);
  });

  it("keeps the delivered local reply successful when a background task fails", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "background-task-failure",
      cwd: "/tmp/local-agent-runner-background-task-failure",
    });
    expect(conversationId).toBeDefined();

    const generatedMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "visible reply" }],
      },
    ] as PiMessage[];
    const delivered: LocalAgentReply[] = [];
    let taskRuns = 0;
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "local-task-failure",
          displayName: "Local Task Failure",
          description: "Local task failure fixture",
        },
        tasks: {
          processSession: {
            run() {
              taskRuns += 1;
              throw new Error("background task failed");
            },
          },
        },
      }),
    ]);

    try {
      await expect(
        runLocalAgentTurn(
          {
            conversationId: conversationId!,
            message: "hello",
          },
          {
            deliverReply: async (reply) => {
              delivered.push(reply);
            },
            agentRunner: {
              run: async (request) => {
                const context = flattenReplyRequestForTest(request);

                await persistCompletedSessionForFakeReply(
                  context,
                  generatedMessages,
                );
                return completedAgentRun(
                  successReply("visible reply", {
                    piMessages: generatedMessages,
                  }),
                );
              },
            },
          },
        ),
      ).resolves.toEqual({
        conversationId,
        outcome: "success",
      });
    } finally {
      setPlugins([]);
    }

    expect(delivered).toEqual([{ text: "visible reply" }]);
    expect(taskRuns).toBe(1);
  });

  it("uses conversation Pi history when the session projection is stale", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "pi-history-stale-projection",
      cwd: "/tmp/local-agent-runner-seven",
    });
    expect(conversationId).toBeDefined();

    const projectedMessage = {
      role: "user",
      content: [{ type: "text", text: "stale projected history" }],
    } as PiMessage;
    await commitMessages({
      conversationId: conversationId!,
      messages: [projectedMessage],
      ttlMs: 60_000,
    });

    const newerMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "newer conversation history" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "newer assistant output" }],
      },
    ] as PiMessage[];
    const conversation = coerceThreadConversationState({});
    conversation.piMessages = newerMessages;
    await persistThreadStateById(conversationId!, { conversation });

    const contexts: FlatReplyRequestContext[] = [];
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "follow up",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: {
          run: async (request) => {
            const context = flattenReplyRequestForTest(request);

            contexts.push(context);
            return completedAgentRun(successReply("uses newer fallback"));
          },
        },
      },
    );

    expect(contexts[0]?.piMessages).toEqual([newerMessages[0]]);
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
    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenReplyRequestForTest(request);

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
      return completedAgentRun(successReply("not delivered"));
    });

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
          agentRunner: { run: generateReply },
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
