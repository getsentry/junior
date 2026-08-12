import { describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "@/chat/services/turn-result";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import {
  defineJuniorPlugin,
  type PluginRunContext,
} from "@sentry/junior-plugin-api";
import { normalizeLocalConversationId } from "@/chat/local/conversation";
import { getLogContextAttributes } from "@/chat/logging";
import {
  runLocalAgentTurn,
  type LocalAgentReply,
  type LocalAgentTurnDeps,
  type LocalToolInvocation,
  type LocalToolResult,
} from "@/chat/local/runner";
import type { PiMessage } from "@/chat/pi/messages";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { AgentRun } from "@/chat/agent/types";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
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
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { createProviderError } from "@/chat/services/provider-error";
import {
  createModelAgentRunnerForRun,
  neverRunAgentRunner,
  scriptedAssistantMessageRunner,
} from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import { getConversationEventStore } from "@/chat/db";

function userPiMessage(text: string, timestamp = 1): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as PiMessage;
}

function assistantPiMessage(text: string, timestamp = 1): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "fake-local-agent",
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
    timestamp,
  };
}

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

function providerFailureReply(
  rawError: string,
  providerError: unknown = new Error(rawError),
): AgentRunResult {
  return {
    text: rawError,
    diagnostics: {
      assistantMessageCount: 0,
      errorMessage: rawError,
      modelId: "fake-local-agent",
      outcome: "provider_error",
      providerError,
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

type CapturedAgentRun = AgentRun;

async function deliverAssistantText(
  request: Parameters<AgentRunner["run"]>[0],
  text: string,
  message: AssistantMessage = assistantPiMessage(text),
  historyBeforeMessage?: PiMessage[],
): Promise<void> {
  if (!request.delivery) {
    throw new Error("local test runner requires assistant delivery");
  }
  if (historyBeforeMessage) {
    await commitMessages({
      conversationId: request.conversationId,
      messages: historyBeforeMessage,
    });
  }
  if (getAssistantReplyText(message) !== text) {
    throw new Error("fake delivery text must match its assistant message");
  }
  await request.delivery(message);
}

async function persistRunningSessionForFakeReply(
  run: CapturedAgentRun,
  piMessages: PiMessage[],
): Promise<void> {
  await saveTurnCheckpoint({
    mode: "running",
    conversationId: run.conversationId,
    destination: run.destination,
    actor: run.actor && "platform" in run.actor ? run.actor : undefined,
    source: run.source,
    turnId: run.turnId,
    sliceId: 1,
    messages: piMessages.slice(0, -1),
    surface: run.surface,
    turnStartMessageIndex: run.history?.length ?? 0,
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

    const agentRuns: CapturedAgentRun[] = [];
    const agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([{ type: "text", text: "hello from local" }]);
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
        agentRunner,
      },
    );

    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toEqual(
      expect.objectContaining({
        instruction: expect.objectContaining({ text: "hello" }),
        disabledFeatures: ["interactive-auth"],
        credentialContext: {
          actor: { type: "user", userId: "local-cli" },
        },
        destination: {
          platform: "local",
          conversationId,
        },
        surface: "internal",
      }),
    );
    expect(agentRuns[0]?.actor).toEqual({
      fullName: "Local CLI",
      platform: "local",
      userId: "local-cli",
      userName: "local",
    });
    expect(agentRuns[0]?.slackConversation).toBeUndefined();
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

  it("waits for local OAuth and resumes the same turn", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "oauth-resume",
      cwd: "/tmp/local-agent-runner-oauth-resume",
    });
    expect(conversationId).toBeDefined();
    const requests: Parameters<AgentRunner["run"]>[0][] = [];
    const deliverAuthorizationRequest =
      vi.fn<NonNullable<LocalAgentTurnDeps["authorization"]>["deliver"]>();
    const waitForAuthorization = vi.fn(async () => undefined);
    const saveTurnCheckpoint = vi.fn(async () => undefined);

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "upload the image",
      },
      {
        agentRunner: {
          run: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              await request.durability?.recordPendingAuth?.({
                kind: "plugin",
                provider: "github",
                actorId: "local-cli",
                sessionId: request.turnId,
                linkSentAtMs: Date.now(),
              });
              await request.authorization?.deliver({
                authorizationUrl: "https://github.com/login/oauth/authorize",
                completionText: "Once authorized, this request will continue.",
                label: "Connect GitHub",
              });
              return {
                status: "awaiting_auth",
                providerDisplayName: "GitHub",
              };
            }
            await deliverAssistantText(request, "uploaded");
            return completedAgentRun(
              successReply("uploaded", {
                piMessages: [assistantPiMessage("uploaded")],
              }),
            );
          },
        },
        authorization: {
          cancel: vi.fn(),
          createState: vi.fn(async () => "local-oauth-state"),
          deliver: deliverAuthorizationRequest,
          wait: waitForAuthorization,
        },
        saveTurnCheckpoint,
        deliverReply: async () => undefined,
      },
    );

    expect(deliverAuthorizationRequest).toHaveBeenCalledOnce();
    expect(waitForAuthorization).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.turnId).toBe(requests[1]?.turnId);
    expect(requests[0]?.runId).not.toBe(requests[1]?.runId);
    expect(saveTurnCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ sliceId: 2 }),
    );
    expect(requests[0]?.disabledFeatures).toBeUndefined();
    expect(requests[0]?.authorization).toBeDefined();
    expect(requests[1]?.state?.pendingAuth).toMatchObject({
      kind: "plugin",
      provider: "github",
      actorId: "local-cli",
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
      "503 raw-error-sentinel https://provider.invalid/private?token=secret";
    const providerError = createProviderError(rawError, {
      modelId: "xai/grok-4.5",
    });
    const delivered: LocalAgentReply[] = [];

    await runLocalAgentTurn(
      { conversationId: conversationId!, message: "please try" },
      {
        agentRunner: {
          run: async () =>
            completedAgentRun(providerFailureReply(rawError, providerError)),
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
    expect(delivered[0]?.text).toContain("temporary connection problem");
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
    let capturedLogContext: ReturnType<typeof getLogContextAttributes>;
    const capture = vi.fn(
      (
        _error: unknown,
        _eventName: string,
        _attributes?: Record<string, unknown>,
      ) => {
        capturedLogContext = getLogContextAttributes();
        return eventId;
      },
    );
    const cancelAuthorization = vi.fn();

    await expect(
      runLocalAgentTurn(
        { conversationId: conversationId!, message: "please try" },
        {
          authorization: {
            cancel: cancelAuthorization,
            createState: vi.fn(async () => "local-oauth-state"),
            deliver: vi.fn(),
            wait: vi.fn(),
          },
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
    expect(capture.mock.calls[0]?.[2]).toEqual({
      "app.ai.failure_code": "agent_run_failed",
    });
    expect(capturedLogContext!).toMatchObject({
      "app.run.id": expect.stringMatching(/^local-run-[0-9a-f-]{36}$/),
      "gen_ai.conversation.id": conversationId,
    });
    expect(cancelAuthorization).toHaveBeenCalledOnce();
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
          saveTurnCheckpoint: async () => {
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
      piMessages: [assistantPiMessage("delivered")],
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
          saveTurnCheckpoint: async () => {
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

  it("forwards tool events from the shared reply boundary", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "tools",
      cwd: "/tmp/local-agent-runner-tools",
    });
    expect(conversationId).toBeDefined();

    const generateReply = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = request;

      await context.onEvent?.({
        type: "tool_started",
        params: { content: "The actor prefers short updates." },
        toolCallId: "tool-call-1",
        toolName: "createMemory",
      });
      await context.onEvent?.({
        type: "tool_finished",
        report: {
          ok: true,
          params: { content: "The actor prefers short updates." },
          result: { ok: true },
          toolCallId: "tool-call-1",
          toolName: "createMemory",
        },
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
              const context = request;

              const replyMessage = assistantPiMessage("captured", 2);
              const piMessages: PiMessage[] = [
                userPiMessage("capture this local turn"),
                replyMessage,
              ];
              await persistRunningSessionForFakeReply(context, piMessages);
              await deliverAssistantText(
                request,
                "captured",
                replyMessage,
                piMessages.slice(0, -1),
              );
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
          visibility: "private",
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

    const agentRuns: CapturedAgentRun[] = [];
    const agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([
        { type: "text", text: `reply to ${run.instruction.text}` },
      ]);
    });

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "first question",
      },
      {
        deliverReply: async () => undefined,
        agentRunner,
      },
    );
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "second question",
      },
      {
        deliverReply: async () => undefined,
        agentRunner,
      },
    );

    expect(agentRuns[1]?.instruction.context).toContain("first question");
    expect(agentRuns[1]?.instruction.context).toContain(
      "reply to first question",
    );

    const state = await getPersistedThreadState(conversationId!);
    expect(state.conversation).not.toHaveProperty("stats");
    expect(state.conversation).not.toHaveProperty("backfill");
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

    await expect(
      runLocalAgentTurn(
        {
          conversationId: conversationId!,
          message: "hello",
        },
        {
          agentRunner: neverRunAgentRunner(),
        } as unknown as Parameters<typeof runLocalAgentTurn>[1],
      ),
    ).rejects.toThrow("Local reply delivery is required");

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
    const projectedMessage = userPiMessage("projected history");
    await commitMessages({
      conversationId: conversationId!,
      messages: [projectedMessage],
    });

    const agentRuns: CapturedAgentRun[] = [];
    const agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([{ type: "text", text: "uses projection" }]);
    });

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "follow up",
      },
      {
        deliverReply: async () => undefined,
        agentRunner,
      },
    );

    expect(agentRuns[0]?.history).toEqual([projectedMessage]);
  });

  it("commits generated Pi history after successful local delivery", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "pi-history-commit",
      cwd: "/tmp/local-agent-runner-six",
    });
    expect(conversationId).toBeDefined();

    const firstAgentRunner = createModelAgentRunnerForRun(() =>
      createModelStream([{ type: "text", text: "persisted visible output" }]),
    );

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "hello",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: firstAgentRunner,
      },
    );

    const generatedMessages = await loadProjection({
      conversationId: conversationId!,
    });
    expect(generatedMessages).toEqual([
      expect.objectContaining({
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringContaining("hello"),
          },
        ],
      }),
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "persisted visible output" }],
      }),
    ]);

    const agentRuns: CapturedAgentRun[] = [];
    const followUpAgentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([{ type: "text", text: "follow up reply" }]);
    });
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "follow up",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: followUpAgentRunner,
      },
    );

    expect(agentRuns[0]?.history).toEqual(generatedMessages);
  });

  it("keeps the delivered local reply successful when a background task fails", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "background-task-failure",
      cwd: "/tmp/local-agent-runner-background-task-failure",
    });
    expect(conversationId).toBeDefined();

    const generatedMessage = assistantPiMessage("visible reply", 2);
    const generatedMessages: PiMessage[] = [
      userPiMessage("hello"),
      generatedMessage,
    ];
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
                const context = request;

                await persistRunningSessionForFakeReply(
                  context,
                  generatedMessages,
                );
                await deliverAssistantText(
                  request,
                  "visible reply",
                  generatedMessage,
                  generatedMessages.slice(0, -1),
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

  it("uses the SQL step projection as the Pi history authority", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "pi-history-projection-authority",
      cwd: "/tmp/local-agent-runner-seven",
    });
    expect(conversationId).toBeDefined();

    const projectedMessages = [
      userPiMessage("projected question"),
      assistantPiMessage("projected answer", 2),
      userPiMessage("projected follow-up", 3),
    ];
    await commitMessages({
      conversationId: conversationId!,
      messages: projectedMessages,
    });

    const agentRuns: CapturedAgentRun[] = [];
    const agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([{ type: "text", text: "uses projection" }]);
    });
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "follow up",
      },
      {
        deliverReply: async () => undefined,
        agentRunner,
      },
    );

    expect(agentRuns[0]?.history).toEqual(projectedMessages);
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
      const context = request;
      await context.durability?.onSandboxRefChanged?.({
        id: "sandbox-undelivered",
        profileHash: "profile-undelivered",
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
    expect(getPersistedSandboxState(state)).toBeUndefined();
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
