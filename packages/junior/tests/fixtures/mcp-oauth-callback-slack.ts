import path from "node:path";
import { expect, vi } from "vitest";
import {
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTH_PROVIDER,
} from "../msw/handlers/eval-mcp-auth";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";
import { createPluginAppFixture, type PluginAppFixture } from "./plugin-app";
import { successfulAssistantReply } from "./assistant-reply";
import type { ResumeReplyGenerator } from "@/chat/runtime/slack-resume";

const ORIGINAL_ENV = { ...process.env };
const EVAL_MCP_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "plugins/eval-auth",
);

export const SLACK_DESTINATION = {
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
  typeof import("./mcp-oauth-callback-harness");
type PluginRegistryModule = typeof import("@/chat/plugins/registry");
type StateAdapterModule = typeof import("@/chat/state/adapter");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");

/** Starts the memory-backed Slack MCP OAuth callback integration fixture. */
export async function createMcpOauthCallbackSlackFixture() {
  const generateAssistantReplyMock = vi.fn<ResumeReplyGenerator>();
  generateAssistantReplyMock.mockResolvedValue(
    successfulAssistantReply(
      "The budget deadline you mentioned earlier was Friday.",
      {
        artifactStatePatch: {
          lastCanvasUrl: "https://example.com/canvas",
        },
        sandboxId: "sandbox-1",
        sandboxDependencyProfileHash: "hash-1",
      },
    ),
  );
  resetSlackApiMockState();
  process.env = {
    ...ORIGINAL_ENV,
    JUNIOR_STATE_ADAPTER: "memory",
    JUNIOR_BASE_URL: "https://junior.example.com",
  };
  let pluginApp: PluginAppFixture | undefined = await createPluginAppFixture([
    EVAL_MCP_PLUGIN_ROOT,
  ]);

  vi.resetModules();
  const artifactState: ArtifactStateModule =
    await import("@/chat/state/artifacts");
  const conversationState: ConversationStateModule =
    await import("@/chat/state/conversation");
  const mcpAuthStore: McpAuthStoreModule =
    await import("@/chat/mcp/auth-store");
  const mcpClient: McpClientModule = await import("@/chat/mcp/client");
  const mcpOauth: McpOauthModule = await import("@/chat/mcp/oauth");
  const mcpOauthCallbackHarness: McpOauthCallbackHarnessModule =
    await import("./mcp-oauth-callback-harness");
  const pluginRegistry: PluginRegistryModule =
    await import("@/chat/plugins/registry");
  const stateAdapter: StateAdapterModule = await import("@/chat/state/adapter");
  const turnSessionStore: TurnSessionStoreModule =
    await import("@/chat/state/turn-session");

  await stateAdapter.disconnectStateAdapter();
  await stateAdapter.getStateAdapter().connect();

  return {
    artifactState,
    conversationState,
    generateAssistantReplyMock,
    mcpAuthStore,
    stateAdapter,
    turnSessionStore,

    /** Runs the MCP OAuth callback route with the fixture resume generator. */
    async runRoute(args: { provider: string; state: string; code: string }) {
      return await mcpOauthCallbackHarness.runMcpOauthCallbackRoute({
        ...args,
        generateReply: generateAssistantReplyMock,
      });
    },

    /** Creates a pending MCP auth session by driving the real MCP client. */
    async createPendingAuthSession(args: {
      conversationId: string;
      sessionId: string;
      userMessage: string;
      channelId: string;
      threadTs: string;
      toolChannelId?: string;
      configuration?: Record<string, unknown>;
      artifactState?: Record<string, unknown>;
    }) {
      const authProvider = await mcpOauth.createMcpOAuthClientProvider({
        provider: EVAL_MCP_AUTH_PROVIDER,
        conversationId: args.conversationId,
        destination: SLACK_DESTINATION,
        sessionId: args.sessionId,
        userId: "U123",
        userMessage: args.userMessage,
        channelId: args.channelId,
        threadTs: args.threadTs,
        ...(args.toolChannelId ? { toolChannelId: args.toolChannelId } : {}),
        ...(args.configuration ? { configuration: args.configuration } : {}),
        ...(args.artifactState ? { artifactState: args.artifactState } : {}),
      });

      const plugin = pluginRegistry.getPluginDefinition(EVAL_MCP_AUTH_PROVIDER);
      expect(plugin).toBeDefined();

      const client = new mcpClient.PluginMcpClient(plugin!, {
        authProvider,
      });
      await expect(client.listTools()).rejects.toBeInstanceOf(
        mcpClient.McpAuthorizationRequiredError,
      );
      await client.close();

      return authProvider;
    },

    /** Stores the awaiting turn-session record needed for OAuth resume. */
    async createAwaitingMcpTurnRecord(args: {
      conversationId: string;
      sessionId: string;
      text: string;
    }) {
      await turnSessionStore.upsertAgentTurnSessionRecord({
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
        resumeReason: "auth",
        resumedFromSliceId: 1,
      });
    },

    /** Stores a one-message thread state with pending MCP authorization. */
    async storePendingMcpThreadState(args: {
      threadId: string;
      messageId: string;
      text: string;
      sessionId: string;
    }) {
      await stateAdapter
        .getStateAdapter()
        .set(`thread-state:${args.threadId}`, {
          conversation: {
            messages: [
              {
                id: args.messageId,
                role: "user",
                text: args.text,
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
                sessionId: args.sessionId,
                linkSentAtMs: 1,
              },
            },
          },
        });
    },

    /** Cleans up state, plugin fixtures, and environment after each scenario. */
    async cleanup() {
      await stateAdapter.disconnectStateAdapter();
      await pluginApp?.cleanup();
      pluginApp = undefined;
      process.env = { ...ORIGINAL_ENV };
    },
  };
}

export { EVAL_MCP_AUTH_CODE, EVAL_MCP_AUTH_PROVIDER };
