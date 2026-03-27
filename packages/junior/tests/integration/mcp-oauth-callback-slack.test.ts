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

type ArtifactStateModule = typeof import("@/chat/state/artifacts");
type ConversationStateModule = typeof import("@/chat/state/conversation");
type McpAuthStoreModule = typeof import("@/chat/mcp/auth-store");
type McpClientModule = typeof import("@/chat/mcp/client");
type McpOauthModule = typeof import("@/chat/mcp/oauth");
type McpOauthCallbackHarnessModule =
  typeof import("../fixtures/mcp-oauth-callback-harness");
type PluginRegistryModule = typeof import("@/chat/plugins/registry");
type StateAdapterModule = typeof import("@/chat/state/adapter");

let artifactStateModule: ArtifactStateModule;
let conversationStateModule: ConversationStateModule;
let mcpAuthStoreModule: McpAuthStoreModule;
let mcpClientModule: McpClientModule;
let mcpOauthModule: McpOauthModule;
let mcpOauthCallbackHarnessModule: McpOauthCallbackHarnessModule;
let pluginRegistryModule: PluginRegistryModule;
let stateAdapterModule: StateAdapterModule;

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
      JUNIOR_EXTRA_PLUGIN_ROOTS: JSON.stringify([EVAL_MCP_PLUGIN_ROOT]),
    };

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

    await stateAdapterModule.disconnectStateAdapter();
    await stateAdapterModule.getStateAdapter().connect();
  });

  afterEach(async () => {
    await stateAdapterModule.disconnectStateAdapter();
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
          },
        ],
        processing: {
          activeTurnId: sessionId,
        },
      },
      artifacts: {
        assistantContextChannelId: "C999",
        lastCanvasId: "F123",
      },
    });

    const authProvider = await mcpOauthModule.createMcpOAuthClientProvider({
      provider: EVAL_MCP_AUTH_PROVIDER,
      conversationId: "conversation-1",
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
        requester: { userId: "U123" },
        toolChannelId: "C999",
        artifactState: {
          assistantContextChannelId: "C999",
          lastCanvasId: "F123",
        },
        configuration: {
          region: "us",
        },
        conversationContext: expect.stringContaining(
          "You need the budget by Friday.",
        ),
      }),
    );

    const resumeContext = generateAssistantReplyMock.mock.calls[0]?.[1] as {
      conversationContext?: string;
    };
    expect(resumeContext.conversationContext).not.toContain(
      "what did i say about the budget?",
    );

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
            status: "Thinking...",
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
            text: "Your eval-auth MCP access is now connected. Continuing the original request...",
          }),
        }),
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
});
