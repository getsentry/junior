import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
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

const {
  agentProbe,
  MCP_TOOL_NAME,
  SKILL_NAME,
  assistantReplyWithoutContext,
  assistantReplyWithContext,
  priorBudgetContext,
  unrelatedAuthPendingReply,
} = vi.hoisted(() => ({
  agentProbe: {
    continueCallCount: 0,
    directProviderSearch: false,
    promptCallCount: 0,
    searchToolNames: [] as string[][],
    shouldBypassSkill: false,
  },
  MCP_TOOL_NAME: "mcp__eval-auth__budget-echo",
  SKILL_NAME: "eval-auth",
  assistantReplyWithoutContext: "I need the earlier budget context first.",
  assistantReplyWithContext:
    "The budget deadline you mentioned earlier was Friday.",
  priorBudgetContext: "You need the budget by Friday.",
  unrelatedAuthPendingReply:
    "An unrelated answer that does not require Notion or eval-auth.",
}));

function resetAgentProbe(): void {
  agentProbe.promptCallCount = 0;
  agentProbe.continueCallCount = 0;
  agentProbe.directProviderSearch = false;
  agentProbe.searchToolNames.length = 0;
  agentProbe.shouldBypassSkill = false;
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

function expectBlocksIncludeConversationId(
  params: Record<string, unknown>,
  conversationId: string,
): void {
  expect(params.blocks).toBeDefined();
  expect(JSON.stringify(params.blocks)).toContain(conversationId);
}

vi.mock("@/chat/services/turn-thinking-level", async () => {
  const actual = await vi.importActual<
    typeof import("@/chat/services/turn-thinking-level")
  >("@/chat/services/turn-thinking-level");
  return {
    ...actual,
    // Bypass the classifier to keep this an agent-boundary test with no
    // model traffic.
    selectTurnThinkingLevel: async () => ({
      thinkingLevel: "medium" as const,
      reason: "test_default",
    }),
  };
});

vi.mock("@earendil-works/pi-agent-core", () => {
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
    private aborted = false;

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

    abort() {
      this.aborted = true;
    }

    async prompt(message: unknown) {
      agentProbe.promptCallCount += 1;
      this.aborted = false;
      this.state.messages.push(message);

      if (agentProbe.shouldBypassSkill) {
        // Simulate an unrelated request that does not need any MCP tools.
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: unrelatedAuthPendingReply }],
          stopReason: "stop",
        });
        return {};
      }

      if (agentProbe.directProviderSearch) {
        const searchMcpTools = this.state.tools.find(
          (tool) => tool.name === "searchMcpTools",
        );
        if (!searchMcpTools) {
          throw new Error("searchMcpTools missing");
        }
        await searchMcpTools.execute("tool-search-provider", {
          provider: EVAL_MCP_AUTH_PROVIDER,
          query: "budget echo query",
        });
        if (this.aborted) {
          return {};
        }
        throw new Error("Expected MCP auth pause while searching eval-auth");
      }

      const loadSkillTool = this.state.tools.find(
        (tool) => tool.name === "loadSkill",
      );
      if (!loadSkillTool) {
        throw new Error("loadSkill tool missing");
      }

      const loadSkillResult = (await loadSkillTool.execute("tool-load-skill", {
        skill_name: SKILL_NAME,
      })) as {
        ok?: boolean;
        skill_name?: string;
      };
      this.state.messages.push({
        role: "toolResult",
        toolCallId: "tool-load-skill",
        toolName: "loadSkill",
        skill_name: loadSkillResult.skill_name,
        ok: loadSkillResult.ok,
        details: loadSkillResult,
        isError: false,
      });

      if (this.aborted) {
        return {};
      }

      throw new Error("Expected MCP auth pause while loading eval-auth");
    }

    async continue() {
      agentProbe.continueCallCount += 1;
      this.aborted = false;

      const searchMcpTools = this.state.tools.find(
        (tool) => tool.name === "searchMcpTools",
      );
      if (!searchMcpTools) {
        throw new Error("searchMcpTools missing on resume");
      }
      const searchResult = (await searchMcpTools.execute("tool-search-resume", {
        provider: EVAL_MCP_AUTH_PROVIDER,
        query: "budget echo query",
      })) as {
        details?: { tools?: Array<{ tool_name?: unknown }> };
      };
      agentProbe.searchToolNames.push(
        (searchResult.details?.tools ?? [])
          .map((tool) => tool.tool_name)
          .filter(
            (toolName): toolName is string => typeof toolName === "string",
          ),
      );

      const callMcpTool = this.state.tools.find(
        (tool) => tool.name === "callMcpTool",
      );
      if (!callMcpTool) {
        throw new Error("callMcpTool missing on resume");
      }

      await callMcpTool.execute("tool-call-continue", {
        tool_name: MCP_TOOL_NAME,
        arguments: { query: "what did i say about the budget?" },
      });

      if (this.aborted) {
        return {};
      }

      this.state.messages.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: hasPriorBudgetContext(this.state.messages)
              ? assistantReplyWithContext
              : assistantReplyWithoutContext,
          },
        ],
        stopReason: "stop",
      });

      return {};
    }
  }

  return {
    Agent: FakeAgent,
    estimateContextTokens: () => ({ tokens: 0 }),
    estimateTokens: () => 0,
  };
});

const ORIGINAL_ENV = { ...process.env };
const EVAL_MCP_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-auth",
);

type ChatRuntimeModule = typeof import("../fixtures/chat-runtime");
type McpAuthStoreModule = typeof import("@/chat/mcp/auth-store");
type McpOauthCallbackHarnessModule =
  typeof import("../fixtures/mcp-oauth-callback-harness");
type StateAdapterModule = typeof import("@/chat/state/adapter");
type ThreadStateModule = typeof import("@/chat/runtime/thread-state");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");

let chatRuntimeModule: ChatRuntimeModule;
let mcpAuthStoreModule: McpAuthStoreModule;
let mcpOauthCallbackHarnessModule: McpOauthCallbackHarnessModule;
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
    const { slackRuntime } = createTestChatRuntime({
      services: {
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
    expect(thread.posts).toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.001",
          text: "<@U123> I'll need you to authorize Eval Auth. I sent you a link.",
        }),
      }),
    ]);
    expectBlocksIncludeConversationId(
      getCapturedSlackApiCalls("chat.postMessage")[0]!.params,
      "slack:C123:1700000000.001",
    );
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
            actorId: "U123",
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
          text: "<@U123> I'll need you to authorize Eval Auth. I sent you a link.",
        }),
      }),
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
              reason: "requires thread follow-up",
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
    expect(thread.posts).toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C124",
          thread_ts: "1700000000.002",
          text: "<@U123> I'll need you to authorize Eval Auth. I sent you a link.",
        }),
      }),
    ]);
    expectBlocksIncludeConversationId(
      getCapturedSlackApiCalls("chat.postMessage")[0]!.params,
      "slack:C124:1700000000.002",
    );

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
            actorId: "U123",
            sessionId: turnId,
            linkSentAtMs: expect.any(Number),
          },
        },
      },
    });
  });

  it("does not park or deliver auth links for bot-authored subscribed messages", async () => {
    const threadId = "slack:C129:1700000000.009";
    const turnId = "turn_bot-message";
    const { createTestChatRuntime } = chatRuntimeModule;
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
              reason: "integration update needs auth",
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
      channelId: "C129",
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
        id: "bot-message",
        threadId,
        text: "what did i say about the budget?",
        isMention: false,
        author: {
          userId: "U123",
          userName: "linear",
          isBot: true,
        },
        raw: {
          bot_id: "B123456",
          channel: "C129",
          team_id: "T123",
          ts: "1700000000.010",
          thread_ts: "1700000000.009",
        },
      }),
      { destination },
    );

    expect(getCapturedSlackApiCalls("chat.postEphemeral")).toEqual([]);
    expect(
      await mcpAuthStoreModule.getLatestMcpAuthSessionForUserProvider(
        "U123",
        EVAL_MCP_AUTH_PROVIDER,
      ),
    ).toBeUndefined();
    expect(
      await turnSessionStoreModule.getAgentTurnSessionRecord(threadId, turnId),
    ).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      state: "failed",
      errorMessage: "Agent turn failed before final reply delivery completed",
    });

    const persistedState =
      await threadStateModule.getPersistedThreadState(threadId);
    expect(persistedState).toMatchObject({
      conversation: {
        processing: {
          pendingAuth: undefined,
        },
      },
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
  });

  it("parks and resumes an MCP auth challenge from direct provider activation", async () => {
    agentProbe.directProviderSearch = true;
    const threadId = "slack:C125:1700000000.003";
    const turnId = "turn_user-3";
    const { createTestChatRuntime } = chatRuntimeModule;
    const { slackRuntime } = createTestChatRuntime({
      services: {
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
          text: "<@U123> I'll need you to authorize Eval Auth. I sent you a link.",
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C125",
          thread_ts: "1700000000.003",
          text: assistantReplyWithContext,
        }),
      }),
    ]);
    expectBlocksIncludeConversationId(
      getCapturedSlackApiCalls("chat.postMessage")[0]!.params,
      "slack:C125:1700000000.003",
    );
  });

  it.each([
    {
      label: "same actor",
      currentActorId: "U123",
      currentActorName: "dcramer",
    },
    {
      label: "different actor",
      currentActorId: "U999",
      currentActorName: "paul",
    },
  ])(
    "does not abort unrelated turns for the $label when MCP auth is already pending from a prior turn",
    async ({ currentActorId, currentActorName }) => {
      const threadId = "slack:C126:1700000000.004";
      const { createTestChatRuntime } = chatRuntimeModule;
      const { slackRuntime } = createTestChatRuntime({
        services: {
          visionContext: {
            listThreadReplies: async () => [],
          },
        },
      });

      const destination = {
        platform: "slack" as const,
        teamId: "T123",
        channelId: "C126",
      };

      const thread = createTestThread({
        id: threadId,
        state: {
          conversation: {
            messages: [
              {
                id: "assistant-1",
                role: "assistant",
                text: "Please authorize via the link I sent you.",
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
          id: "user-auth",
          threadId,
          text: "what did i say about the budget?",
          isMention: true,
          author: {
            userId: "U123",
            userName: "dcramer",
          },
          raw: {
            channel: "C126",
            team_id: "T123",
            ts: "1700000000.005",
            thread_ts: "1700000000.004",
          },
        }),
        { destination },
      );

      expect(
        await threadStateModule.getPersistedThreadState(threadId),
      ).toMatchObject({
        conversation: {
          processing: {
            pendingAuth: {
              kind: "mcp",
              provider: EVAL_MCP_AUTH_PROVIDER,
              actorId: "U123",
              sessionId: "turn_user-auth",
              linkSentAtMs: expect.any(Number),
            },
          },
        },
      });

      const authLinkCount =
        getCapturedSlackApiCalls("chat.postEphemeral").length;
      agentProbe.shouldBypassSkill = true;

      await slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "user-4",
          threadId,
          text: "what time is it?", // completely unrelated to eval-auth
          isMention: true,
          author: {
            userId: currentActorId,
            userName: currentActorName,
          },
          raw: {
            channel: "C126",
            team_id: "T123",
            ts: "1700000000.006",
            thread_ts: "1700000000.004",
          },
        }),
        { destination },
      );

      expect(getCapturedSlackApiCalls("chat.postEphemeral")).toHaveLength(
        authLinkCount,
      );

      expect(thread.posts.at(-1)).toEqual(
        expect.objectContaining({
          markdown: unrelatedAuthPendingReply,
        }),
      );
    },
  );
});
