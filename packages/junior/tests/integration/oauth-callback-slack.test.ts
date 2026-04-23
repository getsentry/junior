import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const EVAL_OAUTH_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-oauth",
);

type StateAdapterModule = typeof import("@/chat/state/adapter");
type OAuthCallbackHarnessModule =
  typeof import("../fixtures/oauth-callback-harness");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session-store");

let stateAdapterModule: StateAdapterModule;
let oauthCallbackHarnessModule: OAuthCallbackHarnessModule;
let turnSessionStoreModule: TurnSessionStoreModule;

describe("oauth callback slack integration", () => {
  beforeEach(async () => {
    generateAssistantReplyMock.mockReset();
    generateAssistantReplyMock.mockResolvedValue({
      text: "Here are your Sentry issues.",
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
      JUNIOR_EXTRA_PLUGIN_ROOTS: JSON.stringify([EVAL_OAUTH_PLUGIN_ROOT]),
    };
    vi.resetModules();
    stateAdapterModule = await import("@/chat/state/adapter");
    oauthCallbackHarnessModule =
      await import("../fixtures/oauth-callback-harness");
    turnSessionStoreModule = await import("@/chat/state/turn-session-store");
    await stateAdapterModule.disconnectStateAdapter();
    await stateAdapterModule.getStateAdapter().connect();
  });

  afterEach(async () => {
    await stateAdapterModule.disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
  });

  it("publishes app home through the Slack MSW harness after generic OAuth callback", async () => {
    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-state", {
        userId: "U123",
        provider: "eval-oauth",
      });

    const response = await oauthCallbackHarnessModule.runOauthCallbackRoute({
      provider: "eval-oauth",
      state: "eval-oauth-state",
      code: "eval-oauth-code",
    });

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("views.publish")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          user_id: "U123",
          view: expect.objectContaining({
            type: "home",
          }),
        }),
      }),
    ]);
  });

  it("resumes a pending OAuth request with persisted thread context", async () => {
    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-resume-state", {
        userId: "U123",
        provider: "eval-oauth",
        channelId: "C123",
        threadTs: "1700000000.001",
        pendingMessage: "list my sentry issues",
      });
    await stateAdapterModule
      .getStateAdapter()
      .set("thread-state:slack:C123:1700000000.001", {
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
              text: "list my sentry issues",
              createdAtMs: 2,
              author: {
                userId: "U123",
                userName: "dcramer",
              },
            },
          ],
        },
      });

    const response = await oauthCallbackHarnessModule.runOauthCallbackRoute({
      provider: "eval-oauth",
      state: "eval-oauth-resume-state",
      code: "eval-oauth-code",
    });

    expect(response.status).toBe(200);
    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "list my sentry issues",
      expect.objectContaining({
        conversationContext: expect.stringContaining(
          "You need the budget by Friday.",
        ),
      }),
    );
    const resumeContext = generateAssistantReplyMock.mock.calls[0]?.[1] as {
      conversationContext?: string;
    };
    expect(resumeContext.conversationContext).not.toContain(
      "list my sentry issues",
    );

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel: "C123",
            thread_ts: "1700000000.001",
            text: "Here are your Sentry issues.",
          }),
        }),
      ]),
    );
  });

  it("resumes a checkpointed OAuth turn with persisted thread state", async () => {
    const conversationId = "slack:C123:1700000000.009";
    const sessionId = "turn_msg_9";

    await turnSessionStoreModule.upsertAgentTurnSessionCheckpoint({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "list my sentry issues" }],
          timestamp: 1,
        },
      ],
      loadedSkillNames: ["eval-oauth"],
      resumeReason: "auth",
      resumedFromSliceId: 1,
    });

    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-checkpoint-state", {
        userId: "U123",
        provider: "eval-oauth",
        channelId: "C123",
        threadTs: "1700000000.009",
        pendingMessage: "list my sentry issues",
        resumeConversationId: conversationId,
        resumeSessionId: sessionId,
      });
    await stateAdapterModule
      .getStateAdapter()
      .set(`thread-state:${conversationId}`, {
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
              id: "msg.9",
              role: "user",
              text: "list my sentry issues",
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
              kind: "plugin",
              provider: "eval-oauth",
              requesterId: "U123",
              sessionId,
              linkSentAtMs: 1,
            },
          },
        },
        artifacts: {
          assistantContextChannelId: "C999",
          listColumnMap: {},
        },
      });

    const response = await oauthCallbackHarnessModule.runOauthCallbackRoute({
      provider: "eval-oauth",
      state: "eval-oauth-checkpoint-state",
      code: "eval-oauth-code",
    });

    expect(response.status).toBe(200);
    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "list my sentry issues",
      expect.objectContaining({
        requester: expect.objectContaining({ userId: "U123" }),
        correlation: expect.objectContaining({
          channelId: "C123",
          threadTs: "1700000000.009",
          requesterId: "U123",
        }),
        toolChannelId: "C999",
        conversationContext: expect.stringContaining(
          "You need the budget by Friday.",
        ),
      }),
    );
    const resumeContext = generateAssistantReplyMock.mock.calls[0]?.[1] as {
      conversationContext?: string;
    };
    expect(resumeContext.conversationContext).not.toContain(
      "list my sentry issues",
    );

    const persistedState = await stateAdapterModule
      .getStateAdapter()
      .get<Record<string, unknown>>(`thread-state:${conversationId}`);
    const conversation =
      (persistedState?.conversation as {
        messages?: Array<{ role?: string; text?: string }>;
        processing?: { activeTurnId?: string };
      }) ?? {};
    expect(conversation.processing?.activeTurnId).toBeUndefined();
    expect(conversation.messages?.at(-1)).toMatchObject({
      role: "assistant",
      text: "Here are your Sentry issues.",
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel: "C123",
            thread_ts: "1700000000.009",
            text: "Here are your Sentry issues.",
          }),
        }),
      ]),
    );
  });
});
