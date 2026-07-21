import { describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "@/chat/services/turn-result";
import {
  defineJuniorPlugin,
  type PluginRunContext,
} from "@sentry/junior-plugin-api";
import { normalizeLocalConversationId } from "@/chat/local/conversation";
import {
  runLocalAgentTurn,
  type LocalAgentReply,
  type LocalAgentTurnDeps,
  type LocalToolInvocation,
  type LocalToolResult,
} from "@/chat/local/runner";
import type { PiMessage } from "@/chat/pi/messages";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { persistCompletedSessionRecord } from "@/chat/services/turn-session-record";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
} from "@/chat/runtime/thread-state";
import {
  commitMessages,
  loadProjection,
} from "@/chat/conversations/projection";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import {
  flattenAgentRunRequestForTest,
  scriptedAssistantMessageRunner,
} from "../fixtures/agent-runner";
import { getConversationEventStore } from "@/chat/db";

function successReply(
  text: string,
  options: Partial<
    Pick<AgentRunResult, "piMessages"> & {
      toolCalls: string[];
    }
  > = {},
): AgentRunResult {
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

function providerFailureReply(rawError: string): AgentRunResult {
  return {
    text: rawError,
    diagnostics: {
      assistantMessageCount: 0,
      errorMessage: rawError,
      modelId: "fake-local-agent",
      outcome: "provider_error",
      providerError: new Error(rawError),
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: false,
    },
  };
}

async function loadLifecycleEvents(conversationId: string) {
  return (await getConversationEventStore().loadHistory(conversationId)).filter(
    (event) => event.data.type.startsWith("turn_"),
  );
}

type FlatAgentRunRequest = ReturnType<typeof flattenAgentRunRequestForTest>;

async function deliverAssistantText(
  request: Parameters<AgentRunner["run"]>[0],
  text: string,
): Promise<void> {
  if (!request.delivery) {
    throw new Error("local test runner requires assistant delivery");
  }
  await request.delivery.onAssistantMessage({ text });
}

async function persistCompletedSessionForFakeReply(
  context: FlatAgentRunRequest,
  piMessages: PiMessage[],
): Promise<void> {
  const conversationId = context.conversationId;
  const sessionId = context.turnId;
  await persistCompletedSessionRecord({
    modelId: "fake-local-agent",
    conversationId,
    destination: context.destination,
    actor:
      context.actor && "platform" in context.actor ? context.actor : undefined,
    source: context.source,
    sessionId,
    sliceId: 1,
    allMessages: piMessages,
    logContext: {
      runId: context.runId,
    },
    surface: context.surface,
    turnStartMessageIndex: context.piMessages?.length ?? 0,
  });
}

describe("local agent runner", () => {
  it("delivers and persists completed assistant messages in order", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "assistant-messages",
      cwd: "/tmp/local-agent-runner-assistant-messages",
    });
    expect(conversationId).toBeDefined();
    const delivered: LocalAgentReply[] = [];

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "check this",
      },
      {
        deliverReply: async (reply) => {
          delivered.push(reply);
        },
        agentRunner: scriptedAssistantMessageRunner({
          messages: [{ text: "Checking now." }, { text: "Done." }],
          result: successReply("Done."),
        }),
      },
    );

    expect(delivered).toEqual([{ text: "Checking now." }, { text: "Done." }]);
    const state = await getPersistedThreadState(conversationId!);
    const conversation = coerceThreadConversationState(state);
    await hydrateConversationMessages({
      conversation,
      conversationId: conversationId!,
    });
    expect(
      conversation.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text),
    ).toEqual(["Checking now.", "Done."]);
  });

  it("runs a local message without Slack actor or destination state", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "demo",
      cwd: "/tmp/local-agent-runner-one",
    });
    expect(conversationId).toBeDefined();

    const contexts: FlatAgentRunRequest[] = [];
    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);

      contexts.push(context);
      await deliverAssistantText(request, "hello from local");
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
            actor: { platform: "system", name: "local-cli" },
          },
          destination: {
            platform: "local",
            conversationId,
          },
          surface: "internal",
        }),
      }),
    );
    expect(contexts[0]?.actor).toEqual({
      fullName: "Local CLI",
      platform: "local",
      userId: "local-cli",
      userName: "local",
    });
    expect(contexts[0]?.slackConversation).toBeUndefined();
    expect(delivered).toEqual([
      {
        text: "hello from local",
      },
    ]);

    const state = await getPersistedThreadState(conversationId!);
    const conversation = coerceThreadConversationState(state);
    await hydrateConversationMessages({
      conversation,
      conversationId: conversationId!,
    });
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

    const history = await getConversationEventStore().loadHistory(
      conversationId!,
    );
    const userRecorded = history.findIndex(
      (event) => event.data.type === "message" && event.data.role === "user",
    );
    const started = history.findIndex(
      (event) => event.data.type === "turn_started",
    );
    const assistantRecorded = history.findIndex(
      (event) =>
        event.data.type === "message" && event.data.role === "assistant",
    );
    const completed = history.findIndex(
      (event) => event.data.type === "turn_completed",
    );
    expect(userRecorded).toBeLessThan(started);
    expect(started).toBeLessThan(assistantRecorded);
    expect(assistantRecorded).toBeLessThan(completed);
    expect(history[completed]?.data).toMatchObject({
      type: "turn_completed",
      outcome: "success",
    });
  });

  it("records intentional silence without delivering or inventing a message", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "no-reply",
      cwd: "/tmp/local-agent-runner-no-reply",
    });
    const deliverReply = vi.fn<LocalAgentTurnDeps["deliverReply"]>();

    await runLocalAgentTurn(
      { conversationId: conversationId!, message: "react only" },
      {
        agentRunner: {
          run: async () => completedAgentRun(successReply("")),
        },
        deliverReply,
      },
    );

    expect(deliverReply).not.toHaveBeenCalled();
    const state = await getPersistedThreadState(conversationId!);
    const conversation = coerceThreadConversationState(state);
    await hydrateConversationMessages({
      conversation,
      conversationId: conversationId!,
    });
    expect(conversation.messages.map((message) => message.text)).toEqual([
      "react only",
    ]);
    expect(JSON.stringify(conversation.messages)).not.toContain(
      "[no visible reply]",
    );
    expect(await loadLifecycleEvents(conversationId!)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ type: "turn_started" }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          type: "turn_completed",
          outcome: "no_reply",
        }),
      }),
    ]);
  });

  it("records success when a completed message precedes intentional silence", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "message-then-no-reply",
      cwd: "/tmp/local-agent-runner-message-then-no-reply",
    });
    const delivered: LocalAgentReply[] = [];

    await runLocalAgentTurn(
      { conversationId: conversationId!, message: "check, then react" },
      {
        agentRunner: scriptedAssistantMessageRunner({
          messages: [{ text: "Checked it." }],
          result: successReply(""),
        }),
        deliverReply: async (reply) => {
          delivered.push(reply);
        },
      },
    );

    expect(delivered).toEqual([{ text: "Checked it." }]);
    expect(await loadLifecycleEvents(conversationId!)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ type: "turn_started" }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          type: "turn_completed",
          outcome: "success",
        }),
      }),
    ]);
  });

  it("records a delivered sanitized model failure without raw error data", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "model-failure",
      cwd: "/tmp/local-agent-runner-model-failure",
    });
    const rawError =
      "raw-error-sentinel https://provider.invalid/private?token=secret";
    const delivered: LocalAgentReply[] = [];

    await runLocalAgentTurn(
      { conversationId: conversationId!, message: "please try" },
      {
        agentRunner: {
          run: async () => completedAgentRun(providerFailureReply(rawError)),
        },
        deliverReply: async (reply) => {
          delivered.push(reply);
        },
        logException: vi
          .fn()
          .mockReturnValue("0123456789abcdef0123456789abcdef"),
      },
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain(
      "event_id=0123456789abcdef0123456789abcdef",
    );
    expect(delivered[0]?.text).not.toContain("raw-error-sentinel");
    const lifecycle = await loadLifecycleEvents(conversationId!);
    expect(lifecycle.at(-1)?.data).toEqual({
      type: "turn_failed",
      turnId: expect.stringMatching(/^local-turn-/),
      failureCode: "model_execution_failed",
      eventId: "0123456789abcdef0123456789abcdef",
    });
    expect(JSON.stringify(lifecycle)).not.toContain("raw-error-sentinel");
    expect(JSON.stringify(lifecycle)).not.toContain("provider.invalid");
  });

  it("classifies a thrown agent run without persisting exception details", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "runner-throw",
      cwd: "/tmp/local-agent-runner-throw",
    });
    const rawError = "raw-run-error-sentinel token=secret";
    const eventId = "11111111111111111111111111111111";
    const capture = vi.fn().mockReturnValue(eventId);

    await expect(
      runLocalAgentTurn(
        { conversationId: conversationId!, message: "please try" },
        {
          agentRunner: {
            run: async () => {
              throw new Error(rawError);
            },
          },
          deliverReply: async () => undefined,
          logException: capture,
        },
      ),
    ).rejects.toThrow(rawError);

    const lifecycle = await loadLifecycleEvents(conversationId!);
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_failed",
      failureCode: "agent_run_failed",
      eventId,
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(JSON.stringify(lifecycle)).not.toContain(rawError);
  });

  it("retains the model incident when post-delivery persistence fails", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "model-persistence-failure",
      cwd: "/tmp/local-agent-model-persistence-failure",
    });
    const modelEventId = "22222222222222222222222222222222";
    const persistenceEventId = "55555555555555555555555555555555";
    const capture = vi
      .fn()
      .mockReturnValueOnce(modelEventId)
      .mockReturnValueOnce(persistenceEventId);
    const reply = providerFailureReply("raw-model-error-sentinel");
    reply.piMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "please try" }],
      } as PiMessage,
    ];

    await expect(
      runLocalAgentTurn(
        { conversationId: conversationId!, message: "please try" },
        {
          agentRunner: {
            run: async () => completedAgentRun(reply),
          },
          completeDeliveredTurn: async () => {
            throw new Error("session-persistence-error-sentinel");
          },
          deliverReply: async () => undefined,
          logException: capture,
        },
      ),
    ).rejects.toThrow("session-persistence-error-sentinel");

    expect(capture).toHaveBeenCalledTimes(2);
    const lifecycle = await loadLifecycleEvents(conversationId!);
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_failed",
      eventId: persistenceEventId,
      failureCode: "persistence_failed",
    });
    const visible = coerceThreadConversationState(
      await getPersistedThreadState(conversationId!),
    );
    await hydrateConversationMessages({
      conversation: visible,
      conversationId: conversationId!,
    });
    expect(JSON.stringify(visible.messages)).toContain(modelEventId);
    expect(JSON.stringify(visible.messages)).not.toContain(persistenceEventId);
    expect(JSON.stringify(lifecycle)).not.toContain("raw-model-error-sentinel");
    expect(JSON.stringify(lifecycle)).not.toContain(
      "session-persistence-error-sentinel",
    );
  });

  it("captures post-delivery persistence failure when no model incident exists", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "success-persistence-failure",
      cwd: "/tmp/local-agent-success-persistence-failure",
    });
    const eventId = "44444444444444444444444444444444";
    const capture = vi.fn().mockReturnValue(eventId);
    const rawError = "raw-session-persistence-error-sentinel";
    const reply = successReply("delivered", {
      piMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "delivered" }],
        } as PiMessage,
      ],
    });

    await expect(
      runLocalAgentTurn(
        { conversationId: conversationId!, message: "please try" },
        {
          agentRunner: {
            run: async (request) => {
              await deliverAssistantText(request, reply.text);
              return completedAgentRun(reply);
            },
          },
          completeDeliveredTurn: async () => {
            throw new Error(rawError);
          },
          deliverReply: async () => undefined,
          logException: capture,
        },
      ),
    ).rejects.toThrow(rawError);

    expect(capture).toHaveBeenCalledOnce();
    const lifecycle = await loadLifecycleEvents(conversationId!);
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_failed",
      eventId,
      failureCode: "persistence_failed",
    });
    expect(JSON.stringify(lifecycle)).not.toContain(rawError);
  });

  it("assigns distinct turn ids to concurrent turns", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "concurrent-turns",
      cwd: "/tmp/local-agent-runner-concurrent-turns",
    });
    const runIds: string[] = [];
    const agentRunner: AgentRunner = {
      run: async (request) => {
        runIds.push(request.turnId);
        return completedAgentRun(successReply(`reply ${runIds.length}`));
      },
    };

    await Promise.all([
      runLocalAgentTurn(
        { conversationId: conversationId!, message: "first" },
        { agentRunner, deliverReply: async () => undefined },
      ),
      runLocalAgentTurn(
        { conversationId: conversationId!, message: "second" },
        { agentRunner, deliverReply: async () => undefined },
      ),
    ]);

    expect(new Set(runIds).size).toBe(2);
    expect(runIds).toEqual([
      expect.stringMatching(/^local-turn-[0-9a-f-]{36}$/),
      expect.stringMatching(/^local-turn-[0-9a-f-]{36}$/),
    ]);
    const starts = (await loadLifecycleEvents(conversationId!)).filter(
      (event) => event.data.type === "turn_started",
    );
    expect(
      new Set(
        starts.flatMap((event) =>
          event.data.type === "turn_started" ? [event.data.turnId] : [],
        ),
      ).size,
    ).toBe(2);
    expect(
      new Set(
        starts.flatMap((event) =>
          event.data.type === "turn_started" ? event.data.inputMessageIds : [],
        ),
      ).size,
    ).toBe(2);
  });

  it("forwards tool events from the shared reply boundary", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "tools",
      cwd: "/tmp/local-agent-runner-tools",
    });
    expect(conversationId).toBeDefined();

    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);

      context.onToolInvocation?.({
        params: { content: "The actor prefers short updates." },
        toolCallId: "tool-call-1",
        toolName: "createMemory",
      });
      await context.onToolResult?.({
        ok: true,
        params: { content: "The actor prefers short updates." },
        result: { ok: true },
        toolCallId: "tool-call-1",
        toolName: "createMemory",
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
        toolCallId: "tool-call-1",
        toolName: "createMemory",
        params: { content: "The actor prefers short updates." },
      },
    ]);
    expect(results).toEqual([
      {
        ok: true,
        toolCallId: "tool-call-1",
        toolName: "createMemory",
        params: { content: "The actor prefers short updates." },
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
              const context = flattenAgentRunRequestForTest(request);

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
              await deliverAssistantText(request, "captured");
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
        runId: expect.stringMatching(/^local-turn-[0-9a-f-]{36}$/),
        transcript: [
          {
            type: "message",
            role: "user",
            text: "capture this local turn",
            isRunActor: true,
            provenance: {
              authority: "instruction",
              actor: expect.objectContaining({
                platform: "local",
                userId: "local-cli",
              }),
            },
          },
          {
            type: "message",
            role: "assistant",
            text: "captured",
          },
        ],
        actor: expect.objectContaining({
          platform: "local",
          userId: "local-cli",
        }),
        actors: [
          expect.objectContaining({
            platform: "local",
            userId: "local-cli",
          }),
        ],
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

    const contexts: FlatAgentRunRequest[] = [];
    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      const text = request.input.messageText;
      const context = flattenAgentRunRequestForTest(request);

      contexts.push(context);
      const replyText = `reply to ${text}`;
      await deliverAssistantText(request, replyText);
      return completedAgentRun(successReply(replyText));
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
    await hydrateConversationMessages({
      conversation,
      conversationId: conversationId!,
    });
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

  it("does not advertise an active turn when lifecycle start persistence fails", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "start-failure",
      cwd: "/tmp/local-agent-runner-start-failure",
    });
    const agentRunner = { run: vi.fn<AgentRunner["run"]>() };
    const startError = new Error("lifecycle store unavailable");
    const turnLifecycle: NonNullable<LocalAgentTurnDeps["turnLifecycle"]> = {
      start: vi.fn().mockRejectedValue(startError),
      complete: vi.fn(),
      fail: vi.fn(),
    };

    await expect(
      runLocalAgentTurn(
        { conversationId: conversationId!, message: "durable input" },
        {
          agentRunner,
          deliverReply: async () => undefined,
          turnLifecycle,
        },
      ),
    ).rejects.toBe(startError);

    expect(agentRunner.run).not.toHaveBeenCalled();
    expect(turnLifecycle.complete).not.toHaveBeenCalled();
    expect(turnLifecycle.fail).not.toHaveBeenCalled();
    const state = await getPersistedThreadState(conversationId!);
    const conversation = coerceThreadConversationState(state);
    expect(conversation.processing.activeTurnId).toBeUndefined();
    await hydrateConversationMessages({
      conversation,
      conversationId: conversationId!,
    });
    expect(conversation.messages).toEqual([
      expect.objectContaining({ role: "user", text: "durable input" }),
    ]);
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
    });

    const contexts: FlatAgentRunRequest[] = [];
    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);

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
    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      await deliverAssistantText(request, "persisted visible output");
      return completedAgentRun(
        successReply("persisted visible output", {
          piMessages: generatedMessages,
        }),
      );
    });

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

    const contexts: FlatAgentRunRequest[] = [];
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "follow up",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: {
          run: async (request) => {
            const context = flattenAgentRunRequestForTest(request);

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
                const context = flattenAgentRunRequestForTest(request);

                await persistCompletedSessionForFakeReply(
                  context,
                  generatedMessages,
                );
                await deliverAssistantText(request, "visible reply");
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

  it("uses the SQL step projection as the Pi history authority", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "pi-history-projection-authority",
      cwd: "/tmp/local-agent-runner-seven",
    });
    expect(conversationId).toBeDefined();

    const projectedMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "projected question" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "projected answer" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "projected follow-up" }],
      },
    ] as PiMessage[];
    await commitMessages({
      conversationId: conversationId!,
      messages: projectedMessages,
    });

    const contexts: FlatAgentRunRequest[] = [];
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "follow up",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: {
          run: async (request) => {
            const context = flattenAgentRunRequestForTest(request);

            contexts.push(context);
            return completedAgentRun(successReply("uses projection"));
          },
        },
      },
    );

    expect(contexts[0]?.piMessages).toEqual(projectedMessages);
  });

  it("does not commit generated Pi output when local delivery fails", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "delivery-pi-rollback",
      cwd: "/tmp/local-agent-runner-five",
    });
    expect(conversationId).toBeDefined();
    const rawDeliveryError = "raw-delivery-error-sentinel stdout closed";
    const eventId = "33333333333333333333333333333333";
    const capture = vi.fn().mockReturnValue(eventId);

    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);

      await context.onArtifactStateUpdated?.({
        lastCanvasId: "canvas-undelivered",
        lastCanvasUrl: "https://example.invalid/canvas",
      });
      await context.onSandboxAcquired?.({
        sandboxDependencyProfileHash: "profile-undelivered",
        sandboxId: "sandbox-undelivered",
      });
      await deliverAssistantText(request, "not delivered");
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
            throw new Error(rawDeliveryError);
          },
          agentRunner: { run: generateReply },
          logException: capture,
        },
      ),
    ).rejects.toThrow(rawDeliveryError);

    expect(await loadProjection({ conversationId: conversationId! })).toEqual(
      [],
    );
    const state = await getPersistedThreadState(conversationId!);
    expect(coerceThreadArtifactsState(state).lastCanvasId).toBeUndefined();
    expect(getPersistedSandboxState(state)).toEqual({});
    const visible = coerceThreadConversationState(state);
    await hydrateConversationMessages({
      conversation: visible,
      conversationId: conversationId!,
    });
    expect(visible.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
    ]);
    const lifecycle = await loadLifecycleEvents(conversationId!);
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_failed",
      failureCode: "delivery_failed",
      eventId,
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(JSON.stringify(lifecycle)).not.toContain(rawDeliveryError);
  });
});
