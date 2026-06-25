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
    promptMessages: [] as unknown[],
    steeredMessages: [] as unknown[],
    systemPrompt: "",
    userPromptTexts: [] as string[],
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
  getPiGatewayApiKey: () => "test-gateway-key",
  resolveGatewayModel: (modelId: string) => modelId,
}));

import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { generateAssistantReply } from "@/chat/respond";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";

const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:test:plugin-prompt-hooks",
} satisfies Destination;

describe("plugin prompt hooks", () => {
  let previousPlugins: ReturnType<typeof setPlugins>;

  beforeEach(() => {
    captured.promptMessages = [];
    captured.steeredMessages = [];
    captured.systemPrompt = "";
    captured.userPromptTexts = [];
    previousPlugins = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "memory",
          displayName: "Memory",
          description: "Memory test plugin",
        },
        hooks: {
          systemPrompt() {
            return [{ text: "System memory guidance." }];
          },
          async userPrompt(ctx) {
            captured.userPromptTexts.push(ctx.text);
            return [
              {
                text: `User memory guidance for ${ctx.text}.`,
              },
            ];
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

  it("renders prompt messages from plugin hooks", async () => {
    await generateAssistantReply("hello", {
      destination: LOCAL_DESTINATION,
      correlation: {
        conversationId: "conversation-plugin-prompt-hooks",
        turnId: "turn-plugin-prompt-hooks",
      },
    });

    expect(captured.systemPrompt).toContain("System memory guidance.");
    expect(JSON.stringify(captured.promptMessages[0])).toContain(
      "User memory guidance for hello.",
    );
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

    expect(captured.userPromptTexts).toEqual(["hello", "again"]);
    expect(JSON.stringify(captured.promptMessages[0])).toContain(
      "User memory guidance for again.",
    );
  });

  it("does not run user prompt hooks for steering messages", async () => {
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

    expect(captured.userPromptTexts).toEqual(["hello"]);
    expect(JSON.stringify(captured.steeredMessages[0])).not.toContain(
      "User memory guidance",
    );
  });

  it("runs user prompt hooks when a resumed record has no prompt checkpoint", async () => {
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-plugin-prompt-resume-before-prompt",
      sessionId: "turn-plugin-prompt-resume-before-prompt",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: [],
      resumeReason: "auth",
      errorMessage: "authorization required",
    });

    await generateAssistantReply("resume me", {
      destination: LOCAL_DESTINATION,
      correlation: {
        conversationId: "conversation-plugin-prompt-resume-before-prompt",
        turnId: "turn-plugin-prompt-resume-before-prompt",
      },
    });

    expect(captured.userPromptTexts).toEqual(["resume me"]);
    expect(JSON.stringify(captured.promptMessages[0])).toContain(
      "User memory guidance for resume me.",
    );
  });

  it("does not run user prompt hooks when a resumed record has a prompt checkpoint", async () => {
    await upsertAgentTurnSessionRecord({
      conversationId: "conversation-plugin-prompt-resume-after-prompt",
      sessionId: "turn-plugin-prompt-resume-after-prompt",
      sliceId: 1,
      state: "awaiting_resume",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "checkpointed prompt" }],
          timestamp: Date.now(),
        },
      ] as never,
      turnStartMessageIndex: 0,
      resumeReason: "timeout",
      errorMessage: "timed out",
    });

    await generateAssistantReply("resume me", {
      destination: LOCAL_DESTINATION,
      correlation: {
        conversationId: "conversation-plugin-prompt-resume-after-prompt",
        turnId: "turn-plugin-prompt-resume-after-prompt",
      },
    });

    expect(captured.userPromptTexts).toEqual([]);
    expect(captured.promptMessages).toEqual([]);
  });
});
