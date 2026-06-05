import path from "node:path";
import { vi } from "vitest";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";
import { createPluginAppFixture, type PluginAppFixture } from "./plugin-app";
import { successfulAssistantReply } from "./assistant-reply";
import type { ResumeReplyGenerator } from "@/chat/runtime/slack-resume";

export const EVAL_OAUTH_PROVIDER = "eval-oauth";
export const EVAL_OAUTH_CODE = "eval-oauth-code";
export const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

const ORIGINAL_ENV = { ...process.env };
const EVAL_OAUTH_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "plugins/eval-oauth",
);

type StateAdapterModule = typeof import("@/chat/state/adapter");
type OAuthCallbackHarnessModule = typeof import("./oauth-callback-harness");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");
type UserTokenStoreModule = typeof import("@/chat/capabilities/factory");

/** Starts the memory-backed OAuth callback route integration fixture. */
export async function createOauthCallbackRouteFixture() {
  const generateAssistantReplyMock = vi.fn<ResumeReplyGenerator>();
  generateAssistantReplyMock.mockResolvedValue(
    successfulAssistantReply("Here are your Sentry issues."),
  );
  resetSlackApiMockState();
  process.env = {
    ...ORIGINAL_ENV,
    JUNIOR_STATE_ADAPTER: "memory",
    JUNIOR_BASE_URL: "https://junior.example.com",
  };
  let pluginApp: PluginAppFixture | undefined = await createPluginAppFixture([
    EVAL_OAUTH_PLUGIN_ROOT,
  ]);

  vi.resetModules();
  const stateAdapter: StateAdapterModule = await import("@/chat/state/adapter");
  const oauthCallbackHarness: OAuthCallbackHarnessModule =
    await import("./oauth-callback-harness");
  const turnSessionStore: TurnSessionStoreModule =
    await import("@/chat/state/turn-session");
  const userTokenStore: UserTokenStoreModule =
    await import("@/chat/capabilities/factory");
  await stateAdapter.disconnectStateAdapter();
  await stateAdapter.getStateAdapter().connect();

  return {
    generateAssistantReplyMock,
    stateAdapter,
    turnSessionStore,

    /** Runs the OAuth callback route with the fixture resume generator. */
    async runRoute(args: {
      state: string;
      provider?: string;
      code?: string;
    }): Promise<Response> {
      return await oauthCallbackHarness.runOauthCallbackRoute({
        provider: args.provider ?? EVAL_OAUTH_PROVIDER,
        state: args.state,
        code: args.code ?? EVAL_OAUTH_CODE,
        generateReply: generateAssistantReplyMock,
      });
    },

    /** Runs an explicit OAuth callback URL through the real handler. */
    async runCallbackUrl(args: {
      provider?: string;
      url: string;
    }): Promise<Response> {
      const provider = args.provider ?? EVAL_OAUTH_PROVIDER;
      return await oauthCallbackHarness.runOauthCallbackRequest({
        provider,
        request: new Request(args.url, { method: "GET" }),
        generateReply: generateAssistantReplyMock,
      });
    },

    /** Stores the awaiting turn-session record needed for OAuth resume. */
    async createAwaitingOauthTurnRecord(args: {
      conversationId: string;
      sessionId: string;
      text?: string;
    }) {
      await turnSessionStore.upsertAgentTurnSessionRecord({
        conversationId: args.conversationId,
        sessionId: args.sessionId,
        sliceId: 2,
        state: "awaiting_resume",
        destination: SLACK_DESTINATION,
        piMessages: args.text
          ? [
              {
                role: "user",
                content: [{ type: "text", text: args.text }],
                timestamp: 1,
              },
            ]
          : [],
        resumeReason: "auth",
        resumedFromSliceId: 1,
      });
    },

    /** Stores provider OAuth callback state in the memory adapter. */
    async storeOAuthState(
      state: string,
      overrides: Record<string, unknown> = {},
    ) {
      const destination =
        overrides.destination ??
        (typeof overrides.channelId === "string"
          ? { ...SLACK_DESTINATION, channelId: overrides.channelId }
          : undefined);
      await stateAdapter.getStateAdapter().set(`oauth-state:${state}`, {
        userId: "U123",
        provider: EVAL_OAUTH_PROVIDER,
        ...(destination ? { destination } : {}),
        ...overrides,
      });
    },

    /** Reads a raw OAuth state record from the memory adapter. */
    async getOAuthState<T = unknown>(state: string): Promise<T | null> {
      return await stateAdapter
        .getStateAdapter()
        .get<T>(`oauth-state:${state}`);
    },

    /** Reads the stored provider token for a fixture user. */
    async getStoredToken(
      args: {
        provider?: string;
        userId?: string;
      } = {},
    ) {
      return await userTokenStore
        .createUserTokenStore()
        .get(args.userId ?? "U123", args.provider ?? EVAL_OAUTH_PROVIDER);
    },

    /** Disconnects memory state, plugin fixtures, and test environment. */
    async cleanup() {
      await stateAdapter.disconnectStateAdapter();
      await pluginApp?.cleanup();
      pluginApp = undefined;
      process.env = { ...ORIGINAL_ENV };
    },
  };
}
