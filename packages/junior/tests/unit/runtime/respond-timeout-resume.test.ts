import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { promptAborted } = vi.hoisted(() => ({
  promptAborted: { value: false },
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
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "continued" }],
        stopReason: "stop",
      });
      return {};
    }

    async prompt(message: unknown) {
      this.state.messages.push(message);
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
import { isRetryableTurnError } from "@/chat/runtime/turn";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getAgentTurnSessionRecord } from "@/chat/state/turn-session";

describe("generateAssistantReply timeout resume", () => {
  beforeEach(async () => {
    promptAborted.value = false;
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
  });

  it("stores the last safe boundary and throws a retryable timeout error", async () => {
    const replyPromise = generateAssistantReply("help me", {
      requester: { userId: "U123" },
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
    expect(isRetryableTurnError(error, "turn_timeout_resume")).toBe(true);
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

  it("persists omitted-image context in the session-recorded Pi user message", async () => {
    const replyPromise = generateAssistantReply("what is in this image?", {
      requester: { userId: "U123" },
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
});
