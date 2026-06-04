import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { agentMode, counters } = vi.hoisted(() => ({
  agentMode: {
    value: "providerRetry" as
      | "providerRetry"
      | "cooperativeYield"
      | "steering"
      | "steeringSteerThrows",
  },
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
    private prepareNextTurn?: () => Promise<unknown> | unknown;
    private steeringMessages: unknown[] = [];

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

    subscribe() {
      return () => undefined;
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
import { isCooperativeTurnYieldError } from "@/chat/runtime/turn";
import { getAwaitingTurnContinuationRequest } from "@/chat/services/timeout-resume";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import * as turnSessionState from "@/chat/state/turn-session";

describe("generateAssistantReply provider retry", () => {
  beforeEach(async () => {
    agentMode.value = "providerRetry";
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

    const sessionRecord = await turnSessionState.getAgentTurnSessionRecord(
      "conversation-1",
      "turn-1",
    );
    expect(sessionRecord?.state).toBe("completed");
    expect(sessionRecord?.piMessages.map((message) => message.role)).toEqual([
      "user",
      "toolResult",
      "assistant",
    ]);
  });

  it("persists and queues steering messages at the next Pi boundary", async () => {
    agentMode.value = "steering";
    const injectedTexts: string[] = [];

    const reply = await generateAssistantReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-steering",
        turnId: "turn-steering",
        channelId: "C123",
        threadTs: "1712345.0001",
      },
      drainSteeringMessages: async (inject) => {
        const messages = [
          { text: "actually do the other thing", timestampMs: 2_000 },
        ];
        await inject(messages);
        injectedTexts.push(...messages.map((message) => message.text));
        return messages;
      },
    });

    expect(reply.text).toBe("Steered.");
    expect(injectedTexts).toEqual(["actually do the other thing"]);

    const sessionRecord = await turnSessionState.getAgentTurnSessionRecord(
      "conversation-steering",
      "turn-steering",
    );
    const serializedMessages = JSON.stringify(sessionRecord?.piMessages);
    expect(serializedMessages).toContain("help me");
    expect(serializedMessages).toContain("actually do the other thing");
  });

  it("parks the turn when the worker asks to yield at a Pi boundary", async () => {
    agentMode.value = "cooperativeYield";

    const error = await generateAssistantReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-yield",
        turnId: "turn-yield",
        channelId: "C123",
        threadTs: "1712345.0003",
      },
      shouldYield: () => true,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(isCooperativeTurnYieldError(error)).toBe(true);
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
      getAwaitingTurnContinuationRequest({
        conversationId: "conversation-yield",
        sessionId: "turn-yield",
      }),
    ).resolves.toMatchObject({
      conversationId: "conversation-yield",
      sessionId: "turn-yield",
      expectedVersion: sessionRecord?.version,
    });
  });

  it("keeps steered messages when yielding after steering drain", async () => {
    agentMode.value = "cooperativeYield";

    const error = await generateAssistantReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-yield-steering",
        turnId: "turn-yield-steering",
        channelId: "C123",
        threadTs: "1712345.0005",
      },
      drainSteeringMessages: async (inject) => {
        const messages = [
          { text: "actually do the other thing", timestampMs: 2_000 },
        ];
        await inject(messages);
        return messages;
      },
      shouldYield: () => true,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(isCooperativeTurnYieldError(error)).toBe(true);
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

    const error = await generateAssistantReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-yield-persist-failure",
        turnId: "turn-yield-persist-failure",
        channelId: "C123",
        threadTs: "1712345.0004",
      },
      shouldYield: () => true,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    upsertSpy.mockRestore();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Failed to persist cooperative yield continuation",
    );
    expect(isCooperativeTurnYieldError(error)).toBe(false);
    await expect(
      turnSessionState.getAgentTurnSessionRecord(
        "conversation-yield-persist-failure",
        "turn-yield-persist-failure",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects steering injection when Pi steer fails", async () => {
    agentMode.value = "steeringSteerThrows";
    let injectRejected = false;
    let injectCompleted = false;

    await generateAssistantReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-steering-failure",
        turnId: "turn-steering-failure",
        channelId: "C123",
        threadTs: "1712345.0002",
      },
      drainSteeringMessages: async (inject) => {
        const messages = [
          { text: "actually do the other thing", timestampMs: 2_000 },
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
    });

    expect(injectRejected).toBe(true);
    expect(injectCompleted).toBe(false);
  });
});
