import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  getCapturedSlackApiCalls,
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
const EVAL_OAUTH_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-oauth",
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

    type: "priv",
  });
}

type StateAdapterModule = typeof import("@/chat/state/adapter");
type OAuthCallbackHarnessModule =
  typeof import("../fixtures/oauth-callback-harness");
type TurnSessionStoreModule = typeof import("@/chat/state/turn-session");

let stateAdapterModule: StateAdapterModule;
let oauthCallbackHarnessModule: OAuthCallbackHarnessModule;
let turnSessionStoreModule: TurnSessionStoreModule;
let pluginApp: PluginAppFixture | undefined;

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
    };
    pluginApp = await createPluginAppFixture([EVAL_OAUTH_PLUGIN_ROOT]);
    vi.resetModules();
    stateAdapterModule = await import("@/chat/state/adapter");
    oauthCallbackHarnessModule =
      await import("../fixtures/oauth-callback-harness");
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
  }, 20_000);

  it("resumes a pending OAuth request with persisted thread context", async () => {
    const storedSource = createSlackSource({
      teamId: "T123",
      channelId: "C123",
      messageTs: "1700000000.oauth-source",
      threadTs: "1700000000.001",

      type: "priv",
    });
    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-resume-state", {
        userId: "U123",
        provider: "eval-oauth",
        channelId: "C123",
        destination: SLACK_DESTINATION,
        source: storedSource,
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
        destination: SLACK_DESTINATION,
        source: storedSource,
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
  }, 20_000);

  it("resumes a session-recorded OAuth turn with persisted thread state", async () => {
    const conversationId = "slack:C123:1700000000.009";
    const sessionId = "turn_msg_9";
    const storedSource = createSlackSource({
      teamId: "T123",
      channelId: "C123",
      messageTs: "1700000000.session-source",
      threadTs: "1700000000.009",

      type: "priv",
    });

    await turnSessionStoreModule.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      source: storedSource,
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "list my sentry issues" }],
          timestamp: 1,
        },
      ],
      resumeReason: "auth",
      resumedFromSliceId: 1,
      requester: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
        userName: "stored-user",
        fullName: "Stored User",
        email: "stored@example.com",
      },
    });

    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-session-record-state", {
        userId: "U123",
        provider: "eval-oauth",
        channelId: "C123",
        destination: SLACK_DESTINATION,
        source: slackSource("1700000000.009"),
        threadTs: "1700000000.009",
        pendingMessage: "list my sentry issues",
        resumeConversationId: conversationId,
        resumeSessionId: sessionId,
        scope: "read",
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
              meta: {
                slackTs: "1700000000.010",
              },
            },
            {
              id: "msg.bystander",
              role: "user",
              text: "I think those tools are read only",
              createdAtMs: 3,
              author: {
                userId: "U999",
                userName: "bystander",
              },
              meta: {
                replied: false,
                skippedReason: "side_conversation:passive side conversation",
                slackTs: "1700000000.011",
              },
            },
            {
              id: "msg.bot-failed",
              role: "user",
              text: "sync this with github",
              createdAtMs: 4,
              author: {
                userId: "UBOT",
                userName: "github",
                isBot: true,
              },
              meta: {
                replied: false,
                skippedReason: "reply failed",
                slackTs: "1700000000.012",
              },
            },
          ],
          processing: {
            activeTurnId: undefined,
            pendingAuth: {
              kind: "plugin",
              provider: "eval-oauth",
              requesterId: "U123",
              scope: "read",
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
      state: "eval-oauth-session-record-state",
      code: "eval-oauth-code",
    });

    expect(response.status).toBe(200);
    const sessionRecordAfterAuth =
      await turnSessionStoreModule.getAgentTurnSessionRecord(
        conversationId,
        sessionId,
      );
    expect(sessionRecordAfterAuth?.piMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [
            {
              type: "text",
              text: 'Authorization completed for provider "eval-oauth". Continue the blocked request and retry the provider operation if needed.',
            },
          ],
        }),
      ]),
    );
    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "list my sentry issues",
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
        source: storedSource,
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
      source?: unknown;
    };
    expect(resumeContext.source).toEqual({
      ...slackSource("1700000000.009"),
      messageTs: "1700000000.session-source",
    });
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
    expect(getCapturedSlackApiCalls("reactions.add")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          timestamp: "1700000000.010",
          name: "eyes",
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          timestamp: "1700000000.010",
          name: "white_check_mark",
        }),
      }),
    ]);
    expect(getCapturedSlackApiCalls("reactions.remove")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          timestamp: "1700000000.010",
          name: "eyes",
        }),
      }),
    ]);
  });

  it("fails a session-recorded OAuth resume with mismatched requester team", async () => {
    const conversationId = "slack:C123:1700000000.012";
    const sessionId = "turn_msg_12";

    await turnSessionStoreModule.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      source: slackSource("1700000000.012"),
      piMessages: [],
      resumeReason: "auth",
      resumedFromSliceId: 1,
      requester: {
        platform: "slack",
        teamId: "T999",
        userId: "U123",
      },
    });
    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-mismatched-requester-state", {
        userId: "U123",
        provider: "eval-oauth",
        channelId: "C123",
        destination: SLACK_DESTINATION,
        source: slackSource("1700000000.012"),
        threadTs: "1700000000.012",
        pendingMessage: "list my sentry issues",
        resumeConversationId: conversationId,
        resumeSessionId: sessionId,
        scope: "read",
      });
    await stateAdapterModule
      .getStateAdapter()
      .set(`thread-state:${conversationId}`, {
        conversation: {
          messages: [
            {
              id: "msg.12",
              role: "user",
              text: "list my sentry issues",
              createdAtMs: 2,
              author: { userId: "U123" },
              meta: { slackTs: "1700000000.0121" },
            },
          ],
          processing: {
            activeTurnId: undefined,
            pendingAuth: {
              kind: "plugin",
              provider: "eval-oauth",
              requesterId: "U123",
              scope: "read",
              sessionId,
              linkSentAtMs: 1,
            },
          },
        },
      });

    const response = await oauthCallbackHarnessModule.runOauthCallbackRoute({
      provider: "eval-oauth",
      state: "eval-oauth-mismatched-requester-state",
      code: "eval-oauth-code",
    });

    expect(response.status).toBe(200);
    expect(generateAssistantReplyMock).not.toHaveBeenCalled();
    await expect(
      turnSessionStoreModule.getAgentTurnSessionRecord(
        conversationId,
        sessionId,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage:
        "Stored Slack requester identity did not match OAuth requester",
    });
  });

  it("rebuilds session-recorded OAuth resume context from state loaded under the thread lock", async () => {
    const conversationId = "slack:C123:1700000000.011";
    const sessionId = "turn_msg_11";
    const staleState = {
      conversation: {
        messages: [
          {
            id: "assistant-old",
            role: "assistant",
            text: "Old context that should not be used.",
            createdAtMs: 1,
            author: {
              userName: "junior",
              isBot: true,
            },
          },
          {
            id: "msg.11",
            role: "user",
            text: "list my sentry issues",
            createdAtMs: 2,
            author: {
              userId: "U123",
              userName: "dcramer",
            },
            meta: {
              slackTs: "1700000000.0111",
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
        assistantContextChannelId: "COLD",
      },
    };
    const freshState = {
      conversation: {
        messages: [
          {
            id: "assistant-fresh",
            role: "assistant",
            text: "Fresh context loaded after the lock.",
            createdAtMs: 1,
            author: {
              userName: "junior",
              isBot: true,
            },
          },
          {
            id: "msg.11",
            role: "user",
            text: "list my sentry issues",
            createdAtMs: 2,
            author: {
              userId: "U123",
              userName: "dcramer",
            },
            meta: {
              slackTs: "1700000000.0112",
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
        assistantContextChannelId: "CFRESH",
      },
    };

    await turnSessionStoreModule.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      source: slackSource("1700000000.011"),
      piMessages: [],
      resumeReason: "auth",
      resumedFromSliceId: 1,
      requester: { platform: "slack", teamId: "T123", userId: "U123" },
    });
    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-locked-state", {
        userId: "U123",
        provider: "eval-oauth",
        channelId: "C123",
        destination: SLACK_DESTINATION,
        source: slackSource("1700000000.011"),
        threadTs: "1700000000.011",
        pendingMessage: "list my sentry issues",
        resumeConversationId: conversationId,
        resumeSessionId: sessionId,
      });
    await stateAdapterModule
      .getStateAdapter()
      .set(`thread-state:${conversationId}`, freshState);

    const adapter = stateAdapterModule.getStateAdapter();
    const originalGet = adapter.get.bind(adapter);
    let threadReadCount = 0;
    const getSpy = vi.spyOn(adapter, "get");
    getSpy.mockImplementation((async (key: string) => {
      if (key === `thread-state:${conversationId}` && threadReadCount++ === 0) {
        return structuredClone(staleState);
      }
      return await originalGet(key);
    }) as typeof adapter.get);

    try {
      const response = await oauthCallbackHarnessModule.runOauthCallbackRoute({
        provider: "eval-oauth",
        state: "eval-oauth-locked-state",
        code: "eval-oauth-code",
      });

      expect(response.status).toBe(200);
    } finally {
      getSpy.mockRestore();
    }

    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "list my sentry issues",
      expect.objectContaining({
        toolChannelId: "CFRESH",
        destination: SLACK_DESTINATION,
        conversationContext: expect.stringContaining(
          "Fresh context loaded after the lock.",
        ),
      }),
    );
    const resumeContext = generateAssistantReplyMock.mock.calls[0]?.[1] as {
      conversationContext?: string;
    };
    expect(resumeContext.conversationContext).not.toContain(
      "Old context that should not be used.",
    );
    expect(getCapturedSlackApiCalls("reactions.add")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          timestamp: "1700000000.0112",
          name: "eyes",
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          timestamp: "1700000000.0112",
          name: "white_check_mark",
        }),
      }),
    ]);
  });

  it("resumes the latest pending OAuth session when a reused link points at an abandoned session", async () => {
    const conversationId = "slack:C123:1700000000.012";
    const oldSessionId = "turn_msg_old_12";
    const newSessionId = "turn_msg_new_12";

    await turnSessionStoreModule.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: oldSessionId,
      sliceId: 2,
      state: "abandoned",
      destination: SLACK_DESTINATION,
      source: slackSource("1700000000.012"),
      piMessages: [],
      resumeReason: "auth",
      resumedFromSliceId: 1,
      requester: {
        platform: "slack",
        teamId: SLACK_DESTINATION.teamId,
        userId: "U123",
        userName: "dcramer",
      },
    });
    await turnSessionStoreModule.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: newSessionId,
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      source: slackSource("1700000000.012"),
      piMessages: [],
      resumeReason: "auth",
      resumedFromSliceId: 1,
      requester: {
        platform: "slack",
        teamId: SLACK_DESTINATION.teamId,
        userId: "U123",
        userName: "dcramer",
      },
    });

    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-reused-link-state", {
        userId: "U123",
        provider: "eval-oauth",
        channelId: "C123",
        destination: SLACK_DESTINATION,
        source: slackSource("1700000000.012"),
        threadTs: "1700000000.012",
        pendingMessage: "old request",
        resumeConversationId: conversationId,
        resumeSessionId: oldSessionId,
      });
    await stateAdapterModule
      .getStateAdapter()
      .set(`thread-state:${conversationId}`, {
        conversation: {
          messages: [
            {
              id: "msg.old.12",
              role: "user",
              text: "old request",
              createdAtMs: 1,
              author: {
                userId: "U123",
                userName: "dcramer",
              },
            },
            {
              id: "msg.new.12",
              role: "user",
              text: "new request",
              createdAtMs: 2,
              author: {
                userId: "U123",
                userName: "dcramer",
              },
              meta: {
                slackTs: "1700000000.0123",
              },
            },
          ],
          processing: {
            activeTurnId: undefined,
            pendingAuth: {
              kind: "plugin",
              provider: "eval-oauth",
              requesterId: "U123",
              sessionId: newSessionId,
              linkSentAtMs: 1,
            },
          },
        },
      });

    const response = await oauthCallbackHarnessModule.runOauthCallbackRoute({
      provider: "eval-oauth",
      state: "eval-oauth-reused-link-state",
      code: "eval-oauth-code",
    });

    expect(response.status).toBe(200);
    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "new request",
      expect.objectContaining({
        correlation: expect.objectContaining({
          turnId: newSessionId,
        }),
      }),
    );
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel: "C123",
            thread_ts: "1700000000.012",
            text: "Here are your Sentry issues.",
          }),
        }),
      ]),
    );
  });

  it("does not re-post the pending message when the session record is already abandoned", async () => {
    const conversationId = "slack:C123:1700000000.010";
    const sessionId = "turn_msg_10";

    await turnSessionStoreModule.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "abandoned",
      destination: SLACK_DESTINATION,
      source: slackSource("1700000000.010"),
      piMessages: [],
      resumeReason: "auth",
      resumedFromSliceId: 1,
      requester: { platform: "slack", teamId: "T123", userId: "U123" },
    });

    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-abandoned-state", {
        userId: "U123",
        provider: "eval-oauth",
        channelId: "C123",
        destination: SLACK_DESTINATION,
        source: slackSource("1700000000.010"),
        threadTs: "1700000000.010",
        pendingMessage: "list my sentry issues",
        resumeConversationId: conversationId,
        resumeSessionId: sessionId,
      });

    const response = await oauthCallbackHarnessModule.runOauthCallbackRoute({
      provider: "eval-oauth",
      state: "eval-oauth-abandoned-state",
      code: "eval-oauth-code",
    });

    expect(response.status).toBe(200);
    expect(generateAssistantReplyMock).not.toHaveBeenCalled();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
  });
});
