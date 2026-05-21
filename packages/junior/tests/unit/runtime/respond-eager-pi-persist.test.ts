import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";

const { agentEvents } = vi.hoisted(() => ({
  agentEvents: {
    listeners: [] as Array<(event: unknown) => Promise<void> | void>,
  },
}));

vi.mock("@mariozechner/pi-agent-core", () => {
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

    subscribe(listener: (event: unknown) => Promise<void> | void) {
      agentEvents.listeners.push(listener);
      return () => {
        const index = agentEvents.listeners.indexOf(listener);
        if (index >= 0) agentEvents.listeners.splice(index, 1);
      };
    }

    abort() {}

    async replaceMessages(messages: unknown[]) {
      this.state.messages = [...messages];
    }

    async continue() {
      return {};
    }

    async prompt(message: PiMessage) {
      this.state.messages.push(message);
      const toolResultMessage = {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "echo",
        content: [{ type: "text", text: "ok" }],
        timestamp: 2,
      };
      const assistantMessage = {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "echo", arguments: {} },
        ],
        timestamp: 3,
      };
      this.state.messages.push(assistantMessage);
      this.state.messages.push(toolResultMessage);
      for (const listener of agentEvents.listeners) {
        await listener({
          type: "turn_end",
          message: assistantMessage,
          toolResults: [toolResultMessage],
        });
      }
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
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
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
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

describe("generateAssistantReply eager Pi message persistence", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    agentEvents.listeners.length = 0;
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
  });

  it("notifies onPiMessagesPersisted at each safe-boundary write so durable state can advance mid-turn", async () => {
    const persistedSnapshots: PiMessage[][] = [];
    await generateAssistantReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-1",
        turnId: "turn-1",
        channelId: "C123",
        threadTs: "1712345.0001",
      },
      onPiMessagesPersisted: (messages) => {
        persistedSnapshots.push(messages.map((m) => ({ ...m }) as PiMessage));
      },
    });

    // One snapshot from the pre-prompt safe-boundary write (durable history
    // captures the user prompt before any LLM call), one from `turn_end`.
    expect(persistedSnapshots.length).toBe(2);

    const finalSnapshot = persistedSnapshots[persistedSnapshots.length - 1];
    const lastMessage = finalSnapshot.at(-1) as { role?: unknown };
    expect(lastMessage?.role).toBe("toolResult");

    const userMessages = finalSnapshot.filter(
      (m) => (m as { role?: unknown }).role === "user",
    );
    expect(userMessages.length).toBeGreaterThan(0);
    for (const userMessage of userMessages) {
      const content = (userMessage as { content?: Array<{ text?: unknown }> })
        .content;
      const turnContextParts = (content ?? []).filter(
        (part) =>
          typeof part?.text === "string" &&
          part.text.startsWith("Turn context"),
      );
      expect(turnContextParts).toHaveLength(0);
    }
  });

  it("propagates onPiMessagesPersisted failures as turn errors", async () => {
    const reply = await generateAssistantReply("help me", {
      requester: { userId: "U123" },
      correlation: {
        conversationId: "conversation-2",
        turnId: "turn-2",
        channelId: "C123",
        threadTs: "1712345.0002",
      },
      onPiMessagesPersisted: () => {
        throw new Error("durable store offline");
      },
    });

    expect(reply.text).toContain("Error: durable store offline");
  });
});
