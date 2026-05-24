import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { counters } = vi.hoisted(() => ({
  counters: {
    continueCalls: 0,
    promptCalls: 0,
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
      return undefined;
    }

    async prompt(message: unknown) {
      counters.promptCalls += 1;
      this.state.messages.push(message);
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
  }),
}));

vi.mock("@/chat/capabilities/jr-rpc-command", () => ({
  maybeExecuteJrRpcCustomCommand: async () => ({ handled: false }),
}));

vi.mock("@/chat/pi/client", () => ({
  GEN_AI_PROVIDER_NAME: "vercel-ai-gateway",
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
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getAgentTurnSessionCheckpoint } from "@/chat/state/turn-session-store";

describe("generateAssistantReply provider retry", () => {
  beforeEach(async () => {
    counters.continueCalls = 0;
    counters.promptCalls = 0;
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
    const replyPromise = generateAssistantReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-1",
        turnId: "turn-1",
        channelId: "C123",
        threadTs: "1712345.0001",
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const reply = await replyPromise;

    expect(reply.text).toBe("Recovered.");
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.toolResultCount).toBe(1);
    expect(reply.diagnostics.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(counters.promptCalls).toBe(1);
    expect(counters.continueCalls).toBe(1);

    const checkpoint = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      "turn-1",
    );
    expect(checkpoint?.state).toBe("completed");
    expect(checkpoint?.piMessages.map((message) => message.role)).toEqual([
      "user",
      "toolResult",
      "assistant",
    ]);
  });
});
