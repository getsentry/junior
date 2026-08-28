import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalSource,
  createSlackSource,
  type Actor,
  type Source,
} from "@sentry/junior-plugin-api";
import { EVAL_MCP_AUTH_PROVIDER } from "../msw/handlers/eval-mcp-auth";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";
import type { AgentRun } from "@/chat/agent/types";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  createModelAgentRunnerForRun,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/messages";
import {
  coerceThreadConversationState,
  type ConversationMessage,
} from "@/chat/state/conversation";

/** Mirror a just-seeded thread-state transcript into SQL (durable authority). */
async function seedVisibleTranscriptFromThreadState(
  adapter: { get<T>(key: string): Promise<T | null | undefined> },
  conversationId: string,
): Promise<void> {
  const raw = await adapter.get<{
    conversation?: { messages?: ConversationMessage[] };
  }>(`thread-state:${conversationId}`);
  const messages = raw?.conversation?.messages ?? [];
  if (messages.length === 0) {
    return;
  }
  const conversation = coerceThreadConversationState({});
  conversation.messages.push(...messages);
  await persistConversationMessages({ conversation, conversationId });
}

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

function slackSource(threadTs: string) {
  return createSlackSource({
    teamId: SLACK_DESTINATION.teamId,
    channelId: SLACK_DESTINATION.channelId,
    threadTs,

    visibility: "private",
  });
}

type ConversationStateModule = typeof import("@/chat/state/conversation");
type McpAuthStoreModule = typeof import("@/chat/mcp/auth-store");
type McpClientModule = typeof import("@/chat/mcp/client");
type McpOauthModule = typeof import("@/chat/mcp/oauth");
type McpOauthCallbackHarnessModule =
  typeof import("../fixtures/mcp-oauth-callback-harness");
type PluginCatalogRuntimeModule =
  typeof import("@/chat/plugins/catalog-runtime");
type StateAdapterModule = typeof import("@/chat/state/adapter");
type TurnSessionStoreModule =
  typeof import("@/chat/task-execution/turn-cursor");

let conversationStateModule: ConversationStateModule;
let mcpAuthStoreModule: McpAuthStoreModule;
let mcpClientModule: McpClientModule;
let mcpOauthModule: McpOauthModule;
let mcpOauthCallbackHarnessModule: McpOauthCallbackHarnessModule;
let pluginCatalogRuntimeModule: PluginCatalogRuntimeModule;
let stateAdapterModule: StateAdapterModule;
let turnSessionStoreModule: TurnSessionStoreModule;
let pluginApp: PluginAppFixture | undefined;
let agentRunner: AgentRunner;
let agentRuns: AgentRun[];

async function bindPendingAuthAttempt(args: {
  authSessionId: string;
  channelId: string;
  threadTs: string;
}) {
  const key = `thread-state:slack:${args.channelId}:${args.threadTs}`;
  const state = await stateAdapterModule
    .getStateAdapter()
    .get<Record<string, unknown>>(key);
  const conversation = state?.conversation as
    | { processing?: { pendingAuth?: Record<string, unknown> } }
    | undefined;
  const pendingAuth = conversation?.processing?.pendingAuth;
  if (!state || !pendingAuth) {
    return;
  }
  pendingAuth.authSessionId = args.authSessionId;
  await stateAdapterModule.getStateAdapter().set(key, state);
}

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
    source: slackSource(args.threadTs),
  });

  const plugin = pluginCatalogRuntimeModule.pluginCatalogRuntime.getDefinition(
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
  await bindPendingAuthAttempt({
    authSessionId: authProvider.authSessionId,
    channelId: args.channelId,
    threadTs: args.threadTs,
  });

  return authProvider;
}

async function createAwaitingMcpTurnRecord(args: {
  conversationId: string;
  actor?: Actor;
  includeSource?: boolean;
  turnId: string;
  source?: Source;
  text: string;
  threadTs: string;
}) {
  await turnSessionStoreModule.upsertTurnRecord({
    conversationId: args.conversationId,
    turnId: args.turnId,
    sliceId: 2,
    state: "paused",
    destination: SLACK_DESTINATION,
    destinationVisibility: "public",
    ...(args.includeSource === false
      ? undefined
      : { source: args.source ?? slackSource(args.threadTs) }),
    piMessages: [
      {
        role: "user",
        content: [{ type: "text", text: args.text }],
        timestamp: 1,
      },
    ],
    actor: args.actor ?? {
      platform: "slack",
      teamId: SLACK_DESTINATION.teamId,
      userId: "U123",
      userName: "dcramer",
    },
    resumeReason: "auth",
    resumedFromSliceId: 1,
  });
}

describe("mcp oauth callback integration", () => {
  beforeEach(async () => {
    agentRuns = [];
    agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([
        {
          type: "text",
          text: "The budget deadline you mentioned earlier was Friday.",
        },
      ]);
    });
    resetSlackApiMockState();
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_SECRET: "test-secret",
    };
    pluginApp = await createPluginAppFixture([EVAL_MCP_PLUGIN_ROOT]);

    vi.resetModules();
    conversationStateModule = await import("@/chat/state/conversation");
    mcpAuthStoreModule = await import("@/chat/mcp/auth-store");
    mcpClientModule = await import("@/chat/mcp/client");
    mcpOauthModule = await import("@/chat/mcp/oauth");
    mcpOauthCallbackHarnessModule =
      await import("../fixtures/mcp-oauth-callback-harness");
    pluginCatalogRuntimeModule = await import("@/chat/plugins/catalog-runtime");
    stateAdapterModule = await import("@/chat/state/adapter");
    turnSessionStoreModule = await import("@/chat/task-execution/turn-cursor");

    await stateAdapterModule.disconnectStateAdapter();
    await stateAdapterModule.getStateAdapter().connect();
  });

  afterEach(async () => {
    await stateAdapterModule?.disconnectStateAdapter();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    process.env = { ...ORIGINAL_ENV };
  });

  it("finalizes local MCP OAuth without attempting Slack resume", async () => {
    const conversationId = "local:oauth:mcp-callback";
    const sessionId = "local-turn-mcp-oauth";
    const destination = { platform: "local", conversationId } as const;
    const authProvider = await mcpOauthModule.createMcpOAuthClientProvider({
      provider: EVAL_MCP_AUTH_PROVIDER,
      conversationId,
      destination,
      sessionId,
      userId: "local-cli",
      userMessage: "list my projects",
      createAuthorizationState: async () => "local-mcp-oauth-state",
      source: createLocalSource(conversationId),
    });
    const plugin =
      pluginCatalogRuntimeModule.pluginCatalogRuntime.getDefinition(
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
    await stateAdapterModule
      .getStateAdapter()
      .set(`thread-state:${conversationId}`, {
        conversation: {
          messages: [],
          processing: {
            pendingAuth: {
              authSessionId: authProvider.authSessionId,
              kind: "mcp",
              provider: EVAL_MCP_AUTH_PROVIDER,
              actorId: "local-cli",
              sessionId,
              linkSentAtMs: Date.now(),
            },
          },
        },
      });

    const response =
      await mcpOauthCallbackHarnessModule.completeMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        authSessionId: authProvider.authSessionId,
        agentRunner: neverRunAgentRunner(),
        expectBackgroundWork: false,
        relayed: true,
      });

    expect(response.status).toBe(200);
    await expect(
      mcpAuthStoreModule.getMcpStoredOAuthCredentials(
        "local-cli",
        EVAL_MCP_AUTH_PROVIDER,
      ),
    ).resolves.toMatchObject({
      tokens: expect.objectContaining({ access_token: expect.any(String) }),
    });
  });

  it("finalizes MCP OAuth and resumes the stored thread with persisted context", async () => {
    const threadId = "slack:C123:1700000000.001";
    const sessionId = "turn_user-1";
    // Resume loads SQL sessionSource, which drops per-message timestamps.
    const storedSource = createSlackSource({
      teamId: "T123",
      channelId: "C123",
      threadTs: "1700000000.001",
      visibility: "private",
    });

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
            actorId: "U123",
            sessionId,
            linkSentAtMs: 1,
          },
        },
      },
    });
    await seedVisibleTranscriptFromThreadState(
      stateAdapterModule.getStateAdapter(),
      threadId,
    );
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
      conversationId: threadId,
      actor: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
        userName: "stored-user",
        fullName: "Stored User",
        email: "stored@example.com",
      },
      turnId: sessionId,
      source: storedSource,
      text: "what did i say about the budget?",
      threadTs: "1700000000.001",
    });

    const authProvider = await mcpOauthModule.createMcpOAuthClientProvider({
      provider: EVAL_MCP_AUTH_PROVIDER,
      conversationId: threadId,
      destination: SLACK_DESTINATION,
      sessionId,
      userId: "U123",
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.001",
      source: storedSource,
      toolChannelId: "C123",
      configuration: {
        region: "us",
      },
    });

    const plugin =
      pluginCatalogRuntimeModule.pluginCatalogRuntime.getDefinition(
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
    await bindPendingAuthAttempt({
      authSessionId: authProvider.authSessionId,
      channelId: "C123",
      threadTs: "1700000000.001",
    });

    const pendingSession = await mcpAuthStoreModule.getMcpAuthSession(
      authProvider.authSessionId,
    );
    expect(pendingSession).toMatchObject({
      authSessionId: authProvider.authSessionId,
      provider: EVAL_MCP_AUTH_PROVIDER,
      userId: "U123",
      conversationId: threadId,
      destination: SLACK_DESTINATION,
      sessionId,
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.001",
      source: storedSource,
      toolChannelId: "C123",
      configuration: {
        region: "us",
      },
      authorizationUrl: expect.stringContaining(
        "https://eval-auth.example.test/oauth/authorize",
      ),
      codeVerifier: expect.any(String),
    });

    const repeatedProvider = await mcpOauthModule.createMcpOAuthClientProvider({
      provider: EVAL_MCP_AUTH_PROVIDER,
      conversationId: threadId,
      destination: SLACK_DESTINATION,
      sessionId,
      userId: "U123",
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.001",
      source: storedSource,
    });
    const repeatedClient = new mcpClientModule.PluginMcpClient(plugin!, {
      authProvider: repeatedProvider,
    });
    await expect(repeatedClient.listTools()).rejects.toBeInstanceOf(
      mcpClientModule.McpAuthorizationRequiredError,
    );
    await repeatedClient.close();

    expect(repeatedProvider.authSessionId).not.toBe(authProvider.authSessionId);
    await expect(
      mcpAuthStoreModule.getMcpAuthSession(authProvider.authSessionId),
    ).resolves.toMatchObject({
      codeVerifier: pendingSession?.codeVerifier,
      authorizationUrl: pendingSession?.authorizationUrl,
    });
    await mcpAuthStoreModule.deleteMcpAuthSession(
      repeatedProvider.authSessionId,
    );

    const response =
      await mcpOauthCallbackHarnessModule.completeMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        authSessionId: authProvider.authSessionId,
        agentRunner,
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

    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toEqual(
      expect.objectContaining({
        instruction: expect.objectContaining({
          text: "what did i say about the budget?",
          inboundAttachmentCount: 1,
          omittedImageAttachmentCount: 1,
          context: expect.stringContaining("You need the budget by Friday."),
        }),
        actor: {
          platform: "slack",
          teamId: "T123",
          userId: "U123",
        },
        destination: SLACK_DESTINATION,
        location: expect.objectContaining({
          provider: "slack",
          teamId: "T123",
          channelId: "C123",
        }),
        source: storedSource,
        toolChannelId: "C123",
        state: expect.objectContaining({}),
      }),
    );

    const resumeContext = agentRuns[0]!;
    expect(resumeContext.instruction.context).not.toContain(
      "what did i say about the budget?",
    );
    expect(resumeContext.environment?.configuration?.region).toBe("us");

    const persistedState = await stateAdapterModule
      .getStateAdapter()
      .get<Record<string, unknown>>(`thread-state:${threadId}`);
    const conversation =
      conversationStateModule.coerceThreadConversationState(persistedState);
    await hydrateConversationMessages({
      conversation,
      conversationId: threadId,
    });
    expect(
      conversation.messages.find((message) => message.id === "user-1"),
    ).toMatchObject({
      meta: {
        replied: true,
      },
    });
    expect(conversation.processing.pendingAuth).toBeUndefined();
    expect(
      conversation.messages.find(
        (message) =>
          message.role === "assistant" &&
          message.text ===
            "The budget deadline you mentioned earlier was Friday.",
      ),
    ).toMatchObject({
      role: "assistant",
      text: "The budget deadline you mentioned earlier was Friday.",
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
            authSessionId: "pending-auth-session",
            kind: "mcp",
            provider: EVAL_MCP_AUTH_PROVIDER,
            actorId: "U123",
            sessionId,
            linkSentAtMs: 1,
          },
        },
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
            authSessionId: "pending-auth-session",
            kind: "mcp",
            provider: EVAL_MCP_AUTH_PROVIDER,
            actorId: "U123",
            sessionId,
            linkSentAtMs: 1,
          },
        },
      },
    };

    const authProvider = await createPendingAuthSession({
      conversationId: threadId,
      sessionId,
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.005",
    });
    staleState.conversation.processing.pendingAuth.authSessionId =
      authProvider.authSessionId;
    freshState.conversation.processing.pendingAuth.authSessionId =
      authProvider.authSessionId;
    await createAwaitingMcpTurnRecord({
      conversationId: threadId,
      turnId: sessionId,
      source: slackSource("1700000000.005"),
      text: "what did i say about the budget?",
      threadTs: "1700000000.005",
    });
    await stateAdapterModule
      .getStateAdapter()
      .set(`thread-state:${threadId}`, freshState);
    await seedVisibleTranscriptFromThreadState(
      stateAdapterModule.getStateAdapter(),
      threadId,
    );

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
        await mcpOauthCallbackHarnessModule.completeMcpOauthCallbackRoute({
          provider: EVAL_MCP_AUTH_PROVIDER,
          authSessionId: authProvider.authSessionId,
          agentRunner,
        });

      expect(response.status).toBe(200);
    } finally {
      getSpy.mockRestore();
    }

    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toEqual(
      expect.objectContaining({
        instruction: expect.objectContaining({
          text: "what did i say about the budget?",
          context: expect.stringContaining(
            "Fresh MCP context loaded after the lock.",
          ),
        }),
        destination: SLACK_DESTINATION,
        toolChannelId: "C123",
      }),
    );
    const resumeContext = agentRuns[0]!;
    expect(resumeContext.source).toEqual(slackSource("1700000000.005"));
    expect(resumeContext.instruction.context).not.toContain(
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
    await turnSessionStoreModule.upsertTurnRecord({
      conversationId: "conversation-4",
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
      destination: SLACK_DESTINATION,
      source: slackSource("1700000000.004"),
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
              actorId: "U123",
              sessionId,
              linkSentAtMs: 1,
            },
          },
        },
      });
    await seedVisibleTranscriptFromThreadState(
      stateAdapterModule.getStateAdapter(),
      "slack:C123:1700000000.004",
    );

    const authProvider = await createPendingAuthSession({
      conversationId: "conversation-4",
      sessionId,
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.004",
    });

    const response =
      await mcpOauthCallbackHarnessModule.completeMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        authSessionId: authProvider.authSessionId,
        agentRunner: neverRunAgentRunner(),
      });

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);

    const persistedState = await stateAdapterModule
      .getStateAdapter()
      .get<Record<string, unknown>>("thread-state:slack:C123:1700000000.004");
    const conversation =
      conversationStateModule.coerceThreadConversationState(persistedState);
    expect(conversation.processing.pendingAuth).toBeUndefined();

    const sessionRecord = await turnSessionStoreModule.getTurnRecord(
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
              actorId: "U123",
              sessionId,
              linkSentAtMs: 1,
            },
          },
        },
      });
    await seedVisibleTranscriptFromThreadState(
      stateAdapterModule.getStateAdapter(),
      "slack:C123:1700000000.006",
    );

    const authProvider = await createPendingAuthSession({
      conversationId: "conversation-missing-record",
      sessionId,
      userMessage: "list mcp data",
      channelId: "C123",
      threadTs: "1700000000.006",
    });

    const response =
      await mcpOauthCallbackHarnessModule.completeMcpOauthCallbackRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        authSessionId: authProvider.authSessionId,
        agentRunner: neverRunAgentRunner(),
      });

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
  });
});
