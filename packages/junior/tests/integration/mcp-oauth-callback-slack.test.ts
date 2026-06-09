import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTH_PROVIDER,
} from "../msw/handlers/eval-mcp-auth";
import {
  getCapturedSlackApiCalls,
  getCapturedSlackFileUploadCalls,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";

const { generateAssistantReplyMock } = vi.hoisted(() => ({
  generateAssistantReplyMock: vi.fn(),
}));

vi.mock("@/chat/respond", () => ({
  generateAssistantReply: generateAssistantReplyMock,
}));

const ORIGINAL_ENV = { ...process.env };
const EVAL_MCP_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-auth",
);
const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

type ArtifactStateModule = typeof import("@/chat/state/artifacts");
type ConversationStateModule = typeof import("@/chat/state/conversation");
type McpAuthStoreModule = typeof import("@/chat/mcp/auth-store");
type McpClientModule = typeof import("@/chat/mcp/client");
type McpOauthModule = typeof import("@/chat/mcp/oauth");
type McpOauthCallbackHarnessModule =
  typeof import("../fixtures/mcp-oauth-callback-harness");
type PluginRegistryModule = typeof import("@/chat/plugins/registry");
type StateAdapterModule = typeof import("@/chat/state/adapter");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");

let artifactStateModule: ArtifactStateModule;
let conversationStateModule: ConversationStateModule;
let mcpAuthStoreModule: McpAuthStoreModule;
let mcpClientModule: McpClientModule;
let mcpOauthModule: McpOauthModule;
let mcpOauthCallbackHarnessModule: McpOauthCallbackHarnessModule;
let pluginRegistryModule: PluginRegistryModule;
let stateAdapterModule: StateAdapterModule;
let turnSessionStoreModule: TurnSessionStoreModule;
let pluginApp: PluginAppFixture | undefined;

async function createPendingAuthSession(args: {
  conversationId: string;
  sessionId: string;
  userMessage: string;
  channelId: string;
  threadTs: string;
}) {
  const authProvider = await mcpOauthModule.createMcpOAuthClientProvider({
    provider: EVAL_MCP_AUTH_PROVIDER,
    conversationId: args.conversationId,
    destination: SLACK_DESTINATION,
    sessionId: args.sessionId,
    userId: "U123",
    userMessage: args.userMessage,
    channelId: args.channelId,
    threadTs: args.threadTs,
  });

  const plugin = pluginRegistryModule.getPluginDefinition(
    EVAL_MCP_AUTH_PROVIDER,
  );
  expect(plugin).toBeDefined();

  const client = new mcpClientModule.PluginMcpClient(plugin!, {
    authProvider,
  });
  await expect(client.listTools()).rejects.toBeInstanceOf(
    mcpClientModule.McpAuthorizationRequiredError,
  );
  await client.close();

  return authProvider;
}

async function createAwaitingMcpTurnRecord(args: {
  conversationId: string;
  requester?: {
    email?: string;
    fullName?: string;
    platform?: "slack";
    slackUserId?: string;
    slackUserName?: string;
    teamId?: string;
  };
  sessionId: string;
  text: string;
}) {
  await turnSessionStoreModule.upsertAgentTurnSessionRecord({
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: 2,
    state: "awaiting_resume",
    destination: SLACK_DESTINATION,
    piMessages: [
      {
        role: "user",
        content: [{ type: "text", text: args.text }],
        timestamp: 1,
      },
    ],
    ...(args.requester ? { requester: args.requester } : {}),
    resumeReason: "auth",
    resumedFromSliceId: 1,
  });
}

describe("mcp oauth callback slack integration", () => {
  beforeEach(async () => {
    generateAssistantReplyMock.mockReset();
    generateAssistantReplyMock.mockResolvedValue({
      text: "The budget deadline you mentioned earlier was Friday.",
      artifactStatePatch: {
        lastCanvasUrl: "https://example.com/canvas",
      },
      sandboxId: "sandbox-1",
      sandboxDependencyProfileHash: "hash-1",
      diagnostics: {
        outcome: "success",
        toolCalls: [],
      },
    });
    resetSlackApiMockState();
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
      JUNIOR_BASE_URL: "https://junior.example.com",
    };
    pluginApp = await createPluginAppFixture([EVAL_MCP_PLUGIN_ROOT]);

    vi.resetModules();
    artifactStateModule = await import("@/chat/state/artifacts");
    conversationStateModule = await import("@/chat/state/conversation");
    mcpAuthStoreModule = await import("@/chat/mcp/auth-store");
    mcpClientModule = await import("@/chat/mcp/client");
    mcpOauthModule = await import("@/chat/mcp/oauth");
    mcpOauthCallbackHarnessModule =
      await import("../fixtures/mcp-oauth-callback-harness");
    pluginRegistryModule = await import("@/chat/plugins/registry");
    stateAdapterModule = await import("@/chat/state/adapter");
    turnSessionStoreModule = await import("@/chat/state/turn-session");

    await stateAdapterModule.disconnectStateAdapter();
    await stateAdapterModule.getStateAdapter().connect();
  });

  afterEach(async () => {
    await stateAdapterModule?.disconnectStateAdapter();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    process.env = { ...ORIGINAL_ENV };
  });

  it("finalizes MCP OAuth and resumes the stored thread with persisted context", async () => {
    const threadId = "slack:C123:1700000000.001";
    const sessionId = "turn_user-1";

    await stateAdapterModule.getStateAdapter().set(`thread-state:${threadId}`, {
      conversation: {
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "You need the budget by Friday.",
            createdAtMs: 1,
            author: {
              userName: "junior",
              isBot: true,
            },
          },
          {
            id: "user-1",
            role: "user",
            text: "what did i say about the budget?",
            createdAtMs: 2,
            author: {
              userId: "U123",
              userName: "dcramer",
            },
            meta: {
              attachmentCount: 1,
              imageAttachmentCount: 1,
              imagesHydrated: false,
            },
          },
        ],
        processing: {
          activeTurnId: undefined,
          pendingAuth: {
            kind: "mcp",
            provider: EVAL_MCP_AUTH_PROVIDER,
            requesterId: "U123",
            sessionId,
            linkSentAtMs: 1,
          },
        },
      },
      artifacts: {
        assistantContextChannelId: "C999",
        lastCanvasId: "F123",
      },
    });
    await stateAdapterModule.getStateAdapter().set("channel-state:C123", {
      configuration: {
        schemaVersion: 1,
        entries: {
          region: {
            key: "region",
            value: "us",
            scope: "conversation",
            updatedAt: new Date(0).toISOString(),
          },
        },
      },
    });
    await createAwaitingMcpTurnRecord({
      conversationId: "conversation-1",
      requester: {
        platform: "slack",
        teamId: "T123",
        slackUserId: "U123",
        slackUserName: "stored-user",
        fullName: "Stored User",
        email: "stored@example.com",
      },
      sessionId,
      text: "what did i say about the budget?",
    });

    const authProvider = await mcpOauthModule.createMcpOAuthClientProvider({
      provider: EVAL_MCP_AUTH_PROVIDER,
      conversationId: "conversation-1",
      destination: SLACK_DESTINATION,
      sessionId,
      userId: "U123",
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.001",
      toolChannelId: "C999",
      configuration: {
        region: "us",
      },
      artifactState: {
        assistantContextChannelId: "C999",
        lastCanvasId: "F123",
      },
    });

    const plugin = pluginRegistryModule.getPluginDefinition(
      EVAL_MCP_AUTH_PROVIDER,
    );
    expect(plugin).toBeDefined();

    const client = new mcpClientModule.PluginMcpClient(plugin!, {
      authProvider,
    });
    await expect(client.listTools()).rejects.toBeInstanceOf(
      mcpClientModule.McpAuthorizationRequiredError,
    );
    await client.close();

    const pendingSession = await mcpAuthStoreModule.getMcpAuthSession(
      authProvider.authSessionId,
    );
    expect(pendingSession).toMatchObject({
      authSessionId: authProvider.authSessionId,
      provider: EVAL_MCP_AUTH_PROVIDER,
      userId: "U123",
      conversationId: "conversation-1",
      destination: SLACK_DESTINATION,
      sessionId,
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.001",
      toolChannelId: "C999",
      configuration: {
        region: "us",
      },
      artifactState: {
        assistantContextChannelId: "C999",
        lastCanvasId: "F123",
      },
      authorizationUrl: expect.stringContaining(
        "https://eval-auth.example.test/oauth/authorize",
      ),
      codeVerifier: expect.any(String),
    });

    const response =
      await mcpOauthCallbackHarnessModule.runMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        state: authProvider.authSessionId,
        code: EVAL_MCP_AUTH_CODE,
      });

    expect(response.status).toBe(200);

    expect(
      await mcpAuthStoreModule.getMcpAuthSession(authProvider.authSessionId),
    ).toBeUndefined();

    const storedCredentials =
      await mcpAuthStoreModule.getMcpStoredOAuthCredentials(
        "U123",
        EVAL_MCP_AUTH_PROVIDER,
      );
    expect(storedCredentials?.tokens).toMatchObject({
      access_token: "eval-auth-access-token",
      refresh_token: "eval-auth-refresh-token",
    });

    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "what did i say about the budget?",
      expect.objectContaining({
        requester: expect.objectContaining({
          email: "stored@example.com",
          fullName: "Stored User",
          platform: "slack",
          teamId: "T123",
          userId: "U123",
          userName: "stored-user",
        }),
        destination: SLACK_DESTINATION,
        toolChannelId: "C999",
        inboundAttachmentCount: 1,
        omittedImageAttachmentCount: 1,
        artifactState: expect.objectContaining({
          assistantContextChannelId: "C999",
          lastCanvasId: "F123",
        }),
        conversationContext: expect.stringContaining(
          "You need the budget by Friday.",
        ),
      }),
    );

    const resumeContext = generateAssistantReplyMock.mock.calls[0]?.[1] as {
      conversationContext?: string;
      configuration?: Record<string, unknown>;
    };
    expect(resumeContext.conversationContext).not.toContain(
      "what did i say about the budget?",
    );
    expect(resumeContext.configuration?.region).toBe("us");

    const persistedState = await stateAdapterModule
      .getStateAdapter()
      .get<Record<string, unknown>>(`thread-state:${threadId}`);
    const conversation =
      conversationStateModule.coerceThreadConversationState(persistedState);
    const artifacts =
      artifactStateModule.coerceThreadArtifactsState(persistedState);

    expect(
      conversation.messages.find((message) => message.id === "user-1"),
    ).toMatchObject({
      meta: {
        replied: true,
      },
    });
    expect(conversation.processing.pendingAuth).toBeUndefined();
    expect(conversation.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "The budget deadline you mentioned earlier was Friday.",
    });
    expect(artifacts).toMatchObject({
      assistantContextChannelId: "C999",
      lastCanvasId: "F123",
      lastCanvasUrl: "https://example.com/canvas",
    });

    expect(getCapturedSlackApiCalls("assistant.threads.setStatus")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: "C123",
            thread_ts: "1700000000.001",
            status: expect.any(String),
            loading_messages: expect.arrayContaining([expect.any(String)]),
          }),
        }),
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: "C123",
            thread_ts: "1700000000.001",
            status: "",
          }),
        }),
      ]),
    );
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel: "C123",
            thread_ts: "1700000000.001",
            text: "The budget deadline you mentioned earlier was Friday.",
          }),
        }),
      ]),
    );
  });

  it("fails MCP OAuth resume when stored requester team mismatches destination", async () => {
    const threadId = "slack:C123:1700000000.006";
    const sessionId = "turn_user-6";

    await stateAdapterModule.getStateAdapter().set(`thread-state:${threadId}`, {
      conversation: {
        messages: [
          {
            id: "user-6",
            role: "user",
            text: "what did i say about the budget?",
            createdAtMs: 2,
            author: { userId: "U123" },
          },
        ],
        processing: {
          activeTurnId: undefined,
          pendingAuth: {
            kind: "mcp",
            provider: EVAL_MCP_AUTH_PROVIDER,
            requesterId: "U123",
            sessionId,
            linkSentAtMs: 1,
          },
        },
      },
    });
    await createAwaitingMcpTurnRecord({
      conversationId: threadId,
      requester: {
        platform: "slack",
        teamId: "T999",
        slackUserId: "U123",
      },
      sessionId,
      text: "what did i say about the budget?",
    });
    const authProvider = await createPendingAuthSession({
      conversationId: threadId,
      sessionId,
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.006",
    });

    const response =
      await mcpOauthCallbackHarnessModule.runMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        state: authProvider.authSessionId,
        code: EVAL_MCP_AUTH_CODE,
      });

    expect(response.status).toBe(200);
    expect(generateAssistantReplyMock).not.toHaveBeenCalled();
    await expect(
      turnSessionStoreModule.getAgentTurnSessionRecord(threadId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage:
        "Stored Slack requester identity did not match OAuth requester",
    });
  });

  it("rebuilds MCP OAuth resume context from state loaded under the thread lock", async () => {
    const threadId = "slack:C123:1700000000.005";
    const sessionId = "turn_user-5";
    const staleState = {
      conversation: {
        messages: [
          {
            id: "assistant-old",
            role: "assistant",
            text: "Old MCP context that should not be used.",
            createdAtMs: 1,
            author: {
              userName: "junior",
              isBot: true,
            },
          },
          {
            id: "user-5",
            role: "user",
            text: "what did i say about the budget?",
            createdAtMs: 2,
            author: {
              userId: "U123",
              userName: "dcramer",
            },
            meta: {
              slackTs: "1700000000.0051",
            },
          },
        ],
        processing: {
          activeTurnId: undefined,
          pendingAuth: {
            kind: "mcp",
            provider: EVAL_MCP_AUTH_PROVIDER,
            requesterId: "U123",
            sessionId,
            linkSentAtMs: 1,
          },
        },
      },
      artifacts: {
        assistantContextChannelId: "COLD",
      },
    };
    const freshState = {
      conversation: {
        messages: [
          {
            id: "assistant-fresh",
            role: "assistant",
            text: "Fresh MCP context loaded after the lock.",
            createdAtMs: 1,
            author: {
              userName: "junior",
              isBot: true,
            },
          },
          {
            id: "user-5",
            role: "user",
            text: "what did i say about the budget?",
            createdAtMs: 2,
            author: {
              userId: "U123",
              userName: "dcramer",
            },
            meta: {
              slackTs: "1700000000.0052",
            },
          },
        ],
        processing: {
          activeTurnId: undefined,
          pendingAuth: {
            kind: "mcp",
            provider: EVAL_MCP_AUTH_PROVIDER,
            requesterId: "U123",
            sessionId,
            linkSentAtMs: 1,
          },
        },
      },
      artifacts: {
        assistantContextChannelId: "CFRESH",
      },
    };

    const authProvider = await createPendingAuthSession({
      conversationId: threadId,
      sessionId,
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.005",
    });
    await createAwaitingMcpTurnRecord({
      conversationId: threadId,
      sessionId,
      text: "what did i say about the budget?",
    });
    await stateAdapterModule
      .getStateAdapter()
      .set(`thread-state:${threadId}`, freshState);

    const adapter = stateAdapterModule.getStateAdapter();
    const originalGet = adapter.get.bind(adapter);
    let threadReadCount = 0;
    const getSpy = vi.spyOn(adapter, "get");
    getSpy.mockImplementation((async (key: string) => {
      if (key === `thread-state:${threadId}` && threadReadCount++ === 0) {
        return structuredClone(staleState);
      }
      return await originalGet(key);
    }) as typeof adapter.get);

    try {
      const response =
        await mcpOauthCallbackHarnessModule.runMcpOauthCallbackRoute({
          provider: EVAL_MCP_AUTH_PROVIDER,
          state: authProvider.authSessionId,
          code: EVAL_MCP_AUTH_CODE,
        });

      expect(response.status).toBe(200);
    } finally {
      getSpy.mockRestore();
    }

    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "what did i say about the budget?",
      expect.objectContaining({
        destination: SLACK_DESTINATION,
        toolChannelId: "CFRESH",
        conversationContext: expect.stringContaining(
          "Fresh MCP context loaded after the lock.",
        ),
      }),
    );
    const resumeContext = generateAssistantReplyMock.mock.calls[0]?.[1] as {
      conversationContext?: string;
    };
    expect(resumeContext.conversationContext).not.toContain(
      "Old MCP context that should not be used.",
    );
    expect(getCapturedSlackApiCalls("reactions.add")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          timestamp: "1700000000.0052",
          name: "eyes",
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          timestamp: "1700000000.0052",
          name: "white_check_mark",
        }),
      }),
    ]);
  });

  it("does not resume a stale MCP-blocked request after a newer thread message", async () => {
    const sessionId = "turn_user-4";
    await turnSessionStoreModule.upsertAgentTurnSessionRecord({
      conversationId: "conversation-4",
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      piMessages: [],
      resumeReason: "auth",
      resumedFromSliceId: 1,
    });
    await stateAdapterModule
      .getStateAdapter()
      .set("thread-state:slack:C123:1700000000.004", {
        conversation: {
          messages: [
            {
              id: "user-4",
              role: "user",
              text: "what did i say about the budget?",
              createdAtMs: 1,
              author: {
                userId: "U123",
                userName: "dcramer",
              },
            },
            {
              id: "user-5",
              role: "user",
              text: "never mind, I'll handle it",
              createdAtMs: 2,
              author: {
                userId: "U123",
                userName: "dcramer",
              },
            },
          ],
          processing: {
            activeTurnId: undefined,
            pendingAuth: {
              kind: "mcp",
              provider: EVAL_MCP_AUTH_PROVIDER,
              requesterId: "U123",
              sessionId,
              linkSentAtMs: 1,
            },
          },
        },
      });

    const authProvider = await createPendingAuthSession({
      conversationId: "conversation-4",
      sessionId,
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.004",
    });

    const response =
      await mcpOauthCallbackHarnessModule.runMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        state: authProvider.authSessionId,
        code: EVAL_MCP_AUTH_CODE,
      });

    expect(response.status).toBe(200);
    expect(generateAssistantReplyMock).not.toHaveBeenCalled();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);

    const persistedState = await stateAdapterModule
      .getStateAdapter()
      .get<Record<string, unknown>>("thread-state:slack:C123:1700000000.004");
    const conversation =
      conversationStateModule.coerceThreadConversationState(persistedState);
    expect(conversation.processing.pendingAuth).toBeUndefined();

    const sessionRecord =
      await turnSessionStoreModule.getAgentTurnSessionRecord(
        "conversation-4",
        sessionId,
      );
    expect(sessionRecord?.state).toBe("abandoned");
  });

  it("does not resume MCP OAuth without an awaiting turn-session record", async () => {
    const sessionId = "turn_missing_record";
    await stateAdapterModule
      .getStateAdapter()
      .set("thread-state:slack:C123:1700000000.006", {
        conversation: {
          messages: [
            {
              id: "user-6",
              role: "user",
              text: "list mcp data",
              createdAtMs: 1,
              author: {
                userId: "U123",
                userName: "dcramer",
              },
            },
          ],
          processing: {
            activeTurnId: undefined,
            pendingAuth: {
              kind: "mcp",
              provider: EVAL_MCP_AUTH_PROVIDER,
              requesterId: "U123",
              sessionId,
              linkSentAtMs: 1,
            },
          },
        },
      });

    const authProvider = await createPendingAuthSession({
      conversationId: "conversation-missing-record",
      sessionId,
      userMessage: "list mcp data",
      channelId: "C123",
      threadTs: "1700000000.006",
    });

    const response =
      await mcpOauthCallbackHarnessModule.runMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        state: authProvider.authSessionId,
        code: EVAL_MCP_AUTH_CODE,
      });

    expect(response.status).toBe(200);
    expect(generateAssistantReplyMock).not.toHaveBeenCalled();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
  });

  it("does not resume MCP OAuth with a mismatched stored requester", async () => {
    const sessionId = "turn_user-7";
    await stateAdapterModule
      .getStateAdapter()
      .set("thread-state:slack:C123:1700000000.007", {
        conversation: {
          messages: [
            {
              id: "user-7",
              role: "user",
              text: "list mcp data",
              createdAtMs: 1,
              author: {
                userId: "U123",
                userName: "dcramer",
              },
            },
          ],
          processing: {
            activeTurnId: undefined,
            pendingAuth: {
              kind: "mcp",
              provider: EVAL_MCP_AUTH_PROVIDER,
              requesterId: "U123",
              sessionId,
              linkSentAtMs: 1,
            },
          },
        },
      });
    await createAwaitingMcpTurnRecord({
      conversationId: "conversation-mismatched-requester",
      requester: {
        slackUserId: "U999",
        slackUserName: "wrong-user",
      },
      sessionId,
      text: "list mcp data",
    });

    const authProvider = await createPendingAuthSession({
      conversationId: "conversation-mismatched-requester",
      sessionId,
      userMessage: "list mcp data",
      channelId: "C123",
      threadTs: "1700000000.007",
    });

    const response =
      await mcpOauthCallbackHarnessModule.runMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        state: authProvider.authSessionId,
        code: EVAL_MCP_AUTH_CODE,
      });

    expect(response.status).toBe(200);
    expect(generateAssistantReplyMock).not.toHaveBeenCalled();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    await expect(
      turnSessionStoreModule.getAgentTurnSessionRecord(
        "conversation-mismatched-requester",
        sessionId,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage:
        "Stored Slack requester identity did not match OAuth requester",
    });
  });

  it("uploads resumed reply files without posting an extra thread message for empty inline text", async () => {
    generateAssistantReplyMock.mockResolvedValueOnce({
      text: "",
      files: [
        {
          data: Buffer.from("hello"),
          filename: "resume.txt",
        },
      ],
      deliveryPlan: {
        mode: "thread",
        postThreadText: true,
        attachFiles: "inline",
      },
      diagnostics: {
        outcome: "success",
        toolCalls: [],
      },
    });
    await stateAdapterModule
      .getStateAdapter()
      .set("thread-state:slack:C123:1700000000.002", {
        conversation: {
          messages: [
            {
              id: "msg.2",
              role: "user",
              text: "/demo upload",
              createdAtMs: 1,
              author: {
                userId: "U123",
                userName: "dcramer",
              },
            },
          ],
          processing: {
            activeTurnId: undefined,
            pendingAuth: {
              kind: "mcp",
              provider: EVAL_MCP_AUTH_PROVIDER,
              requesterId: "U123",
              sessionId: "turn_msg_2",
              linkSentAtMs: 1,
            },
          },
        },
      });
    await createAwaitingMcpTurnRecord({
      conversationId: "conversation-2",
      sessionId: "turn_msg_2",
      text: "/demo upload",
    });

    const authProvider = await createPendingAuthSession({
      conversationId: "conversation-2",
      sessionId: "turn_msg_2",
      userMessage: "/demo upload",
      channelId: "C123",
      threadTs: "1700000000.002",
    });

    const response =
      await mcpOauthCallbackHarnessModule.runMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        state: authProvider.authSessionId,
        code: EVAL_MCP_AUTH_CODE,
      });

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("files.getUploadURLExternal")).toHaveLength(
      1,
    );
    expect(getCapturedSlackApiCalls("files.completeUploadExternal")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.002",
        }),
      }),
    ]);
    expect(getCapturedSlackFileUploadCalls()).toHaveLength(1);
  });

  it("uploads resumed reply files even when thread text delivery is suppressed", async () => {
    generateAssistantReplyMock.mockResolvedValueOnce({
      text: "👍",
      files: [
        {
          data: Buffer.from("hello"),
          filename: "resume.txt",
        },
      ],
      deliveryPlan: {
        mode: "thread",
        postThreadText: false,
        attachFiles: "inline",
      },
      diagnostics: {
        outcome: "success",
        toolCalls: [],
      },
    });
    await stateAdapterModule
      .getStateAdapter()
      .set("thread-state:slack:C123:1700000000.003", {
        conversation: {
          messages: [
            {
              id: "msg.3",
              role: "user",
              text: "/demo upload",
              createdAtMs: 1,
              author: {
                userId: "U123",
                userName: "dcramer",
              },
            },
          ],
          processing: {
            activeTurnId: undefined,
            pendingAuth: {
              kind: "mcp",
              provider: EVAL_MCP_AUTH_PROVIDER,
              requesterId: "U123",
              sessionId: "turn_msg_3",
              linkSentAtMs: 1,
            },
          },
        },
      });
    await createAwaitingMcpTurnRecord({
      conversationId: "conversation-3",
      sessionId: "turn_msg_3",
      text: "/demo upload",
    });

    const authProvider = await createPendingAuthSession({
      conversationId: "conversation-3",
      sessionId: "turn_msg_3",
      userMessage: "/demo upload",
      channelId: "C123",
      threadTs: "1700000000.003",
    });

    const response =
      await mcpOauthCallbackHarnessModule.runMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        state: authProvider.authSessionId,
        code: EVAL_MCP_AUTH_CODE,
      });

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("files.getUploadURLExternal")).toHaveLength(
      1,
    );
    expect(getCapturedSlackApiCalls("files.completeUploadExternal")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.003",
        }),
      }),
    ]);
    expect(getCapturedSlackFileUploadCalls()).toHaveLength(1);
  });
});
