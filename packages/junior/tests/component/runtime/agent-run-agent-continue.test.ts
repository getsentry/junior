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

// Matches packages/junior/src/chat/services/provider-retry.ts first backoff.
const PROVIDER_RETRY_FIRST_DELAY_MS = 2_000;

function hasScheduledTimeout(
  setTimeoutSpy: { mock: { calls: unknown[][] } },
  delayMs: number,
): boolean {
  return setTimeoutSpy.mock.calls.some((call) => call[1] === delayMs);
}

/** Wait until production schedules a setTimeout with the given delay. */
async function waitForScheduledTimeout(
  setTimeoutSpy: { mock: { calls: unknown[][] } },
  delayMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (hasScheduledTimeout(setTimeoutSpy, delayMs)) {
      return;
    }
    await realSleep(5);
  }
  throw new Error(`Expected setTimeout(${delayMs}) to be scheduled`);
}

async function waitForContinueCall(): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (continueCalls.value > 0) {
      return;
    }
    await realSleep(5);
  }
  throw new Error("Expected provider retry continuation to start");
}

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
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
import { botConfig } from "@/chat/config";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";

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

const TEST_ACTOR = {
  platform: "slack",
  teamId: "T123",
  userId: "U123",
} as const;

describe("paused turn composition", () => {
  beforeEach(async () => {
    promptAborted.value = false;
    continueCalls.value = 0;
    promptCalls.value = 0;
    promptMode.value = "settlesAfterAbort";
    promptSettled.value = false;
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
  });

  it("stores the last safe boundary and returns a timed-out outcome", async () => {
    const replyPromise = executeAgentRun({
  conversationId: "conversation-1",
  turnId: "turn-1",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: TEST_ACTOR,
});

    await waitForPromptCall(1);
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(outcome).toMatchObject({
      status: "suspended",
      resumeVersion: expect.any(Number),
    });

    const sessionRecord = await getTurnRecord("conversation-1", "turn-1");
    expect(sessionRecord).toMatchObject({
      state: "paused",
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      sliceId: 2,
    });
    expect(sessionRecord?.piMessages).toEqual([
      expect.objectContaining({
        role: "user",
      }),
      expect.objectContaining({
        role: "user",
      }),
    ]);
  });

  it("throws terminal timeout failures instead of returning an error reply after the execution limit", async () => {
    promptMode.value = "continueSettlesAfterAbort";
    const piMessages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "keep trying" }],
        timestamp: 1,
      } as PiMessage,
    ];
    await upsertTurnRecord({
      conversationId: "conversation-timeout-cap",
      turnId: "turn-timeout-cap",
      sliceId: botConfig.maxSlicesPerTurn,
      state: "paused",
      piMessages,
      resumeReason: "timeout",
    });

    const replyPromise = executeAgentRun({
  conversationId: "conversation-timeout-cap",
  turnId: "turn-timeout-cap",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: TEST_ACTOR,
}).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await replyPromise;

    const { TurnSliceLimitExceededError } =
      await import("@/chat/services/turn-limit");
    expect(error).toBeInstanceOf(TurnSliceLimitExceededError);
    expect(error).not.toHaveProperty("text");
    expect(error.message).toContain("execution limit");

    const sessionRecord = await getTurnRecord(
      "conversation-timeout-cap",
      "turn-timeout-cap",
    );
    expect(sessionRecord).toMatchObject({
      state: "failed",
      resumeReason: "timeout",
      sliceId: botConfig.maxSlicesPerTurn,
      errorMessage: expect.stringContaining("execution limit"),
    });
  });

  it("records the effective request deadline timeout budget", async () => {
    const startedAtMs = Date.now();
    const replyPromise = executeAgentRun({
  conversationId: "conversation-short-deadline",
  turnId: "turn-short-deadline",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: TEST_ACTOR,
  deadlineAtMs: startedAtMs + 2_500,
});

    await waitForPromptCall(1);
    await vi.advanceTimersByTimeAsync(2_500);
    const outcome = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(outcome.status).toBe("suspended");
    const sessionRecord = await getTurnRecord(
      "conversation-short-deadline",
      "turn-short-deadline",
    );
    expect(sessionRecord?.errorMessage).toBe(
      "Agent turn timed out after 2500ms",
    );
  });

  it("persists omitted-image context in the session-recorded Pi user message", async () => {
    const replyPromise = executeAgentRun({
  conversationId: "conversation-2",
  turnId: "turn-2",
  instruction:   {
  text: "what is in this image?",
  omittedImageAttachmentCount: 1,
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: TEST_ACTOR,
}).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(10_000);
    await replyPromise;

    const sessionRecord = await getTurnRecord("conversation-2", "turn-2");
    const userMessage = sessionRecord?.piMessages.find((message) =>
      JSON.stringify(message).includes("<omitted-image-attachments>"),
    ) as
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

  it("persists paused turn state when abort does not settle the agent run", async () => {
    promptMode.value = "hangsAfterAbort";
    const replyPromise = executeAgentRun({
  conversationId: "conversation-hung",
  turnId: "turn-hung",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: TEST_ACTOR,
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

    const sessionRecord = await getTurnRecord("conversation-hung", "turn-hung");
    expect(sessionRecord).toMatchObject({
      state: "paused",
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      sliceId: 2,
    });
    expect(sessionRecord?.piMessages).toEqual([
      expect.objectContaining({
        role: "user",
      }),
      expect.objectContaining({
        role: "user",
      }),
    ]);
  });

  it("uses one wall-clock timeout budget across provider retries", async () => {
    promptMode.value = "providerRetryThenHangs";
    const replyPromise = executeAgentRun({
  conversationId: "conversation-retry",
  turnId: "turn-retry",
  instruction:   {
  text: "help me",
  },
  destinationVisibility: "private",
  destination: TEST_DESTINATION,
  source: TEST_SOURCE,
  actor: TEST_ACTOR,
});

    await waitForPromptCall(1);
    // Spy before settlement so a fast event loop cannot schedule the retry
    // backoff between settlement and the wait below.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await vi.advanceTimersByTimeAsync(8_000);
      await waitForProviderPromptSettlement();
      // Provider retry sleep is scheduled only after settlement + safe-boundary
      // persistence. Wait for that timer before advancing fake time so a slow
      // event loop under coverage workers cannot burn the advance budget first.
      await waitForScheduledTimeout(
        setTimeoutSpy,
        PROVIDER_RETRY_FIRST_DELAY_MS,
      );
      await vi.advanceTimersByTimeAsync(PROVIDER_RETRY_FIRST_DELAY_MS);
      await waitForContinueCall();
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      setTimeoutSpy.mockRestore();
    }
    const outcome = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(outcome.status).toBe("suspended");
    const sessionRecord = await getTurnRecord(
      "conversation-retry",
      "turn-retry",
    );
    expect(sessionRecord).toMatchObject({
      state: "paused",
      resumeReason: "timeout",
      resumedFromSliceId: 1,
      sliceId: 2,
    });
    expect(sessionRecord?.piMessages).toEqual([
      expect.objectContaining({
        role: "user",
      }),
      expect.objectContaining({
        role: "user",
      }),
    ]);
  }, 15_000);
});
