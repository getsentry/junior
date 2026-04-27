import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const {
  agentProbe,
  MCP_TOOL_NAME,
  SKILL_NAME,
  assistantReplyWithoutContext,
  assistantReplyWithContext,
  priorBudgetContext,
} = vi.hoisted(() => ({
  agentProbe: {
    continueCallCount: 0,
    promptCallCount: 0,
  },
  MCP_TOOL_NAME: "mcp__eval-auth__budget-echo",
  SKILL_NAME: "eval-auth",
  assistantReplyWithoutContext: "I need the earlier budget context first.",
  assistantReplyWithContext:
    "The budget deadline you mentioned earlier was Friday.",
  priorBudgetContext: "You need the budget by Friday.",
}));

function resetAgentProbe(): void {
  agentProbe.promptCallCount = 0;
  agentProbe.continueCallCount = 0;
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

function toPostedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    if (typeof markdown === "string") {
      return markdown;
    }
  }

  return String(value);
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

vi.mock("@mariozechner/pi-agent-core", () => {
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

    replaceMessages(messages: unknown[]) {
      this.state.messages = [...messages];
    }

    async prompt(message: unknown) {
      agentProbe.promptCallCount += 1;
      this.aborted = false;
      this.state.messages.push(message);

      const loadSkillTool = this.state.tools.find(
        (tool) => tool.name === "loadSkill",
      );
      if (!loadSkillTool) {
        throw new Error("loadSkill tool missing");
      }

      await loadSkillTool.execute("tool-load-skill", {
        skill_name: SKILL_NAME,
      });

      if (this.aborted) {
        return {};
      }

      throw new Error("Expected MCP auth pause while loading eval-auth");
    }

    async continue() {
      agentProbe.continueCallCount += 1;
      this.aborted = false;

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

  return { Agent: FakeAgent };
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
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session-store");

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

describe("mcp auth runtime slack integration", () => {
  beforeEach(async () => {
    resetAgentProbe();
    resetSlackApiMockState();
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_EXTRA_PLUGIN_ROOTS: JSON.stringify([EVAL_MCP_PLUGIN_ROOT]),
      JUNIOR_STATE_ADAPTER: "memory",
      SLACK_BOT_TOKEN: "xoxb-test-token",
    };

    vi.resetModules();
    chatRuntimeModule = await import("../fixtures/chat-runtime");
    mcpAuthStoreModule = await import("@/chat/mcp/auth-store");
    mcpOauthCallbackHarnessModule =
      await import("../fixtures/mcp-oauth-callback-harness");
    stateAdapterModule = await import("@/chat/state/adapter");
    threadStateModule = await import("@/chat/runtime/thread-state");
    turnSessionStoreModule = await import("@/chat/state/turn-session-store");

    await stateAdapterModule.disconnectStateAdapter();
    await stateAdapterModule.getStateAdapter().connect();
  });

  afterEach(async () => {
    await stateAdapterModule.disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
  });

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
      }),
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
            "Click here to link your Eval-auth MCP access",
          ),
        }),
      }),
    ]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "I need your Eval-auth access to continue. I sent you a private link.",
    );
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);

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
      threadTs: "1700000000.001",
      authorizationUrl: expect.stringContaining(
        "https://eval-auth.example.test/oauth/authorize",
      ),
    });
    const parkedAuthSessionId = pendingAuthSession!.authSessionId;

    const pendingCheckpoint =
      await turnSessionStoreModule.getAgentTurnSessionCheckpoint(
        threadId,
        turnId,
      );
    expect(pendingCheckpoint).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      sliceId: 2,
      state: "awaiting_resume",
      resumeReason: "auth",
      resumedFromSliceId: 1,
      loadedSkillNames: [SKILL_NAME],
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
      });

    expect(response.status).toBe(200);
    expect(agentProbe.promptCallCount).toBe(1);
    expect(agentProbe.continueCallCount).toBe(1);

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
      await turnSessionStoreModule.getAgentTurnSessionCheckpoint(
        threadId,
        turnId,
      );
    expect(completedCheckpoint).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      sliceId: 2,
      state: "completed",
      loadedSkillNames: [SKILL_NAME],
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
            text: "I need your Eval-auth access to continue. I sent you a private link.",
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
  });

  it("parks a subscribed-thread MCP auth challenge with the same pending-auth state", async () => {
    const threadId = "slack:C124:1700000000.002";
    const turnId = "turn_user-2";
    const { createTestChatRuntime } = chatRuntimeModule;
    const { slackRuntime } = createTestChatRuntime({
      services: {
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
      }),
    );

    expect(agentProbe.promptCallCount).toBe(1);
    expect(agentProbe.continueCallCount).toBe(0);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "I need your Eval-auth access to continue. I sent you a private link.",
    );

    const pendingCheckpoint =
      await turnSessionStoreModule.getAgentTurnSessionCheckpoint(
        threadId,
        turnId,
      );
    expect(pendingCheckpoint).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      sliceId: 2,
      state: "awaiting_resume",
      resumeReason: "auth",
      resumedFromSliceId: 1,
      loadedSkillNames: [SKILL_NAME],
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
});
