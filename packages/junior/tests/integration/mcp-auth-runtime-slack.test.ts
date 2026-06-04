import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ReplyRequestContext } from "@/chat/respond";
import type { ResumeReplyGenerator } from "@/chat/runtime/slack-resume";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import {
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTH_PROVIDER,
} from "../msw/handlers/eval-mcp-auth";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";
import {
  createTestMessage,
  createTestThread,
  type TestThread,
} from "../fixtures/slack-harness";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";
import { piTextResponse, piToolCallResponse } from "../fixtures/pi-stream";

const MCP_TOOL_NAME = "mcp__eval-auth__budget-echo";
const SKILL_NAME = "eval-auth";
const assistantReplyWithoutContext = "I need the earlier budget context first.";
const assistantReplyWithContext =
  "The budget deadline you mentioned earlier was Friday.";
const priorBudgetContext = "You need the budget by Friday.";
const testThinkingSelection: TurnThinkingSelection = {
  thinkingLevel: "medium",
  reason: "test_default",
};

const agentProbe = {
  continueCallCount: 0,
  directProviderSearch: false,
  promptCallCount: 0,
  searchToolNames: [] as string[][],
};

function resetAgentProbe(): void {
  agentProbe.promptCallCount = 0;
  agentProbe.continueCallCount = 0;
  agentProbe.directProviderSearch = false;
  agentProbe.searchToolNames.length = 0;
}

function extractTextContent(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? candidate.text
        : "";
    })
    .join("\n");
}

function hasPriorBudgetContext(messages: unknown[]): boolean {
  return messages.some((message) =>
    extractTextContent(message).includes(priorBudgetContext),
  );
}

function hasCompletedMcpAuthorization(messages: unknown[]): boolean {
  return messages.some((message) =>
    extractTextContent(message).includes(
      `MCP authorization completed for provider "${EVAL_MCP_AUTH_PROVIDER}"`,
    ),
  );
}

function extractSearchToolNames(messages: unknown[]): string[] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }

    const candidate = message as {
      details?: unknown;
      role?: unknown;
      toolName?: unknown;
    };
    if (
      candidate.role !== "toolResult" ||
      candidate.toolName !== "searchMcpTools" ||
      !candidate.details ||
      typeof candidate.details !== "object"
    ) {
      continue;
    }

    const tools = (candidate.details as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) {
      return [];
    }
    return tools
      .map((tool) =>
        tool && typeof tool === "object"
          ? (tool as { tool_name?: unknown }).tool_name
          : undefined,
      )
      .filter((toolName): toolName is string => typeof toolName === "string");
  }

  return undefined;
}

function recordSearchToolNames(messages: unknown[]): void {
  const toolNames = extractSearchToolNames(messages);
  if (!toolNames) {
    return;
  }

  const previous = agentProbe.searchToolNames.at(-1);
  if (previous && previous.join("\0") === toolNames.join("\0")) {
    return;
  }

  agentProbe.searchToolNames.push(toolNames);
}

function createMcpAuthStreamFn(): StreamFn {
  let initialPromptStarted = false;
  let resumeStep = 0;

  return async (_model, context) => {
    const messages = context.messages ?? [];
    const authorizationCompleted = hasCompletedMcpAuthorization(messages);

    if (authorizationCompleted && resumeStep > 0) {
      recordSearchToolNames(messages);
    }

    if (!initialPromptStarted) {
      initialPromptStarted = true;
      agentProbe.promptCallCount += 1;
      if (agentProbe.directProviderSearch) {
        return piToolCallResponse({
          id: "tool-search-provider",
          name: "searchMcpTools",
          parameters: {
            provider: EVAL_MCP_AUTH_PROVIDER,
            query: "budget echo query",
          },
        });
      }

      return piToolCallResponse({
        id: "tool-load-skill",
        name: "loadSkill",
        parameters: { skill_name: SKILL_NAME },
      });
    }

    if (!authorizationCompleted) {
      return piTextResponse("Authorization pending.");
    }

    if (resumeStep === 0) {
      resumeStep += 1;
      agentProbe.continueCallCount += 1;
      return piToolCallResponse({
        id: "tool-search-resume",
        name: "searchMcpTools",
        parameters: {
          provider: EVAL_MCP_AUTH_PROVIDER,
          query: "budget echo query",
        },
      });
    }

    if (resumeStep === 1) {
      resumeStep += 1;
      return piToolCallResponse({
        id: "tool-call-continue",
        name: "callMcpTool",
        parameters: {
          tool_name: MCP_TOOL_NAME,
          arguments: { query: "what did i say about the budget?" },
        },
      });
    }

    return piTextResponse(
      hasPriorBudgetContext(context.messages ?? [])
        ? assistantReplyWithContext
        : assistantReplyWithoutContext,
    );
  };
}

function createReplyGenerator(streamFn: StreamFn): ResumeReplyGenerator {
  return (messageText: string, context: ReplyRequestContext = {}) =>
    respondModule.generateAssistantReply(messageText, {
      ...context,
      streamFn,
      turnThinkingSelection: testThinkingSelection,
    });
}

const ORIGINAL_ENV = { ...process.env };
const EVAL_MCP_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-auth",
);

type ChatRuntimeModule = typeof import("../fixtures/chat-runtime");
type McpAuthStoreModule = typeof import("@/chat/mcp/auth-store");
type McpOauthCallbackHarnessModule =
  typeof import("../fixtures/mcp-oauth-callback-harness");
type RespondModule = typeof import("@/chat/respond");
type StateAdapterModule = typeof import("@/chat/state/adapter");
type ThreadStateModule = typeof import("@/chat/runtime/thread-state");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");

let chatRuntimeModule: ChatRuntimeModule;
let mcpAuthStoreModule: McpAuthStoreModule;
let mcpOauthCallbackHarnessModule: McpOauthCallbackHarnessModule;
let respondModule: RespondModule;
let stateAdapterModule: StateAdapterModule;
let threadStateModule: ThreadStateModule;
let turnSessionStoreModule: TurnSessionStoreModule;

async function mirrorThreadStateToAdapter(thread: TestThread): Promise<void> {
  const originalSetState = thread.setState.bind(thread);
  thread.setState = async (next, options) => {
    await originalSetState(next, options);
    // The OAuth callback reloads state by thread id, so keep the fixture thread
    // and the memory adapter in sync during the first parked turn.
    await stateAdapterModule
      .getStateAdapter()
      .set(`thread-state:${thread.id}`, thread.getState());
  };

  await stateAdapterModule
    .getStateAdapter()
    .set(`thread-state:${thread.id}`, thread.getState());
}

function expectProcessingReactionLifecycles(args: {
  channel: string;
  completedCount?: number;
  count: number;
  timestamp: string;
}): void {
  const call = (name: string) =>
    expect.objectContaining({
      params: expect.objectContaining({
        channel: args.channel,
        timestamp: args.timestamp,
        name,
      }),
    });
  const eyes = Array.from({ length: args.count }, () => call("eyes"));
  const completed = Array.from({ length: args.completedCount ?? 0 }, () =>
    call("white_check_mark"),
  );

  expect(getCapturedSlackApiCalls("reactions.add")).toEqual([
    ...eyes,
    ...completed,
  ]);
  expect(getCapturedSlackApiCalls("reactions.remove")).toEqual(eyes);
}

describe("mcp auth runtime slack integration", () => {
  let pluginApp: PluginAppFixture | undefined;

  beforeEach(async () => {
    resetAgentProbe();
    resetSlackApiMockState();
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_STATE_ADAPTER: "memory",
      SLACK_BOT_TOKEN: "xoxb-test-token",
    };
    pluginApp = await createPluginAppFixture([EVAL_MCP_PLUGIN_ROOT]);

    vi.resetModules();
    chatRuntimeModule = await import("../fixtures/chat-runtime");
    mcpAuthStoreModule = await import("@/chat/mcp/auth-store");
    mcpOauthCallbackHarnessModule =
      await import("../fixtures/mcp-oauth-callback-harness");
    respondModule = await import("@/chat/respond");
    stateAdapterModule = await import("@/chat/state/adapter");
    threadStateModule = await import("@/chat/runtime/thread-state");
    turnSessionStoreModule = await import("@/chat/state/turn-session");

    await stateAdapterModule.disconnectStateAdapter();
    await stateAdapterModule.getStateAdapter().connect();
  }, 45_000);

  afterEach(async () => {
    await stateAdapterModule?.disconnectStateAdapter();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    process.env = { ...ORIGINAL_ENV };
  }, 45_000);

  it("parks an MCP auth challenge from the real Slack runtime and resumes after OAuth callback", async () => {
    const threadId = "slack:C123:1700000000.001";
    const turnId = "turn_user-1";
    const { createTestChatRuntime } = chatRuntimeModule;
    const generateAssistantReply = createReplyGenerator(
      createMcpAuthStreamFn(),
    );
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: { generateAssistantReply },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const destination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C123",
    };
    const thread = createTestThread({
      id: threadId,
      state: {
        conversation: {
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: priorBudgetContext,
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
    await mirrorThreadStateToAdapter(thread);

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "user-1",
        threadId,
        text: "what did i say about the budget?",
        isMention: true,
        author: {
          userId: "U123",
          userName: "dcramer",
        },
        raw: {
          channel: "C123",
          team_id: "T123",
          ts: "1700000000.002",
          thread_ts: "1700000000.001",
        },
      }),
      { destination },
    );

    expect(agentProbe.promptCallCount).toBe(1);
    expect(agentProbe.continueCallCount).toBe(0);

    expect(getCapturedSlackApiCalls("chat.postEphemeral")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          user: "U123",
          thread_ts: "1700000000.001",
          text: expect.stringContaining(
            "Click here to link your Eval Auth MCP access",
          ),
        }),
      }),
    ]);
    expect(thread.posts).toEqual([
      expect.objectContaining({
        markdown: expect.stringContaining(
          "<@U123> I'll need you to authorize Eval Auth. I sent you a link.",
        ),
      }),
    ]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expectProcessingReactionLifecycles({
      channel: "C123",
      timestamp: "1700000000.002",
      count: 1,
    });

    const pendingAuthSession =
      await mcpAuthStoreModule.getLatestMcpAuthSessionForUserProvider(
        "U123",
        EVAL_MCP_AUTH_PROVIDER,
      );
    expect(pendingAuthSession).toMatchObject({
      provider: EVAL_MCP_AUTH_PROVIDER,
      conversationId: threadId,
      sessionId: turnId,
      userId: "U123",
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      destination,
      threadTs: "1700000000.001",
      authorizationUrl: expect.stringContaining(
        "https://eval-auth.example.test/oauth/authorize",
      ),
    });
    const parkedAuthSessionId = pendingAuthSession!.authSessionId;

    const pendingCheckpoint =
      await turnSessionStoreModule.getAgentTurnSessionRecord(threadId, turnId);
    expect(pendingCheckpoint).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      sliceId: 2,
      state: "awaiting_resume",
      resumeReason: "auth",
      resumedFromSliceId: 1,
    });

    const parkedState =
      await threadStateModule.getPersistedThreadState(threadId);
    expect(parkedState).toMatchObject({
      conversation: {
        processing: {
          activeTurnId: undefined,
          pendingAuth: {
            kind: "mcp",
            provider: EVAL_MCP_AUTH_PROVIDER,
            requesterId: "U123",
            sessionId: turnId,
            linkSentAtMs: expect.any(Number),
          },
        },
      },
    });

    const response =
      await mcpOauthCallbackHarnessModule.runMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        state: pendingAuthSession!.authSessionId,
        code: EVAL_MCP_AUTH_CODE,
        generateReply: generateAssistantReply,
      });

    expect(response.status).toBe(200);
    const sessionRecordAfterAuth =
      await turnSessionStoreModule.getAgentTurnSessionRecord(threadId, turnId);
    expect(sessionRecordAfterAuth?.piMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [
            {
              type: "text",
              text: `MCP authorization completed for provider "${EVAL_MCP_AUTH_PROVIDER}". Continue the blocked request and retry the provider operation if needed.`,
            },
          ],
        }),
      ]),
    );
    expect(agentProbe.promptCallCount).toBe(1);
    expect(agentProbe.continueCallCount).toBe(1);
    expect(agentProbe.searchToolNames).toEqual([[MCP_TOOL_NAME]]);

    const latestReusableSession =
      await mcpAuthStoreModule.getLatestMcpAuthSessionForUserProvider(
        "U123",
        EVAL_MCP_AUTH_PROVIDER,
      );
    expect(latestReusableSession).toMatchObject({
      provider: EVAL_MCP_AUTH_PROVIDER,
      conversationId: threadId,
      sessionId: turnId,
      userId: "U123",
      userMessage: "what did i say about the budget?",
    });
    expect(latestReusableSession?.authSessionId).not.toBe(parkedAuthSessionId);
    expect(latestReusableSession?.authorizationUrl).toBeUndefined();
    expect(latestReusableSession?.codeVerifier).toBeUndefined();
    expect(
      await mcpAuthStoreModule.getMcpStoredOAuthCredentials(
        "U123",
        EVAL_MCP_AUTH_PROVIDER,
      ),
    ).toMatchObject({
      tokens: {
        access_token: "eval-auth-access-token",
        refresh_token: "eval-auth-refresh-token",
      },
    });

    const completedCheckpoint =
      await turnSessionStoreModule.getAgentTurnSessionRecord(threadId, turnId);
    expect(completedCheckpoint).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      sliceId: 2,
      state: "completed",
    });

    const resumedState =
      await threadStateModule.getPersistedThreadState(threadId);
    expect(resumedState).toMatchObject({
      conversation: {
        processing: {
          activeTurnId: undefined,
          pendingAuth: undefined,
        },
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "user-1",
            role: "user",
            meta: expect.objectContaining({
              replied: true,
            }),
          }),
          expect.objectContaining({
            role: "assistant",
            text: assistantReplyWithContext,
          }),
        ]),
      },
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.001",
          text: assistantReplyWithContext,
        }),
      }),
    ]);
    expectProcessingReactionLifecycles({
      channel: "C123",
      timestamp: "1700000000.002",
      count: 2,
      completedCount: 1,
    });
  });

  it("parks a subscribed-thread MCP auth challenge with the same pending-auth state", async () => {
    const threadId = "slack:C124:1700000000.002";
    const turnId = "turn_user-2";
    const { createTestChatRuntime } = chatRuntimeModule;
    const generateAssistantReply = createReplyGenerator(
      createMcpAuthStreamFn(),
    );
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: { generateAssistantReply },
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: true,
                confidence: 1,
                reason: "requires thread follow-up",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"requires thread follow-up"}',
            }) as never,
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const destination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C124",
    };
    const thread = createTestThread({
      id: threadId,
      state: {
        conversation: {
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: priorBudgetContext,
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
    await mirrorThreadStateToAdapter(thread);

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "user-2",
        threadId,
        text: "what did i say about the budget?",
        isMention: false,
        author: {
          userId: "U123",
          userName: "dcramer",
        },
        raw: {
          channel: "C124",
          team_id: "T123",
          ts: "1700000000.004",
          thread_ts: "1700000000.002",
        },
      }),
      { destination },
    );

    expect(agentProbe.promptCallCount).toBe(1);
    expect(agentProbe.continueCallCount).toBe(0);
    expect(thread.posts).toEqual([
      expect.objectContaining({
        markdown: expect.stringContaining(
          "<@U123> I'll need you to authorize Eval Auth. I sent you a link.",
        ),
      }),
    ]);

    const pendingCheckpoint =
      await turnSessionStoreModule.getAgentTurnSessionRecord(threadId, turnId);
    expect(pendingCheckpoint).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      sliceId: 2,
      state: "awaiting_resume",
      resumeReason: "auth",
      resumedFromSliceId: 1,
    });

    const parkedState =
      await threadStateModule.getPersistedThreadState(threadId);
    expect(parkedState).toMatchObject({
      conversation: {
        processing: {
          activeTurnId: undefined,
          pendingAuth: {
            kind: "mcp",
            provider: EVAL_MCP_AUTH_PROVIDER,
            requesterId: "U123",
            sessionId: turnId,
            linkSentAtMs: expect.any(Number),
          },
        },
      },
    });
  });

  it("parks and resumes an MCP auth challenge from direct provider activation", async () => {
    agentProbe.directProviderSearch = true;
    const threadId = "slack:C125:1700000000.003";
    const turnId = "turn_user-3";
    const { createTestChatRuntime } = chatRuntimeModule;
    const generateAssistantReply = createReplyGenerator(
      createMcpAuthStreamFn(),
    );
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: { generateAssistantReply },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const destination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C125",
    };
    const thread = createTestThread({
      id: threadId,
      state: {
        conversation: {
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: priorBudgetContext,
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
    await mirrorThreadStateToAdapter(thread);

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "user-3",
        threadId,
        text: "use eval-auth directly for the budget answer",
        isMention: true,
        author: {
          userId: "U123",
          userName: "dcramer",
        },
        raw: {
          channel: "C125",
          team_id: "T123",
          ts: "1700000000.004",
          thread_ts: "1700000000.003",
        },
      }),
      { destination },
    );

    const pendingCheckpoint =
      await turnSessionStoreModule.getAgentTurnSessionRecord(threadId, turnId);
    expect(pendingCheckpoint).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      sliceId: 2,
      state: "awaiting_resume",
      resumeReason: "auth",
    });

    const pendingAuthSession =
      await mcpAuthStoreModule.getLatestMcpAuthSessionForUserProvider(
        "U123",
        EVAL_MCP_AUTH_PROVIDER,
      );
    expect(pendingAuthSession).toMatchObject({
      provider: EVAL_MCP_AUTH_PROVIDER,
      conversationId: threadId,
      sessionId: turnId,
      userId: "U123",
      destination,
    });

    const response =
      await mcpOauthCallbackHarnessModule.runMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        state: pendingAuthSession!.authSessionId,
        code: EVAL_MCP_AUTH_CODE,
        generateReply: generateAssistantReply,
      });

    expect(response.status).toBe(200);
    expect(agentProbe.promptCallCount).toBe(1);
    expect(agentProbe.continueCallCount).toBe(1);
    expect(agentProbe.searchToolNames).toEqual([[MCP_TOOL_NAME]]);

    const completedCheckpoint =
      await turnSessionStoreModule.getAgentTurnSessionRecord(threadId, turnId);
    expect(completedCheckpoint).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      state: "completed",
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C125",
          thread_ts: "1700000000.003",
          text: assistantReplyWithContext,
        }),
      }),
    ]);
  });
});
