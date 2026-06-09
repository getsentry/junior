import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";

const { promptAborted, promptMode } = vi.hoisted(() => ({
  promptAborted: { value: false },
  promptMode: {
    value: "settlesAfterAbort" as
      | "settlesAfterAbort"
      | "hangsAfterAbort"
      | "continueSettlesAfterAbort"
      | "providerRetryThenHangs",
  },
}));

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
      this.state.messages.push(message);
      if (promptMode.value === "providerRetryThenHangs") {
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "provider error" }],
          stopReason: "error",
          errorMessage: "Provider returned error: 503 service unavailable",
        });
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
  getPiGatewayApiKeyOverride: () => "test-gateway-key",
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

vi.mock("@/chat/plugins/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/plugins/registry")>()),
  getPluginMcpProviders: () => [],
  getPluginProviders: () => [],
}));

vi.mock("@/chat/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/skills")>()),
  discoverSkills: async () => [],
  findSkillByName: () => null,
  parseSkillInvocation: () => null,
}));

import { generateAssistantReply } from "@/chat/respond";
import {
  isRetryableTurnError,
  isTurnInputCommitLostError,
} from "@/chat/runtime/turn";
import { AGENT_CONTINUE_MAX_SLICES } from "@/chat/services/turn-session-record";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";

describe("generateAssistantReply agent continuation", () => {
  beforeEach(async () => {
    promptAborted.value = false;
    promptMode.value = "settlesAfterAbort";
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
  });

  it("rejects durable input when no prompt checkpoint can be persisted", async () => {
    const onInputCommitted = vi.fn();

    const error = await generateAssistantReply("help me", {
      onInputCommitted,
    }).catch((caught) => caught);

    expect(isTurnInputCommitLostError(error)).toBe(true);
    expect(onInputCommitted).not.toHaveBeenCalled();
  });

  it("stores the last safe boundary and throws a retryable timeout error", async () => {
    const replyPromise = generateAssistantReply("help me", {
      requester: { platform: "slack", teamId: "T123", userId: "U123" },
      correlation: {
        conversationId: "conversation-1",
        turnId: "turn-1",
        channelId: "C123",
        threadTs: "1712345.0001",
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(isRetryableTurnError(error, "agent_continue")).toBe(true);
    expect(error.metadata).toMatchObject({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      version: expect.any(Number),
      sliceId: 2,
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

    const replyPromise = generateAssistantReply("help me", {
      requester: { platform: "slack", teamId: "T123", userId: "U123" },
      correlation: {
        conversationId: "conversation-timeout-cap",
        turnId: "turn-timeout-cap",
        channelId: "C123",
        threadTs: "1712345.0006",
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await replyPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("text");
    expect(isRetryableTurnError(error, "agent_continue")).toBe(false);
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
    const replyPromise = generateAssistantReply("help me", {
      requester: { platform: "slack", teamId: "T123", userId: "U123" },
      turnDeadlineAtMs: startedAtMs + 2_500,
      correlation: {
        conversationId: "conversation-short-deadline",
        turnId: "turn-short-deadline",
        channelId: "C123",
        threadTs: "1712345.0005",
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(2_500);
    const error = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(isRetryableTurnError(error, "agent_continue")).toBe(true);
    const sessionRecord = await getAgentTurnSessionRecord(
      "conversation-short-deadline",
      "turn-short-deadline",
    );
    expect(sessionRecord?.errorMessage).toBe(
      "Agent turn timed out after 2500ms",
    );
  });

  it("persists omitted-image context in the session-recorded Pi user message", async () => {
    const replyPromise = generateAssistantReply("what is in this image?", {
      requester: { platform: "slack", teamId: "T123", userId: "U123" },
      omittedImageAttachmentCount: 1,
      correlation: {
        conversationId: "conversation-2",
        turnId: "turn-2",
        channelId: "C123",
        threadTs: "1712345.0002",
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
    const replyPromise = generateAssistantReply("help me", {
      requester: { platform: "slack", teamId: "T123", userId: "U123" },
      correlation: {
        conversationId: "conversation-hung",
        turnId: "turn-hung",
        channelId: "C123",
        threadTs: "1712345.0003",
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(15_000);
    const error = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(isRetryableTurnError(error, "agent_continue")).toBe(true);
    expect(error.metadata).toMatchObject({
      conversationId: "conversation-hung",
      sessionId: "turn-hung",
      version: expect.any(Number),
      sliceId: 2,
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
    const replyPromise = generateAssistantReply("help me", {
      requester: { platform: "slack", teamId: "T123", userId: "U123" },
      correlation: {
        conversationId: "conversation-retry",
        turnId: "turn-retry",
        channelId: "C123",
        threadTs: "1712345.0004",
      },
    }).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await replyPromise;

    expect(promptAborted.value).toBe(true);
    expect(isRetryableTurnError(error, "agent_continue")).toBe(true);
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
