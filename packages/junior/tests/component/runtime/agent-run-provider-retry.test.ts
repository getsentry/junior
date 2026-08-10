import { Buffer } from "node:buffer";
import { setTimeout as realSetTimeout } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource, type Destination } from "@sentry/junior-plugin-api";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";
import { extractAssistantText } from "@/chat/pi/transcript";
import { readConversationDetail } from "@/api/conversations/detail";

const OVERSIZED_CONTEXT_TEXT = "x".repeat(1_600_000);
const { agentMode, compactionState, counters, sessionLogState } = vi.hoisted(
  () => ({
    agentMode: {
      value: "providerRetry" as
        | "providerRetry"
        | "activeCompaction"
        | "preflightCompaction"
        | "pendingProviderCall"
        | "cooperativeYield"
        | "silentResume"
        | "terminalDelivery"
        | "steering"
        | "steeringDelivery"
        | "steeringSteerThrows"
        | "toolActivity",
    },
    compactionState: {
      nextProviderContextChars: 0,
      nextProviderContextText: "",
      preflightContextText: "",
      summaryCalls: 0,
    },
    counters: {
      abortCalls: 0,
      continueCalls: 0,
      promptCalls: 0,
    },
    sessionLogState: {
      failToolExecutionAppend: false,
      toolExecutionAppendCalls: 0,
    },
  }),
);

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
    await realSleep(5);
    await vi.advanceTimersByTimeAsync(100);
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

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  function durableTestMessage(message: unknown) {
    const data = message as Record<string, unknown>;
    if (data.role === "assistant") {
      return {
        api: "openai-responses",
        provider: "openai",
        model: "test-model",
        usage: {},
        stopReason: "stop",
        timestamp: Date.now(),
        ...data,
      };
    }
    if (data.role === "toolResult") {
      return {
        toolCallId: "test-tool-call",
        timestamp: Date.now(),
        ...data,
      };
    }
    if (data.role === "user") {
      return { timestamp: Date.now(), ...data };
    }
    return message;
  }

  class MockAgent {
    state: {
      messages: unknown[];
      model: unknown;
      systemPrompt: string;
      tools: unknown[];
    };
    private prepareNextTurn?: (context?: unknown) => Promise<unknown> | unknown;
    private finishPendingRun?: () => void;
    private steeringMessages: unknown[] = [];
    private subscribers: Array<(event: unknown) => unknown> = [];

    constructor(input: {
      initialState: {
        model: unknown;
        systemPrompt: string;
        tools: unknown[];
      };
      prepareNextTurn?: () => Promise<unknown> | unknown;
      prepareNextTurnWithContext?: (
        context: unknown,
      ) => Promise<unknown> | unknown;
    }) {
      this.state = {
        messages: [],
        model: input.initialState.model,
        systemPrompt: input.initialState.systemPrompt,
        tools: input.initialState.tools,
      };
      this.prepareNextTurn =
        input.prepareNextTurnWithContext ?? input.prepareNextTurn;
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
      counters.abortCalls += 1;
      this.finishPendingRun?.();
    }

    private pushMessages(...messages: unknown[]) {
      this.state.messages.push(...messages.map(durableTestMessage));
    }

    private async emitAssistant(text: string) {
      const message = {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: { input: 2, output: 2 },
      };
      this.pushMessages(message);
      await Promise.all(
        this.subscribers.map((subscriber) =>
          subscriber({ type: "message_end", message }),
        ),
      );
    }

    private recordRunFailure(error: unknown) {
      this.pushMessages({
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
      this.pushMessages(message);
      if (agentMode.value === "activeCompaction") {
        const toolResult = {
          role: "toolResult",
          toolCallId: "call_oversized",
          toolName: "editFile",
          isError: false,
          content: [{ type: "text", text: OVERSIZED_CONTEXT_TEXT }],
        };
        this.pushMessages({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_oversized",
              name: "editFile",
              arguments: {},
            },
          ],
          stopReason: "toolUse",
          usage: { input: 2, output: 2 },
        });
        this.pushMessages(toolResult);
        await Promise.all(
          this.subscribers.map((subscriber) =>
            subscriber({
              type: "turn_end",
              message: this.state.messages.at(-2),
              toolResults: [toolResult],
            }),
          ),
        );
        await this.prepareNextTurn?.({
          context: { messages: this.state.messages },
        });
        compactionState.nextProviderContextText = JSON.stringify(
          this.state.messages,
        );
        compactionState.nextProviderContextChars =
          compactionState.nextProviderContextText.length;
        const keptRequest = compactionState.nextProviderContextText.includes(
          "Make a large generated-file edit.",
        );
        await this.emitAssistant(
          keptRequest
            ? "Finished the requested edit."
            : "got it — context checkpoint loaded. no outstanding asks.",
        );
        return {};
      }
      if (agentMode.value === "pendingProviderCall") {
        await new Promise<void>((resolve) => {
          this.finishPendingRun = resolve;
        });
        return {};
      }
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
        this.pushMessages({
          role: "toolResult",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "ok" }],
        });
        this.pushMessages({
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
      if (agentMode.value === "terminalDelivery") {
        const finalMessage = {
          role: "assistant",
          content: [{ type: "text", text: "Final answer." }],
          stopReason: "stop",
          usage: { input: 2, output: 2 },
        };
        this.pushMessages(finalMessage);
        await Promise.all(
          this.subscribers.map((subscriber) =>
            subscriber({ type: "message_end", message: finalMessage }),
          ),
        );
        await Promise.all(
          this.subscribers.map((subscriber) =>
            subscriber({
              type: "turn_end",
              message: finalMessage,
              toolResults: [],
            }),
          ),
        );
        try {
          await this.prepareNextTurn?.({
            context: { messages: this.state.messages },
          });
        } catch (error) {
          this.recordRunFailure(error);
        }
        return {};
      }
      if (
        agentMode.value === "cooperativeYield" ||
        agentMode.value === "steering" ||
        agentMode.value === "steeringDelivery" ||
        agentMode.value === "steeringSteerThrows"
      ) {
        if (agentMode.value === "steeringDelivery") {
          const firstMessage = {
            role: "assistant",
            content: [{ type: "text", text: "Initial answer." }],
            stopReason: "stop",
            usage: { input: 2, output: 2 },
          };
          this.pushMessages(firstMessage);
          await Promise.all(
            this.subscribers.map((subscriber) =>
              subscriber({ type: "message_end", message: firstMessage }),
            ),
          );
        }
        try {
          await this.prepareNextTurn?.({
            context: { messages: this.state.messages },
          });
        } catch (error) {
          this.recordRunFailure(error);
          return {};
        }
        if (agentMode.value === "steeringDelivery") {
          await Promise.all(
            this.subscribers.map((subscriber) =>
              subscriber({ type: "turn_start" }),
            ),
          );
        }
        this.pushMessages(...this.steeringMessages);
        const finalMessage = {
          role: "assistant",
          content: [{ type: "text", text: "Steered." }],
          stopReason: "stop",
          usage: {
            input: 2,
            output: 2,
          },
        };
        this.pushMessages(finalMessage);
        if (agentMode.value === "steeringDelivery") {
          await Promise.all(
            this.subscribers.map((subscriber) =>
              subscriber({ type: "message_end", message: finalMessage }),
            ),
          );
        }
        return {};
      }
      this.pushMessages({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "test-tool-call",
            name: "bash",
            arguments: {},
          },
        ],
        stopReason: "toolUse",
        usage: {
          input: 4,
          output: 1,
        },
      });
      this.pushMessages({
        role: "toolResult",
        toolCallId: "test-tool-call",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "ok" }],
      });
      this.pushMessages({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "408 Request failed",
        usage: {
          input: 10,
          output: 1,
        },
      });
      return {};
    }

    async continue() {
      counters.continueCalls += 1;
      if (agentMode.value === "silentResume") {
        if (counters.continueCalls === 1) {
          return {};
        }
        const confirmation = {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Deleting preview-42 and all of its contents is permanent. Shall I proceed?",
            },
          ],
          stopReason: "stop",
          usage: { input: 2, output: 2 },
        };
        this.state.messages.push(confirmation);
        await Promise.all(
          this.subscribers.map((subscriber) =>
            subscriber({ type: "message_end", message: confirmation }),
          ),
        );
        return {};
      }
      if (agentMode.value === "preflightCompaction") {
        compactionState.preflightContextText = this.state.messages
          .flatMap((message) => {
            const content = (message as { content?: unknown }).content;
            return Array.isArray(content)
              ? content.map((part) =>
                  part &&
                  typeof part === "object" &&
                  "text" in part &&
                  typeof part.text === "string"
                    ? part.text
                    : "",
                )
              : [];
          })
          .join("\n");
        this.pushMessages({
          role: "assistant",
          content: [
            { type: "text", text: "Preserved after preflight compaction." },
          ],
          stopReason: "stop",
          usage: {
            input: 2,
            output: 2,
          },
        });
        return {};
      }
      const finalMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Recovered." }],
        stopReason: "stop",
        usage: {
          input: 2,
          output: 2,
        },
      };
      this.pushMessages(finalMessage);
      return {};
    }
  }

  return { ...actual, Agent: MockAgent };
});

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    AGENT_TURN_TIMEOUT_MS: "10000",
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
      reasoning_level: "medium",
      profile: "standard",
      confidence: 1,
      reason: "test-router",
    },
  }),
  completeText: async () => {
    compactionState.summaryCalls += 1;
    return {
      text:
        agentMode.value === "activeCompaction"
          ? "No outstanding asks."
          : "The edit completed; verify the changed file.",
    };
  },
  getGatewayApiKey: () => "test-gateway-key",
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
  createSandbox: () => ({
    captureRepositoryInstructions: async () => undefined,
    workspace: {
      readFileToBuffer: async () => Buffer.from("", "utf8"),
      runCommand: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
      writeFiles: async () => undefined,
    },
    tools: {
      supports: () => false,
      execute: async () => {
        throw new Error("sandbox executor should not execute in this test");
      },
    },
    sandboxRef: () => undefined,
    close: vi.fn(),
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
import { getPausedTurnRequest } from "@/chat/task-execution/turn-wake";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import * as turnSessionState from "@/chat/task-execution/turn-cursor";

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
  visibility: "private",
});
const TEST_USAGE = {
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
};

describe("agent run continuation", () => {
  beforeEach(async () => {
    agentMode.value = "providerRetry";
    counters.abortCalls = 0;
    counters.continueCalls = 0;
    counters.promptCalls = 0;
    compactionState.nextProviderContextChars = 0;
    compactionState.nextProviderContextText = "";
    compactionState.preflightContextText = "";
    compactionState.summaryCalls = 0;
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

  it("continues the user's request when active compaction writes a wrong summary", async () => {
    agentMode.value = "activeCompaction";

    const result = finalReply(
      await executeAgentRun({
  conversationId: "conversation-active-compaction",
  turnId: "turn-active-compaction",
  instruction:   {
  text: "Make a large generated-file edit.",
  },
  destinationVisibility: "private",
  source: TEST_SOURCE,
  destination: TEST_DESTINATION,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
}),
    );

    expect(result.text).toBe("Finished the requested edit.");
    expect(compactionState.summaryCalls).toBe(1);
    expect(compactionState.nextProviderContextChars).toBeLessThan(20_000);
    expect(compactionState.nextProviderContextText).toContain(
      "Make a large generated-file edit.",
    );
    expect(compactionState.nextProviderContextText).toContain(
      "No outstanding asks.",
    );
    expect(result.diagnostics.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 4,
    });
    const history = await (await import("@/chat/db"))
      .getConversationEventStore()
      .loadHistory("conversation-active-compaction");
    expect(history.some((event) => event.data.type === "compaction")).toBe(
      true,
    );
  });

  it("retains the complete current instruction across preflight compaction", async () => {
    agentMode.value = "preflightCompaction";
    const currentInstruction = `PRESERVE_THIS_START:${"z".repeat(12_000)}:PRESERVE_THIS_END`;
    const priorMessages = [
      {
        role: "toolResult",
        toolCallId: "call_prior_oversized",
        toolName: "editFile",
        isError: false,
        content: [{ type: "text", text: OVERSIZED_CONTEXT_TEXT }],
        timestamp: 1,
      } as PiMessage,
    ];

    const result = finalReply(
      await executeAgentRun({
  conversationId: "conversation-preflight-compaction",
  turnId: "turn-preflight-compaction",
  instruction:   {
  text: currentInstruction,
  },
  history: priorMessages,
  destinationVisibility: "private",
  source: TEST_SOURCE,
  destination: TEST_DESTINATION,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
}),
    );

    expect(result.text).toBe("Preserved after preflight compaction.");
    expect(compactionState.summaryCalls).toBe(1);
    expect(compactionState.preflightContextText).toContain(currentInstruction);
    expect(
      compactionState.preflightContextText.match(/PRESERVE_THIS_START/g),
    ).toHaveLength(1);
  });

  it("continues from the last safe boundary after an HTTP request timeout", async () => {
    const replyPromise = executeAgentRun({
  conversationId: "conversation-1",
  turnId: "turn-1",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
});

    await waitForPromptCall(1);
    await Promise.race([
      advanceUntilContinueCall(5_000),
      replyPromise.then((outcome) => {
        if (counters.continueCalls === 0) {
          throw new Error(
            `Agent run settled before provider retry continuation: ${outcome.status}`,
          );
        }
      }),
    ]);
    const reply = finalReply(await replyPromise);

    expect(reply.text).toBe("Recovered.");
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.toolResultCount).toBe(1);
    expect(reply.diagnostics.usage).toMatchObject({
      inputTokens: 16,
      outputTokens: 4,
    });
    expect(counters.promptCalls).toBe(1);
    expect(counters.continueCalls).toBe(1);

    expect(reply.piMessages?.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    // Generation completing is not delivery: the record stays running at the
    // last safe boundary (no trailing assistant text) until the destination
    // boundary commits completion after acceptance.
    const sessionRecord = await turnSessionState.getTurnRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord?.state).toBe("running");
    expect(sessionRecord?.piMessages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "toolResult",
    ]);

    await saveTurnCheckpoint({
      mode: "completed",
      conversationId: "conversation-1",
      turnId: "turn-1",
      messages: reply.piMessages ?? [],
      usage: reply.diagnostics.usage,
    });
    const completedSessionRecord = await turnSessionState.getTurnRecord(
      "conversation-1",
      "turn-1",
    );
    expect(completedSessionRecord).toMatchObject({
      state: "completed",
      cumulativeUsage: {
        inputTokens: 16,
        outputTokens: 4,
      },
    });
  }, 40_000);

  it("stops provider retry backoff when the host request is cancelled", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const controller = new AbortController();
    const replyPromise = executeAgentRun({
  conversationId: "conversation-cancelled-backoff",
  turnId: "turn-cancelled-backoff",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
  signal: controller.signal,
});

    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if (setTimeoutSpy.mock.calls.some((call) => call[1] === 2_000)) {
        break;
      }
      await realSleep(5);
    }
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 2_000)).toBe(
      true,
    );
    const cancellation = new Error("provider connection cancelled");
    controller.abort(cancellation);

    const reply = finalReply(await replyPromise);
    expect(reply.diagnostics.errorMessage).toBe(
      "provider connection cancelled",
    );
    expect(reply.diagnostics.providerError).toBe(cancellation);
    expect(counters.continueCalls).toBe(0);
    setTimeoutSpy.mockRestore();
  });

  it("aborts an active provider call when the host request is cancelled", async () => {
    agentMode.value = "pendingProviderCall";
    const controller = new AbortController();
    const replyPromise = executeAgentRun({
  conversationId: "conversation-cancelled-provider",
  turnId: "turn-cancelled-provider",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
  signal: controller.signal,
});

    await waitForPromptCall(1);
    controller.abort(new Error("eval test cancelled"));

    const reply = finalReply(await replyPromise);
    expect(reply.diagnostics.errorMessage).toBe("eval test cancelled");
    expect(counters.abortCalls).toBe(1);
    expect(counters.continueCalls).toBe(0);
  });

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
        usage: TEST_USAGE,
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
  conversationId: "slack:C123:1712345.0001",
  turnId: "turn-steering",
  instruction:   {
  text: "help me",
  },
  history: priorMessages,
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
  durability:   {
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
    // acceptance; generation itself does not commit provider delivery.
    await saveTurnCheckpoint({
      mode: "completed",
      conversationId: "slack:C123:1712345.0001",
      turnId: "turn-steering",
      messages: reply.piMessages ?? [],
      destination: TEST_DESTINATION,
      source: TEST_SOURCE,
    });

    const sessionRecord = await turnSessionState.getTurnRecord(
      "slack:C123:1712345.0001",
      "turn-steering",
    );
    expect(sessionRecord?.turnStartMessageIndex).toBe(2);
    const serializedMessages = JSON.stringify(sessionRecord?.piMessages);
    expect(serializedMessages).toContain("previous question");
    expect(serializedMessages).toContain("help me");
    expect(serializedMessages).toContain("actually do the other thing");

    const report = await readConversationDetail("slack:C123:1712345.0001");
    const visibleText = report?.events.flatMap((event) =>
      event.data.type === "message" && event.data.text ? [event.data.text] : [],
    );
    expect(visibleText).not.toContain("previous question");
    expect(visibleText).toEqual([]);
  });

  it("delivers a text-only message before a steered terminal response", async () => {
    agentMode.value = "steeringDelivery";
    const delivered: Array<{ text: string }> = [];

    const outcome = await executeAgentRun({
  conversationId: "conversation-steering-delivery",
  turnId: "turn-steering-delivery",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
  delivery:   (message) => {
          delivered.push({ text: extractAssistantText(message) });
        },
  durability:   {
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
        },
});

    expect(outcome.status).toBe("completed");
    expect(delivered).toEqual([
      { text: "Initial answer." },
      { text: "Steered." },
    ]);
  });

  it("does not suspend after delivering a terminal response", async () => {
    agentMode.value = "terminalDelivery";
    const delivered: Array<{ text: string }> = [];

    const outcome = await executeAgentRun({
  conversationId: "conversation-terminal-delivery-yield",
  turnId: "turn-terminal-delivery-yield",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
  delivery:   (message) => {
          delivered.push({ text: extractAssistantText(message) });
        },
  durability: { shouldYield: () => true },
});

    expect(delivered).toEqual([{ text: "Final answer." }]);
    expect(outcome.status).toBe("completed");
  });

  it("can suspend after delivery when steering creates a continuable boundary", async () => {
    agentMode.value = "steeringDelivery";
    const delivered: Array<{ text: string }> = [];

    const outcome = await executeAgentRun({
  conversationId: "conversation-delivery-steering-yield",
  turnId: "turn-delivery-steering-yield",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
  delivery:   (message) => {
          delivered.push({ text: extractAssistantText(message) });
        },
  durability:   {
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

    expect(outcome.status).toBe("suspended");
    expect(delivered).toEqual([{ text: "Initial answer." }]);
    const sessionRecord = await turnSessionState.getTurnRecord(
      "conversation-delivery-steering-yield",
      "turn-delivery-steering-yield",
    );
    expect(sessionRecord?.piMessages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("parks the turn when the worker asks to yield at a Pi boundary", async () => {
    agentMode.value = "cooperativeYield";

    const outcome = await executeAgentRun({
  conversationId: "conversation-yield",
  turnId: "turn-yield",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
  durability: { shouldYield: () => true },
});

    expect(outcome).toMatchObject({
      status: "suspended",
      resumeVersion: expect.any(Number),
    });
    const sessionRecord = await turnSessionState.getTurnRecord(
      "conversation-yield",
      "turn-yield",
    );
    expect(sessionRecord).toMatchObject({
      state: "paused",
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
    await expect(
      getPausedTurnRequest({
        conversationId: "conversation-yield",
        turnId: "turn-yield",
      }),
    ).resolves.toMatchObject({
      conversationId: "conversation-yield",
      destination: TEST_DESTINATION,
      turnId: "turn-yield",
      expectedVersion: sessionRecord?.version,
    });
  });

  it("delivers confirmation after resuming from an ask rejection boundary", async () => {
    agentMode.value = "silentResume";
    const conversationId = "conversation-ask-resume";
    const turnId = "turn-ask-resume";
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Delete preview-42 after I confirm." }],
        timestamp: 1,
      },
      {
        role: "assistant",
        api: "test",
        provider: "test",
        model: "test/model",
        content: [
          {
            type: "toolCall",
            id: "delete-preview-42",
            name: "deleteWorkspace",
            arguments: { workspace: "preview-42" },
          },
        ],
        usage: TEST_USAGE,
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "delete-preview-42",
        toolName: "deleteWorkspace",
        content: [{ type: "text", text: "confirmation required" }],
        isError: true,
        timestamp: 3,
        details: {
          guardianActionRejection: {
            decision: "ask",
            priorRejection: {
              instruction: {
                workspace: "preview-42",
              },
              decision: "ask",
              reason: "User has not confirmed permanently deleting preview-42 and all of its contents.",
              tool: {
                description:
                  "Permanently delete preview-42 and all of its contents.",
                name: "deleteWorkspace",
              },
            },
            reason:
              "User has not confirmed permanently deleting preview-42 and all of its contents.",
            version: 1,
          },
        },
      },
    ] as PiMessage[];
    await turnSessionState.upsertTurnRecord({
      conversationId,
      turnId: turnId,
      sliceId: 1,
      state: "paused",
      destination: TEST_DESTINATION,
      source: TEST_SOURCE,
      piMessages: messages,
      turnStartMessageIndex: 0,
      resumeReason: "yield",
      errorMessage: "Agent turn yielded at a safe boundary",
    });
    const delivered: Array<{ text: string }> = [];

    const result = finalReply(
      await executeAgentRun({
        conversationId,
        turnId,
        instruction: { text: "Delete preview-42 after I confirm." },
        destinationVisibility: "private",
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
        delivery: (message) => {
          delivered.push({ text: extractAssistantText(message) });
        },
      }),
    );

    const confirmation =
      "Deleting preview-42 and all of its contents is permanent. Shall I proceed?";
    expect(result.text).toBe(confirmation);
    expect(delivered).toEqual([{ text: confirmation }]);
    expect(counters.continueCalls).toBe(2);
  });

  it("keeps steered messages when yielding after steering drain", async () => {
    agentMode.value = "cooperativeYield";

    const outcome = await executeAgentRun({
  conversationId: "conversation-yield-steering",
  turnId: "turn-yield-steering",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  durability:   {
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
    const sessionRecord = await turnSessionState.getTurnRecord(
      "conversation-yield-steering",
      "turn-yield-steering",
    );
    expect(sessionRecord).toMatchObject({
      state: "paused",
      resumeReason: "yield",
      errorMessage: expect.stringContaining(
        "Agent turn yielded at a safe boundary",
      ),
      sliceId: 1,
    });
    expect(sessionRecord?.piMessages.map((message) => message.role)).toEqual([
      "user",
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
      .spyOn(turnSessionState, "upsertTurnRecord")
      .mockRejectedValue(new Error("storage unavailable"));

    const error = await executeAgentRun({
  conversationId: "conversation-yield-persist-failure",
  turnId: "turn-yield-persist-failure",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
  durability: { shouldYield: () => true },
}).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    upsertSpy.mockRestore();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Failed to persist continuation",
    );
    await expect(
      turnSessionState.getTurnRecord(
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
  conversationId: "conversation-tool-activity",
  turnId: "turn-tool-activity",
  instruction:   {
  text: "run the tool",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
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
    await turnSessionState.upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 1,
      state: "running",
      destination: TEST_DESTINATION,
      source: TEST_SOURCE,
      piMessages: [checkpointedPrompt],
      turnStartMessageIndex: 0,
    });

    const reply = finalReply(
      await executeAgentRun({
        conversationId,
        turnId: sessionId,
        instruction: { text: "help me" },
        history: [checkpointedPrompt],
        destinationVisibility: "private",
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
      }),
    );

    expect(reply.diagnostics.outcome).toBe("success");
    const sessionRecord = await turnSessionState.getTurnRecord(
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
  conversationId: "conversation-steering-failure",
  turnId: "turn-steering-failure",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: { platform: "slack", teamId: "T123", userId: "U123" },
  durability:   {
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
