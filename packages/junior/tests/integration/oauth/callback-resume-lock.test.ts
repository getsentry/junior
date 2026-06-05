import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVAL_OAUTH_PROVIDER,
  SLACK_DESTINATION,
  createOauthCallbackRouteFixture,
} from "../../fixtures/oauth-callback-route";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createOauthCallbackRouteFixture>>;

describe("oauth callback resume lock", () => {
  beforeEach(async () => {
    testbed = await createOauthCallbackRouteFixture();
  }, 45_000);

  afterEach(async () => {
    await testbed.cleanup();
  }, 45_000);

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
            provider: EVAL_OAUTH_PROVIDER,
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
            provider: EVAL_OAUTH_PROVIDER,
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

    await testbed.createAwaitingOauthTurnRecord({
      conversationId,
      sessionId,
    });
    await testbed.storeOAuthState("eval-oauth-locked-state", {
      channelId: "C123",
      threadTs: "1700000000.011",
      pendingMessage: "list my sentry issues",
      resumeConversationId: conversationId,
      resumeSessionId: sessionId,
    });
    await testbed.stateAdapter
      .getStateAdapter()
      .set(`thread-state:${conversationId}`, freshState);

    const adapter = testbed.stateAdapter.getStateAdapter();
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
      const response = await testbed.runRoute({
        provider: EVAL_OAUTH_PROVIDER,
        state: "eval-oauth-locked-state",
      });

      expect(response.status).toBe(200);
    } finally {
      getSpy.mockRestore();
    }

    expect(testbed.generateAssistantReplyMock).toHaveBeenCalledWith(
      "list my sentry issues",
      expect.objectContaining({
        destination: SLACK_DESTINATION,
        toolChannelId: "CFRESH",
        conversationContext: expect.stringContaining(
          "Fresh context loaded after the lock.",
        ),
      }),
    );
    const resumeContext = testbed.generateAssistantReplyMock.mock
      .calls[0]?.[1] as {
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
});
