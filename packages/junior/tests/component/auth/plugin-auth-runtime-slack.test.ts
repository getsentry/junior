import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import {
  createTestMessage,
  createTestThread,
  type TestThread,
} from "../../fixtures/slack-harness";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../../fixtures/plugin-app";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";

vi.mock("@/chat/services/turn-router", async () => {
  const actual = await vi.importActual<
    typeof import("@/chat/services/turn-router")
  >("@/chat/services/turn-router");
  return {
    ...actual,
    selectTurnRoute: async () => ({
      profile: "standard" as const,
      reasoningLevel: "medium" as const,
      reason: "test_default",
    }),
  };
});

vi.mock("@/chat/sandbox/sandbox", async () => {
  const actual = await vi.importActual<typeof import("@/chat/sandbox/sandbox")>(
    "@/chat/sandbox/sandbox",
  );
  return {
    ...actual,
    createSandbox: () => ({
      captureRepositoryInstructions: async () => undefined,
      workspace: {
        readFileToBuffer: async () => {
          throw new Error(
            "sandbox should not be acquired for auth signal test",
          );
        },
        runCommand: async () => {
          throw new Error(
            "sandbox should not be acquired for auth signal test",
          );
        },
        writeFiles: async () => {
          throw new Error(
            "sandbox should not be acquired for auth signal test",
          );
        },
      },
      tools: {
        supports: (toolName: string) => toolName === "bash",
        execute: async () => {
          return {
            auth_required: {
              authorization: {
                provider: "eval-oauth",
                scope: "read",
                type: "oauth",
              },
              createdAtMs: 1,
              grant: {
                access: "read",
                name: "eval-oauth",
                reason: "read private data",
              },
              kind: "auth_required",
              provider: "eval-oauth",
            },
            command: "node needs-oauth.js",
            exit_code: 1,
            stderr: "auth required",
            stdout: "",
          };
        },
      },
      sandboxRef: () => undefined,
      close: vi.fn(),
    }),
  };
});

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  class FakeAgent {
    state: {
      messages: unknown[];
      model: unknown;
      systemPrompt: string;
      tools: Array<{
        name: string;
        execute: (toolCallId: unknown, params: unknown) => Promise<unknown>;
      }>;
    };

    constructor(input: {
      initialState: {
        model: unknown;
        systemPrompt: string;
        tools: Array<{
          name: string;
          execute: (toolCallId: unknown, params: unknown) => Promise<unknown>;
        }>;
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

    abort() {}

    async prompt(message: unknown) {
      this.state.messages.push(message);
      const bashTool = this.state.tools.find((tool) => tool.name === "bash");
      if (!bashTool) {
        throw new Error("bash tool missing");
      }
      await bashTool.execute("tool-plugin-auth", {
        command: "node needs-oauth.js",
      });
      throw new Error("Expected plugin auth to fail before agent completion");
    }
  }

  return { ...actual, Agent: FakeAgent };
});

const ORIGINAL_ENV = { ...process.env };
const EVAL_OAUTH_PLUGIN_ROOT = path.resolve(
  __dirname,
  "../../fixtures/plugins/eval-oauth",
);

async function mirrorThreadStateToAdapter(
  thread: TestThread,
  stateAdapterModule: typeof import("@/chat/state/adapter"),
): Promise<void> {
  const originalSetState = thread.setState.bind(thread);
  thread.setState = async (next, options) => {
    await originalSetState(next, options);
    await stateAdapterModule
      .getStateAdapter()
      .set(`thread-state:${thread.id}`, await thread.getState());
  };

  await stateAdapterModule
    .getStateAdapter()
    .set(`thread-state:${thread.id}`, await thread.getState());
}

describe("plugin auth runtime slack integration", () => {
  let pluginApp: PluginAppFixture | undefined;
  let chatRuntimeModule:
    | typeof import("../../fixtures/chat-runtime")
    | undefined;
  let stateAdapterModule: typeof import("@/chat/state/adapter") | undefined;
  let threadStateModule:
    | typeof import("@/chat/runtime/thread-state")
    | undefined;

  beforeEach(async () => {
    resetSlackApiMockState();
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_STATE_ADAPTER: "memory",
      SLACK_BOT_TOKEN: "xoxb-test-token",
    };
    pluginApp = await createPluginAppFixture([EVAL_OAUTH_PLUGIN_ROOT]);

    vi.resetModules();
    const { restoreSuiteExperimentalFeatures } = await import(
      "../../fixtures/experimental-setup"
    );
    restoreSuiteExperimentalFeatures();
    chatRuntimeModule = await import("../../fixtures/chat-runtime");
    stateAdapterModule = await import("@/chat/state/adapter");
    threadStateModule = await import("@/chat/runtime/thread-state");

    await stateAdapterModule.disconnectStateAdapter();
    await stateAdapterModule.getStateAdapter().connect();
  });

  afterEach(async () => {
    await stateAdapterModule?.disconnectStateAdapter();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    chatRuntimeModule = undefined;
    stateAdapterModule = undefined;
    threadStateModule = undefined;
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
  });

  it("does not park or deliver plugin auth links for bot-authored messages", async () => {
    const threadId = "slack:C0PLUGINBOT:1700000000.000";
    const { createTestChatRuntime } = chatRuntimeModule!;
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async <TSchema extends z.ZodTypeAny>(params: {
            schema: TSchema;
          }) => ({
            object: params.schema.parse({
              should_reply: true,
              should_unsubscribe: false,
              confidence: 1,
              reason: "integration update needs plugin auth",
            }),
          }),
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const destination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C0PLUGINBOT",
    };
    const thread = await createTestThread({
      id: threadId,
      state: {
        conversation: {
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "Earlier context",
              createdAtMs: 1,
              author: {
                userName: "junior",
                isBot: true,
              },
            },
          ],
        },
      },
    });
    await mirrorThreadStateToAdapter(thread, stateAdapterModule!);

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "bot-plugin-auth",
        threadId,
        text: "sync this with github",
        isMention: false,
        author: {
          userId: "U123",
          userName: "github",
          isBot: true,
        },
        raw: {
          bot_id: "B123456",
          channel: "C0PLUGINBOT",
          team_id: "T123",
          ts: "1700000000.001",
          thread_ts: "1700000000.000",
        },
      }),
      { destination },
    );

    expect(getCapturedSlackApiCalls("chat.postEphemeral")).toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
    const persistedState =
      await threadStateModule!.getPersistedThreadState(threadId);
    expect(persistedState).toMatchObject({
      conversation: {
        processing: {
          activeTurnId: undefined,
          pendingAuth: undefined,
        },
      },
    });
    const conversation = coerceThreadConversationState({});
    await hydrateConversationMessages({
      conversation,
      conversationId: threadId,
    });
    expect(
      conversation.messages.find((message) => message.id === "bot-plugin-auth"),
    ).toMatchObject({
      meta: {
        replied: false,
        skippedReason: "reply failed",
      },
    });
  });
});
