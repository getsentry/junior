import { Buffer } from "node:buffer";
import { setTimeout as realSetTimeout } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource, type Destination } from "@sentry/junior-plugin-api";
import type { PiMessage } from "@/chat/pi/messages";

const { continueCalls, promptAborted, promptCalls, promptMode, promptSettled } =
  vi.hoisted(() => ({
    continueCalls: { value: 0 },
    promptAborted: { value: false },
    promptCalls: { value: 0 },
    promptMode: {
      value: "settlesAfterAbort" as
        | "settlesAfterAbort"
        | "hangsAfterAbort"
        | "continueSettlesAfterAbort"
        | "providerRetryThenHangs",
    },
    promptSettled: { value: false },
  }));

async function realSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => realSetTimeout(resolve, ms));
}

// Loop bounds are generous real-time ceilings, not expected waits: the loops
// return as soon as the condition holds, and saturated coverage workers can
// starve the event loop well past the nominal schedule.
async function waitForPromptCall(count: number): Promise<void> {
  for (let index = 0; index < 2_000; index += 1) {
    if (promptCalls.value >= count) {
      return;
    }
    await realSleep(5);
  }
  throw new Error(`Expected ${count} prompt call(s)`);
}

async function waitForProviderPromptSettlement(): Promise<void> {
  for (let index = 0; index < 2_000; index += 1) {
    if (promptSettled.value) {
      return;
    }
    await realSleep(5);
  }
  throw new Error("Expected provider retry prompt to settle");
}

async function advanceUntilContinueCall(maxMs: number): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs; elapsed += 100) {
    if (continueCalls.value > 0) {
      return;
    }
    await vi.advanceTimersByTimeAsync(100);
    await realSleep(1);
  }
  // Fake time is fully advanced; the continuation is already scheduled and
  // only needs real event-loop turns to settle.
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (continueCalls.value > 0) {
      return;
    }
    await realSleep(5);
  }
  throw new Error("Expected provider retry continuation to start");
}

vi.mock("@earendil-works/pi-agent-core", () => {
  class MockAgent {
    state: {
      messages: unknown[];
      model: unknown;
      systemPrompt: string;
      tools: unknown[];
    };
    private resolveAbort?: () => void;

    constructor(input: {
      initialState: {
        model: unknown;
        systemPrompt: string;
        tools: unknown[];
      };
    }) {
      this.state = {
        messages: [],
        model: input.initialState.model,
        systemPrompt: input.initialState.systemPrompt,
        tools: input.initialState.tools,
      };
    }

    subscribe() {
      return () => undefined;
    }

    abort() {
      promptAborted.value = true;
      this.resolveAbort?.();
    }

    async continue() {
      continueCalls.value += 1;
      if (promptMode.value === "continueSettlesAfterAbort") {
        await new Promise<void>((resolve) => {
          this.resolveAbort = resolve;
        });
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "continued partial" }],
        });
        return {};
      }
      if (promptMode.value === "providerRetryThenHangs") {
        await new Promise<void>((resolve) => {
          this.resolveAbort = resolve;
        });
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "continued partial" }],
          stopReason: "stop",
        });
        return {};
      }

      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "continued" }],
        stopReason: "stop",
      });
      return {};
    }

    async prompt(message: unknown) {
      promptCalls.value += 1;
      this.state.messages.push(message);
      if (promptMode.value === "providerRetryThenHangs") {
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "provider error" }],
          stopReason: "error",
          errorMessage: "Provider returned error: 503 service unavailable",
        });
        promptSettled.value = true;
        return {};
      }
      if (promptMode.value === "hangsAfterAbort") {
        await new Promise(() => undefined);
        return {};
      }
      await new Promise<void>((resolve) => {
        this.resolveAbort = resolve;
      });
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
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
import { isTurnInputCommitLostError } from "@/chat/runtime/turn";
import { AGENT_CONTINUE_MAX_SLICES } from "@/chat/services/turn-session-record";
import { getConversationStore } from "@/chat/db";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";

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

const TEST_REQUESTER = {
  platform: "slack",
  teamId: "T123",
  userId: "U123",
} as const;

describe("executeAgentRun agent continuation", () => {
  beforeEach(async () => {
    promptAborted.value = false;
    continueCalls.value = 0;
    promptCalls.value = 0;
    promptMode.value = "settlesAfterAbort";
    promptSettled.value = false;
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
    await getConversationStore().listByActivity({ limit: 1 });
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
  });

  it("rejects durable input when no prompt checkpoint can be persisted", async () => {
    const onInputCommitted = vi.fn();

    const error = await executeAgentRun({
      input: { messageText: "help me" },
      routing: { destination: TEST_DESTINATION, source: TEST_SOURCE },
      durability: { onInputCommitted },
    }).catch((caught) => caught);

    expect(isTurnInputCommitLostError(error)).toBe(true);
    expect(onInputCommitted).not.toHaveBeenCalled();
  });

  it("stores the last safe boundary and returns a timed-out outcome", async () => {
    const replyPromise = executeAgentRun({
      input: { messageText: "help me" },
      routing: {
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        requester: TEST_REQUESTER,
        correlation: {
          conversationId: "conversation-1",
          turnId: "turn-1",
          channelId: "C123",
          threadTs: "1712345.0001",
        },
      },
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(outcome).toMatchObject({
      status: "suspended",
      resumeVersion: expect.any(Number),
    });

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      sliceId: 2,
    });
    expect(sessionRecord?.piMessages).toEqual([
      expect.objectContaining({
        role: "user",
      }),
    ]);
  });

  it("throws terminal timeout failures instead of returning an error reply after the slice cap", async () => {
    promptMode.value = "continueSettlesAfterAbort";
    const piMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "keep trying" }],
        timestamp: 1,
      } as PiMessage,
    ];
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-timeout-cap",
      sessionId: "turn-timeout-cap",
      sliceId: AGENT_CONTINUE_MAX_SLICES,
      state: "awaiting_resume",
      piMessages,
      resumeReason: "timeout",
    });

    const replyPromise = executeAgentRun({
      input: { messageText: "help me" },
      routing: {
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        requester: TEST_REQUESTER,
        correlation: {
          conversationId: "conversation-timeout-cap",
          turnId: "turn-timeout-cap",
          channelId: "C123",
          threadTs: "1712345.0006",
        },
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await replyPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("text");
    expect(error.message).toContain("slice limit");

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-timeout-cap",
      "turn-timeout-cap",
    );
    expect(sessionRecord).toMatchObject({
      state: "failed",
      resumeReason: "timeout",
      sliceId: AGENT_CONTINUE_MAX_SLICES,
      errorMessage: expect.stringContaining("slice limit"),
    });
  });

  it("records the effective request deadline timeout budget", async () => {
    const startedAtMs = Date.now();
    const replyPromise = executeAgentRun({
      input: { messageText: "help me" },
      routing: {
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        requester: TEST_REQUESTER,
        correlation: {
          conversationId: "conversation-short-deadline",
          turnId: "turn-short-deadline",
          channelId: "C123",
          threadTs: "1712345.0005",
        },
      },
      policy: { turnDeadlineAtMs: startedAtMs + 2_500 },
    });

    await vi.advanceTimersByTimeAsync(2_500);
    const outcome = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(outcome.status).toBe("suspended");
    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-short-deadline",
      "turn-short-deadline",
    );
    expect(sessionRecord?.errorMessage).toBe(
      "Agent turn timed out after 2500ms",
    );
  });

  it("persists omitted-image context in the session-recorded Pi user message", async () => {
    const replyPromise = executeAgentRun({
      input: {
        messageText: "what is in this image?",
        omittedImageAttachmentCount: 1,
      },
      routing: {
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        requester: TEST_REQUESTER,
        correlation: {
          conversationId: "conversation-2",
          turnId: "turn-2",
          channelId: "C123",
          threadTs: "1712345.0002",
        },
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(10_000);
    await replyPromise;

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-2",
      "turn-2",
    );
    const userMessage = sessionRecord?.piMessages[0] as
      | {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        }
      | undefined;

    expect(userMessage?.role).toBe("user");
    expect(userMessage?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("<omitted-image-attachments>"),
        }),
      ]),
    );
  });

  it("persists agent continuation state when abort does not settle the agent run", async () => {
    promptMode.value = "hangsAfterAbort";
    const replyPromise = executeAgentRun({
      input: { messageText: "help me" },
      routing: {
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        requester: TEST_REQUESTER,
        correlation: {
          conversationId: "conversation-hung",
          turnId: "turn-hung",
          channelId: "C123",
          threadTs: "1712345.0003",
        },
      },
    });

    await waitForPromptCall(1);
    await realSleep(10);
    await vi.advanceTimersByTimeAsync(15_000);
    const outcome = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(outcome).toMatchObject({
      status: "suspended",
      resumeVersion: expect.any(Number),
    });

    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-hung",
      "turn-hung",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      sliceId: 2,
    });
    expect(sessionRecord?.piMessages).toEqual([
      expect.objectContaining({
        role: "user",
      }),
    ]);
  });

  it("uses one wall-clock timeout budget across provider retries", async () => {
    promptMode.value = "providerRetryThenHangs";
    const replyPromise = executeAgentRun({
      input: { messageText: "help me" },
      routing: {
        destination: TEST_DESTINATION,
        source: TEST_SOURCE,
        requester: TEST_REQUESTER,
        correlation: {
          conversationId: "conversation-retry",
          turnId: "turn-retry",
          channelId: "C123",
          threadTs: "1712345.0004",
        },
      },
    });

    await waitForPromptCall(1);
    await vi.advanceTimersByTimeAsync(8_000);
    await waitForProviderPromptSettlement();
    await advanceUntilContinueCall(5_000);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(outcome.status).toBe("suspended");
    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-retry",
      "turn-retry",
    );
    expect(sessionRecord).toMatchObject({
      state: "awaiting_resume",
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      sliceId: 2,
    });
    expect(sessionRecord?.piMessages).toEqual([
      expect.objectContaining({
        role: "user",
      }),
    ]);
  });
});
