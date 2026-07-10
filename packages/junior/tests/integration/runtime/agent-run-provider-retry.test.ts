import { Buffer } from "node:buffer";
import { setTimeout as realSetTimeout } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource, type Destination } from "@sentry/junior-plugin-api";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";

const { agentMode, counters, sessionLogState } = vi.hoisted(() => ({
  agentMode: {
    value: "providerRetry" as
      | "providerRetry"
      | "cooperativeYield"
      | "steering"
      | "steeringSteerThrows"
      | "toolActivity",
  },
  counters: {
    continueCalls: 0,
    promptCalls: 0,
  },
  sessionLogState: {
    failToolExecutionAppend: false,
    toolExecutionAppendCalls: 0,
  },
}));

async function realSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => realSetTimeout(resolve, ms));
}

// Loop bounds are generous real-time ceilings, not expected waits: the loops
// return as soon as the condition holds, and saturated coverage workers can
// starve the event loop well past the nominal schedule.
async function waitForPromptCall(count: number): Promise<void> {
  for (let index = 0; index < 2_000; index += 1) {
    if (counters.promptCalls >= count) {
      return;
    }
    await realSleep(5);
  }
  throw new Error(`Expected ${count} prompt call(s)`);
}

async function advanceUntilContinueCall(maxMs: number): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs; elapsed += 100) {
    if (counters.continueCalls > 0) {
      return;
    }
    await vi.advanceTimersByTimeAsync(100);
    await realSleep(1);
  }
  // Fake time is fully advanced; the continuation is already scheduled and
  // only needs real event-loop turns to settle.
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (counters.continueCalls > 0) {
      return;
    }
    await realSleep(5);
  }
  throw new Error("Expected provider retry continuation to start");
}

vi.mock("@/chat/conversations/projection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/chat/conversations/projection")>();
  return {
    ...actual,
    recordToolExecutionStarted: async (
      ...args: Parameters<typeof actual.recordToolExecutionStarted>
    ) => {
      sessionLogState.toolExecutionAppendCalls += 1;
      if (sessionLogState.failToolExecutionAppend) {
        throw new Error("store blip during host-only append");
      }
      return actual.recordToolExecutionStarted(...args);
    },
  };
});

vi.mock("@earendil-works/pi-agent-core", () => {
  class MockAgent {
    state: {
      messages: unknown[];
      model: unknown;
      systemPrompt: string;
      tools: unknown[];
    };
    private prepareNextTurn?: () => Promise<unknown> | unknown;
    private steeringMessages: unknown[] = [];
    private subscribers: Array<(event: unknown) => unknown> = [];

    constructor(input: {
      initialState: {
        model: unknown;
        systemPrompt: string;
        tools: unknown[];
      };
      prepareNextTurn?: () => Promise<unknown> | unknown;
    }) {
      this.state = {
        messages: [],
        model: input.initialState.model,
        systemPrompt: input.initialState.systemPrompt,
        tools: input.initialState.tools,
      };
      this.prepareNextTurn = input.prepareNextTurn;
    }

    subscribe(subscriber: (event: unknown) => unknown) {
      this.subscribers.push(subscriber);
      return () => {
        this.subscribers = this.subscribers.filter(
          (candidate) => candidate !== subscriber,
        );
      };
    }

    steer(message: unknown) {
      if (agentMode.value === "steeringSteerThrows") {
        throw new Error("steer failed");
      }
      this.steeringMessages.push(message);
    }

    abort() {
      return undefined;
    }

    private recordRunFailure(error: unknown) {
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        usage: {
          input: 0,
          output: 0,
        },
      });
    }

    async prompt(message: unknown) {
      counters.promptCalls += 1;
      this.state.messages.push(message);
      if (agentMode.value === "toolActivity") {
        // Pi surfaces subscriber rejections as run failures; a host-only
        // activity append that rejects must not reach this path.
        try {
          await Promise.all(
            this.subscribers.map((subscriber) =>
              subscriber({
                type: "tool_execution_start",
                toolCallId: "call_1",
                toolName: "bash",
                args: { cmd: "ls" },
              }),
            ),
          );
        } catch (error) {
          this.recordRunFailure(error);
          return {};
        }
        this.state.messages.push({
          role: "toolResult",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "ok" }],
        });
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Tool done." }],
          stopReason: "stop",
          usage: {
            input: 2,
            output: 2,
          },
        });
        return {};
      }
      if (
        agentMode.value === "cooperativeYield" ||
        agentMode.value === "steering" ||
        agentMode.value === "steeringSteerThrows"
      ) {
        try {
          await this.prepareNextTurn?.();
        } catch (error) {
          this.recordRunFailure(error);
          return {};
        }
        this.state.messages.push(...this.steeringMessages);
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Steered." }],
          stopReason: "stop",
          usage: {
            input: 2,
            output: 2,
          },
        });
        return {};
      }
      this.state.messages.push({
        role: "toolResult",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "ok" }],
      });
      this.state.messages.push({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Anthropic stream ended before message_stop",
        usage: {
          input: 10,
          output: 1,
        },
      });
      return {};
    }

    async continue() {
      counters.continueCalls += 1;
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Recovered." }],
        stopReason: "stop",
        usage: {
          input: 2,
          output: 2,
        },
      });
      return {};
    }
  }

  return { Agent: MockAgent };
});

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    AGENT_TURN_TIMEOUT_MS: "10000",
    FUNCTION_MAX_DURATION_SECONDS: "60",
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: memoryConfig.bot,
    getChatConfig: () => memoryConfig,
    getRuntimeMetadata: () => ({ version: "test" }),
  };
});

vi.mock("@/chat/capabilities/factory", () => ({
  createUserTokenStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined,
    withRefresh: async <T>(
      _userId: string,
      _provider: string,
      callback: () => Promise<T>,
    ) => callback(),
  }),
}));

vi.mock("@/chat/capabilities/jr-rpc-command", () => ({
  maybeExecuteJrRpcCustomCommand: async () => ({ handled: false }),
}));

vi.mock("@/chat/pi/client", () => ({
  GEN_AI_PROVIDER_NAME: "vercel-ai-gateway",
  GEN_AI_SERVER_ADDRESS: "ai-gateway.vercel.sh",
  GEN_AI_SERVER_PORT: 443,
  completeObject: async () => ({
    object: {
      thinking_level: "medium",
      confidence: 1,
      reason: "test-router",
    },
  }),
  getPiGatewayApiKey: () => "test-gateway-key",
  resolveGatewayModel: (modelId: string) => modelId,
}));

vi.mock("@/chat/prompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/prompt")>();
  return {
    ...actual,
    buildSystemPrompt: () => "System prompt",
  };
});

vi.mock("@/chat/runtime/dev-agent-trace", () => ({
  shouldEmitDevAgentTrace: () => false,
}));

vi.mock("@/chat/sandbox/sandbox", () => ({
  createSandboxExecutor: () => ({
    configureSkills: () => undefined,
    configureReferenceFiles: () => undefined,
    createSandbox: async () => ({
      readFileToBuffer: async () => Buffer.from("", "utf8"),
      runCommand: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
    }),
    canExecute: () => false,
    execute: async () => {
      throw new Error("sandbox executor should not execute in this test");
    },
    getSandboxId: () => undefined,
    getDependencyProfileHash: () => undefined,
    dispose: async () => undefined,
  }),
}));

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getMcpProviders: () => [],
    getProviders: () => [],
  },
}));

vi.mock("@/chat/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/skills")>()),
  discoverSkills: async () => [],
  findSkillByName: () => null,
  parseSkillInvocation: () => null,
}));

import { executeAgentRun } from "@/chat/agent";
import { getConversationStore } from "@/chat/db";
import { getAwaitingAgentContinueRequest } from "@/chat/services/agent-continue";
import { persistCompletedSessionRecord } from "@/chat/services/turn-session-record";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import * as turnSessionState from "@/chat/state/turn-session";
import { createJuniorReporting } from "@/reporting";

function finalReply(outcome: Awaited<ReturnType<typeof executeAgentRun>>) {
  if (outcome.status !== "completed") {
    throw new Error(`Expected final reply, got ${outcome.status}`);
  }
  return outcome.result;
}

const TEST_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} satisfies Destination;
const TEST_SOURCE = createSlackSource({
  teamId: TEST_DESTINATION.teamId,
  channelId: TEST_DESTINATION.channelId,
  threadTs: "1712345.0001",
  type: "priv",
});

describe("executeAgentRun provider retry", () => {
  beforeEach(async () => {
    agentMode.value = "providerRetry";
    counters.continueCalls = 0;
    counters.promptCalls = 0;
    sessionLogState.failToolExecutionAppend = false;
    sessionLogState.toolExecutionAppendCalls = 0;
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
  });

  it("continues from the last safe boundary after a transient provider stream error", async () => {
    const replyPromise = executeAgentRun({
      input: { messageText: "help me" },
      routing: {
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
        correlation: {
          conversationId: "conversation-1",
          turnId: "turn-1",
          channelId: "C123",
          threadTs: "1712345.0001",
        },
      },
    });

    await waitForPromptCall(1);
    await advanceUntilContinueCall(5_000);
    const reply = finalReply(await replyPromise);

    expect(reply.text).toBe("Recovered.");
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.toolResultCount).toBe(1);
    expect(reply.diagnostics.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(counters.promptCalls).toBe(1);
    expect(counters.continueCalls).toBe(1);

    expect(reply.piMessages?.map((message) => message.role)).toEqual([
      "user",
      "toolResult",
      "assistant",
    ]);
    // Generation completing is not delivery: the record stays running at the
    // last safe boundary (no trailing assistant text) until the destination
    // boundary commits completion after acceptance.
    const sessionRecord = await turnSessionState.getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord?.state).toBe("running");
    expect(sessionRecord?.piMessages.map((message) => message.role)).toEqual([
      "user",
      "toolResult",
    ]);
  }, 20_000);

  it("persists and queues steering messages at the next Pi boundary", async () => {
    agentMode.value = "steering";
    const injectedTexts: string[] = [];
    const priorMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "previous question" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "previous answer" }],
        api: "responses",
        provider: "openai",
        model: "gpt-5.3",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    ] satisfies PiMessage[];

    // Reading the transcript below requires a source-confirmed public
    // destination; a bare C prefix no longer proves the channel public.
    await getConversationStore().recordActivity({
      conversationId: "slack:C123:1712345.0001",
      destination: TEST_DESTINATION,
      visibility: "public",
    });

    const reply = finalReply(
      await executeAgentRun({
        input: { messageText: "help me", piMessages: priorMessages },
        routing: {
          destination: TEST_DESTINATION,
          source: TEST_SOURCE,
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
          correlation: {
            conversationId: "slack:C123:1712345.0001",
            turnId: "turn-steering",
            channelId: "C123",
            threadTs: "1712345.0001",
          },
        },
        durability: {
          drainSteeringMessages: async (inject) => {
            const messages = [
              {
                text: "actually do the other thing",
                timestampMs: 2_000,
                provenance: { authority: "instruction" as const },
              },
            ];
            await inject(messages);
            injectedTexts.push(...messages.map((message) => message.text));
            return messages;
          },
        },
      }),
    );

    expect(reply.text).toBe("Steered.");
    expect(injectedTexts).toEqual(["actually do the other thing"]);

    // Simulate the destination boundary committing completion after
    // acceptance; generation itself no longer persists the final reply.
    await persistCompletedSessionRecord({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn-steering",
      allMessages: reply.piMessages ?? [],
      destination: TEST_DESTINATION,
      source: TEST_SOURCE,
      logContext: { modelId: "test-model" },
    });

    const sessionRecord = await turnSessionState.getAgentTurnSessionRecord(
      "slack:C123:1712345.0001",
      "turn-steering",
    );
    expect(sessionRecord?.turnStartMessageIndex).toBe(2);
    const serializedMessages = JSON.stringify(sessionRecord?.piMessages);
    expect(serializedMessages).toContain("previous question");
    expect(serializedMessages).toContain("help me");
    expect(serializedMessages).toContain("actually do the other thing");

    const report = await createJuniorReporting().getConversation(
      "slack:C123:1712345.0001",
    );
    const transcript = report.runs[0]?.transcript ?? [];
    expect(JSON.stringify(transcript)).toContain("previous question");
    expect(transcript).toHaveLength(5);
    expect(transcript[2]).toMatchObject({
      role: "user",
      timestamp: expect.any(Number),
      parts: expect.arrayContaining([{ type: "text", text: "help me" }]),
    });
    expect(transcript[3]).toEqual({
      role: "user",
      timestamp: 2_000,
      parts: [{ type: "text", text: "actually do the other thing" }],
    });
    expect(transcript[4]).toEqual({
      role: "assistant",
      parts: [{ type: "text", text: "Steered." }],
    });
  });

  it("parks the turn when the worker asks to yield at a Pi boundary", async () => {
    agentMode.value = "cooperativeYield";

    const outcome = await executeAgentRun({
      input: { messageText: "help me" },
      routing: {
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
        correlation: {
          conversationId: "conversation-yield",
          turnId: "turn-yield",
          channelId: "C123",
          threadTs: "1712345.0003",
        },
      },
      durability: { shouldYield: () => true },
    });

    expect(outcome).toMatchObject({
      status: "suspended",
      resumeVersion: expect.any(Number),
    });
    const sessionRecord = await turnSessionState.getAgentTurnSessionRecord(
      "conversation-yield",
      "turn-yield",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "yield",
      errorMessage: expect.stringContaining(
        "Agent turn yielded at a safe boundary",
      ),
      sliceId: 1,
    });
    expect(sessionRecord?.piMessages.map((message) => message.role)).toEqual([
      "user",
    ]);
    await expect(
      getAwaitingAgentContinueRequest({
        conversationId: "conversation-yield",
        sessionId: "turn-yield",
      }),
    ).resolves.toMatchObject({
      conversationId: "conversation-yield",
      destination: TEST_DESTINATION,
      sessionId: "turn-yield",
      expectedVersion: sessionRecord?.version,
    });
  });

  it("keeps steered messages when yielding after steering drain", async () => {
    agentMode.value = "cooperativeYield";

    const outcome = await executeAgentRun({
      input: { messageText: "help me" },
      routing: {
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
        correlation: {
          conversationId: "conversation-yield-steering",
          turnId: "turn-yield-steering",
          channelId: "C123",
          threadTs: "1712345.0005",
        },
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
      },
      durability: {
        drainSteeringMessages: async (inject) => {
          const messages = [
            {
              text: "actually do the other thing",
              timestampMs: 2_000,
              provenance: { authority: "instruction" as const },
            },
          ];
          await inject(messages);
          return messages;
        },
        shouldYield: () => true,
      },
    });

    expect(outcome).toMatchObject({
      status: "suspended",
      resumeVersion: expect.any(Number),
    });
    const sessionRecord = await turnSessionState.getAgentTurnSessionRecord(
      "conversation-yield-steering",
      "turn-yield-steering",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "yield",
      errorMessage: expect.stringContaining(
        "Agent turn yielded at a safe boundary",
      ),
      sliceId: 1,
    });
    expect(sessionRecord?.piMessages.map((message) => message.role)).toEqual([
      "user",
      "user",
    ]);
    const serializedMessages = JSON.stringify(sessionRecord?.piMessages);
    expect(serializedMessages).toContain("help me");
    expect(serializedMessages).toContain("actually do the other thing");
  });

  it("throws when a cooperative yield cannot persist its resumable boundary", async () => {
    agentMode.value = "cooperativeYield";
    const upsertSpy = vi
      .spyOn(turnSessionState, "upsertAgentTurnSessionRecord")
      .mockRejectedValue(new Error("storage unavailable"));

    const error = await executeAgentRun({
      input: { messageText: "help me" },
      routing: {
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
        correlation: {
          conversationId: "conversation-yield-persist-failure",
          turnId: "turn-yield-persist-failure",
          channelId: "C123",
          threadTs: "1712345.0004",
        },
      },
      durability: { shouldYield: () => true },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    upsertSpy.mockRestore();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Failed to persist cooperative yield continuation",
    );
    await expect(
      turnSessionState.getAgentTurnSessionRecord(
        "conversation-yield-persist-failure",
        "turn-yield-persist-failure",
      ),
    ).resolves.toBeUndefined();
  });

  it("swallows failed host-only activity appends without killing the turn", async () => {
    agentMode.value = "toolActivity";
    sessionLogState.failToolExecutionAppend = true;

    const reply = finalReply(
      await executeAgentRun({
        input: { messageText: "run the tool" },
        routing: {
          destination: TEST_DESTINATION,
          source: TEST_SOURCE,
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
          correlation: {
            conversationId: "conversation-tool-activity",
            turnId: "turn-tool-activity",
            channelId: "C123",
            threadTs: "1712345.0006",
          },
        },
      }),
    );

    expect(sessionLogState.toolExecutionAppendCalls).toBe(1);
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.text).toBe("Tool done.");
  });

  it("does not duplicate the user prompt when a lost input commit replays against a running record", async () => {
    agentMode.value = "steering";
    const conversationId = "conversation-replay";
    const sessionId = "turn-replay";
    const checkpointedPrompt = {
      role: "user",
      content: [{ type: "text", text: renderCurrentInstruction("help me") }],
      timestamp: 5,
    } satisfies PiMessage;
    await turnSessionState.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 1,
      state: "running",
      destination: TEST_DESTINATION,
      source: TEST_SOURCE,
      piMessages: [checkpointedPrompt],
      turnStartMessageIndex: 0,
    });

    const reply = finalReply(
      await executeAgentRun({
        input: { messageText: "help me", piMessages: [checkpointedPrompt] },
        routing: {
          destination: TEST_DESTINATION,
          source: TEST_SOURCE,
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
          correlation: {
            conversationId,
            turnId: sessionId,
            channelId: "C123",
            threadTs: "1712345.0007",
          },
        },
      }),
    );

    expect(reply.diagnostics.outcome).toBe("success");
    const sessionRecord = await turnSessionState.getAgentTurnSessionRecord(
      conversationId,
      sessionId,
    );
    const userMessages =
      sessionRecord?.piMessages.filter((message) => message.role === "user") ??
      [];
    expect(userMessages).toHaveLength(1);
    expect(
      JSON.stringify(sessionRecord?.piMessages).split("help me"),
    ).toHaveLength(2);
  });

  it("rejects steering injection when Pi steer fails", async () => {
    agentMode.value = "steeringSteerThrows";
    let injectRejected = false;
    let injectCompleted = false;

    await executeAgentRun({
      input: { messageText: "help me" },
      routing: {
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
        correlation: {
          conversationId: "conversation-steering-failure",
          turnId: "turn-steering-failure",
          channelId: "C123",
          threadTs: "1712345.0002",
        },
      },
      durability: {
        drainSteeringMessages: async (inject) => {
          const messages = [
            {
              text: "actually do the other thing",
              timestampMs: 2_000,
              provenance: { authority: "instruction" as const },
            },
          ];
          try {
            await inject(messages);
            injectCompleted = true;
            return messages;
          } catch {
            injectRejected = true;
            throw new Error("inject rejected");
          }
        },
      },
    });

    expect(injectRejected).toBe(true);
    expect(injectCompleted).toBe(false);
  });
});
