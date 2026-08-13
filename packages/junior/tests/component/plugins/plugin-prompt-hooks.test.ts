import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createLocalSource, type Destination } from "@sentry/junior-plugin-api";

const originalStateAdapter = process.env.JUNIOR_STATE_ADAPTER;
process.env.JUNIOR_STATE_ADAPTER = "memory";

const { captured } = vi.hoisted(() => ({
  captured: {
    promptContextMessages: [] as unknown[],
    promptMessages: [] as unknown[],
    steeredMessages: [] as unknown[],
    systemPrompt: "",
    userPromptTexts: [] as string[],
  },
}));

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
    private prepareNextTurn?: (context?: unknown) => Promise<unknown> | unknown;

    constructor(input: {
      prepareNextTurn?: () => Promise<unknown> | unknown;
      prepareNextTurnWithContext?: (
        context: unknown,
      ) => Promise<unknown> | unknown;
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
      this.prepareNextTurn =
        input.prepareNextTurnWithContext ?? input.prepareNextTurn;
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
      captured.promptContextMessages.push([...this.state.messages]);
      captured.promptMessages.push(message);
      this.state.messages.push(message);
      await this.prepareNextTurn?.({
        context: { messages: this.state.messages },
      });
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

  return { ...actual, Agent: MockAgent };
});

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

import {
  defineJuniorPlugin,
  definePromptContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { executeAgentRun } from "@/chat/agent";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { upsertTurnRecord } from "@/chat/task-execution/turn-cursor";
import { getConversationEventStore } from "@/chat/db";
import { TurnInputCommitLostError } from "@/chat/runtime/turn";

const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:test:plugin-prompt-hooks",
} satisfies Destination;
const LOCAL_SOURCE = createLocalSource(LOCAL_DESTINATION.conversationId);

describe("plugin prompt hook composition", () => {
  let previousPlugins: ReturnType<typeof setPlugins>;

  beforeEach(() => {
    captured.promptContextMessages = [];
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
    await executeAgentRun({
  conversationId: LOCAL_DESTINATION.conversationId,
  turnId: "turn-plugin-prompt-hooks",
  instruction:   {
  text: "hello",
  },
  destination: LOCAL_DESTINATION,
  source: LOCAL_SOURCE,
});

    expect(JSON.stringify(captured.promptContextMessages[0])).toContain(
      "User memory guidance for hello.",
    );
    expect(JSON.stringify(captured.promptMessages[0])).toContain(
      "<current-instruction>\\nhello\\n</current-instruction>",
    );
    expect(JSON.stringify(captured.promptMessages[0])).not.toContain(
      "User memory guidance for hello.",
    );
  });

  it("persists structured context used by the prompt", async () => {
    const recall = definePromptContext({
      kind: "recall",
      version: 1,
      schema: z.object({
        memories: z.array(z.object({ id: z.string(), content: z.string() })),
      }),
      renderPrompt: ({ memories }) => memories[0]!.content,
    });
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "memory",
          displayName: "Memory",
          description: "Memory test plugin",
        },
        hooks: {
          userPrompt() {
            return [
              recall({
                memories: [{ id: "memory-1", content: "Use pnpm." }],
              }),
            ];
          },
        },
      }),
    ]);

    const turnId = "turn-plugin-structured-context";
    await executeAgentRun({
      conversationId: LOCAL_DESTINATION.conversationId,
      turnId,
      instruction: { text: "hello" },
      destination: LOCAL_DESTINATION,
      source: LOCAL_SOURCE,
    });

    expect(JSON.stringify(captured.promptContextMessages[0])).toContain(
      "Use pnpm.",
    );
    const stored = await getConversationEventStore().loadByIdempotencyKey(
      LOCAL_DESTINATION.conversationId,
      `turn:${turnId}:context:memory:0`,
    );
    expect(stored?.data).toEqual({
      type: "turn_context",
      turnId,
      pluginName: "memory",
      kind: "recall",
      version: 1,
      content: {
        memories: [{ id: "memory-1", content: "Use pnpm." }],
      },
    });
    const history = await getConversationEventStore().loadCurrentHistory(
      LOCAL_DESTINATION.conversationId,
    );
    expect(
      JSON.stringify(
        history.filter((event) =>
          ["user_message", "assistant_message", "tool_result"].includes(
            event.data.type,
          ),
        ),
      ),
    ).not.toContain("Use pnpm.");
  });

  it("replays checkpointed structured context after input acknowledgement fails", async () => {
    const recall = definePromptContext({
      kind: "recall",
      version: 1,
      schema: z.object({
        memories: z.array(z.object({ id: z.string(), content: z.string() })),
      }),
      renderPrompt: ({ memories }) => memories[0]!.content,
    });
    let recallCount = 0;
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "memory",
          displayName: "Memory",
          description: "Memory test plugin",
        },
        hooks: {
          userPrompt() {
            recallCount += 1;
            return [
              recall({
                memories: [
                  {
                    id: `memory-${recallCount}`,
                    content: `Use pnpm snapshot ${recallCount}.`,
                  },
                ],
              }),
            ];
          },
        },
      }),
    ]);

    const turnId = "turn-plugin-context-input-redelivery";
    const request = {
      conversationId: LOCAL_DESTINATION.conversationId,
      turnId,
      instruction: { text: "hello" },
      destination: LOCAL_DESTINATION,
      source: LOCAL_SOURCE,
    };
    await expect(
      executeAgentRun({
        ...request,
        durability: {
          onInputCommitted() {
            throw new TurnInputCommitLostError();
          },
        },
      }),
    ).rejects.toBeInstanceOf(TurnInputCommitLostError);

    await executeAgentRun(request);

    expect(recallCount).toBe(1);
    expect(JSON.stringify(captured.promptContextMessages[0])).toContain(
      "Use pnpm snapshot 1.",
    );
    expect(JSON.stringify(captured.promptContextMessages[0])).not.toContain(
      "Use pnpm snapshot 2.",
    );
    const stored = await getConversationEventStore().loadByIdempotencyKey(
      LOCAL_DESTINATION.conversationId,
      `turn:${turnId}:context:memory:0`,
    );
    expect(stored?.data).toMatchObject({
      type: "turn_context",
      content: {
        memories: [{ id: "memory-1", content: "Use pnpm snapshot 1." }],
      },
    });
  });

  it("runs user prompt hooks for non-bootstrap follow-up prompts", async () => {
    await executeAgentRun({
  conversationId: LOCAL_DESTINATION.conversationId,
  turnId: "turn-plugin-prompt-follow-up-1",
  instruction:   {
  text: "hello",
  },
  destination: LOCAL_DESTINATION,
  source: LOCAL_SOURCE,
});
    const firstPromptMessage = captured.promptMessages[0];
    captured.promptContextMessages = [];
    captured.promptMessages = [];

    await executeAgentRun({
  conversationId: LOCAL_DESTINATION.conversationId,
  turnId: "turn-plugin-prompt-follow-up-2",
  instruction:   {
  text: "again",
  },
  history:   [
            firstPromptMessage,
            {
              role: "assistant",
              content: [{ type: "text", text: "Done." }],
              stopReason: "stop",
            },
          ] as never,
  destination: LOCAL_DESTINATION,
  source: LOCAL_SOURCE,
});

    expect(captured.userPromptTexts).toEqual(["hello", "again"]);
    expect(JSON.stringify(captured.promptContextMessages[0])).toContain(
      "User memory guidance for again.",
    );
  });

  it("does not run user prompt hooks for steering messages", async () => {
    await executeAgentRun({
  conversationId: LOCAL_DESTINATION.conversationId,
  turnId: "turn-plugin-prompt-steering",
  instruction:   {
  text: "hello",
  },
  destination: LOCAL_DESTINATION,
  source: LOCAL_SOURCE,
  durability:   {
          drainSteeringMessages: async (inject) => {
            await inject([
              { text: "steer me", provenance: { authority: "instruction" } },
            ]);
            return [];
          },
        },
});

    expect(captured.userPromptTexts).toEqual(["hello"]);
    expect(JSON.stringify(captured.steeredMessages[0])).not.toContain(
      "User memory guidance",
    );
    expect(JSON.stringify(captured.steeredMessages[0])).toContain(
      "<current-instruction>\\nsteer me\\n</current-instruction>",
    );
  });

  it("runs user prompt hooks when a resumed record has no prompt checkpoint", async () => {
    await upsertTurnRecord({
      conversationId: LOCAL_DESTINATION.conversationId,
      turnId: "turn-plugin-prompt-resume-before-prompt",
      sliceId: 1,
      state: "paused",
      piMessages: [],
      resumeReason: "auth",
      errorMessage: "authorization required",
    });

    await executeAgentRun({
  conversationId: LOCAL_DESTINATION.conversationId,
  turnId: "turn-plugin-prompt-resume-before-prompt",
  instruction:   {
  text: "resume me",
  },
  destination: LOCAL_DESTINATION,
  source: LOCAL_SOURCE,
});

    expect(captured.userPromptTexts).toEqual(["resume me"]);
    expect(JSON.stringify(captured.promptContextMessages[0])).toContain(
      "User memory guidance for resume me.",
    );
  });

  it("does not run user prompt hooks when a resumed record has a prompt checkpoint", async () => {
    await upsertTurnRecord({
      conversationId: LOCAL_DESTINATION.conversationId,
      turnId: "turn-plugin-prompt-resume-after-prompt",
      sliceId: 1,
      state: "paused",
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

    await executeAgentRun({
  conversationId: LOCAL_DESTINATION.conversationId,
  turnId: "turn-plugin-prompt-resume-after-prompt",
  instruction:   {
  text: "resume me",
  },
  destination: LOCAL_DESTINATION,
  source: LOCAL_SOURCE,
});

    expect(captured.userPromptTexts).toEqual([]);
    expect(captured.promptContextMessages).toEqual([]);
    expect(captured.promptMessages).toEqual([]);
  });
});
