import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Destination } from "@sentry/junior-plugin-api";

const originalStateAdapter = process.env.JUNIOR_STATE_ADAPTER;
process.env.JUNIOR_STATE_ADAPTER = "memory";

const { captured } = vi.hoisted(() => ({
  captured: {
    isFirstPromptValues: [] as boolean[],
    promptMessages: [] as unknown[],
    steeredMessages: [] as unknown[],
    systemPrompt: "",
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

    constructor(input: {
      prepareNextTurn?: () => Promise<unknown> | unknown;
      initialState: {
        model: unknown;
        systemPrompt: string;
        tools: unknown[];
      };
    }) {
      captured.systemPrompt = input.initialState.systemPrompt;
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

    abort() {}

    async continue() {
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Continued." }],
        stopReason: "stop",
      });
      return {};
    }

    async prompt(message: unknown) {
      captured.promptMessages.push(message);
      this.state.messages.push(message);
      await this.prepareNextTurn?.();
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
      });
      return {};
    }

    steer(message: unknown) {
      captured.steeredMessages.push(message);
      this.state.messages.push(message);
    }
  }

  return { Agent: MockAgent };
});

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

import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { generateAssistantReply } from "@/chat/respond";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { loadPluginSessionState } from "@/chat/state/session-log";

const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:test:plugin-prompt-hooks",
} satisfies Destination;

describe("plugin prompt hooks", () => {
  let previousPlugins: ReturnType<typeof setPlugins>;

  beforeEach(() => {
    captured.isFirstPromptValues = [];
    captured.promptMessages = [];
    captured.steeredMessages = [];
    captured.systemPrompt = "";
    previousPlugins = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "memory",
          displayName: "Memory",
          description: "Memory test plugin",
        },
        hooks: {
          systemPrompt() {
            return [{ id: "memory-system", text: "System memory guidance." }];
          },
          async userPrompt(ctx) {
            captured.isFirstPromptValues.push(ctx.isFirstPrompt);
            const prior = await ctx.session.list("injected_memories");
            return {
              contributions: [
                {
                  id: "memory-user",
                  text: `User memory guidance; prior=${prior.length}.`,
                },
              ],
              sessionState: [
                {
                  key: "injected_memories",
                  value: { memoryIds: ["mem_1"] },
                },
              ],
            };
          },
        },
      }),
    ]);
  });

  afterEach(async () => {
    setPlugins(previousPlugins);
    await disconnectStateAdapter();
  });

  afterAll(() => {
    if (originalStateAdapter === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = originalStateAdapter;
    }
  });

  it("renders prompt contributions and commits matching plugin session state", async () => {
    await generateAssistantReply("hello", {
      destination: LOCAL_DESTINATION,
      correlation: {
        conversationId: "conversation-plugin-prompt-hooks",
        turnId: "turn-plugin-prompt-hooks",
      },
    });

    expect(captured.systemPrompt).toContain("System memory guidance.");
    expect(JSON.stringify(captured.promptMessages[0])).toContain(
      "User memory guidance; prior=0.",
    );
    await expect(
      loadPluginSessionState({
        conversationId: "conversation-plugin-prompt-hooks",
        plugin: "memory",
        key: "injected_memories",
      }),
    ).resolves.toEqual([
      {
        createdAtMs: expect.any(Number),
        value: { memoryIds: ["mem_1"] },
      },
    ]);
  });

  it("runs user prompt hooks for non-bootstrap follow-up prompts", async () => {
    await generateAssistantReply("hello", {
      destination: LOCAL_DESTINATION,
      correlation: {
        conversationId: "conversation-plugin-prompt-follow-up",
        turnId: "turn-plugin-prompt-follow-up-1",
      },
    });
    const firstPromptMessage = captured.promptMessages[0];
    captured.promptMessages = [];

    await generateAssistantReply("again", {
      destination: LOCAL_DESTINATION,
      correlation: {
        conversationId: "conversation-plugin-prompt-follow-up",
        turnId: "turn-plugin-prompt-follow-up-2",
      },
      piMessages: [
        firstPromptMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stopReason: "stop",
        },
      ] as never,
    });

    expect(captured.isFirstPromptValues).toEqual([true, false]);
    expect(JSON.stringify(captured.promptMessages[0])).toContain(
      "User memory guidance; prior=1.",
    );
  });

  it("runs user prompt hooks for steering messages", async () => {
    await generateAssistantReply("hello", {
      destination: LOCAL_DESTINATION,
      correlation: {
        conversationId: "conversation-plugin-prompt-steering",
        turnId: "turn-plugin-prompt-steering",
      },
      drainSteeringMessages: async (inject) => {
        await inject([{ text: "steer me" }]);
        return [];
      },
    });

    expect(JSON.stringify(captured.steeredMessages[0])).toContain(
      "User memory guidance; prior=1.",
    );
    await expect(
      loadPluginSessionState({
        conversationId: "conversation-plugin-prompt-steering",
        plugin: "memory",
        key: "injected_memories",
      }),
    ).resolves.toEqual([
      {
        createdAtMs: expect.any(Number),
        value: { memoryIds: ["mem_1"] },
      },
      {
        createdAtMs: expect.any(Number),
        value: { memoryIds: ["mem_1"] },
      },
    ]);
  });
});
