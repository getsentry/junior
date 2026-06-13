import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_OAUTH_PROVIDER,
  SLACK_DESTINATION,
  createOauthCallbackRouteFixture,
} from "../../fixtures/oauth/callback-route";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createOauthCallbackRouteFixture>>;

describe("oauth callback resume context", () => {
  beforeEach(async () => {
    testbed = await createOauthCallbackRouteFixture();
  }, 45_000);

  afterEach(async () => {
    await testbed.cleanup();
  }, 45_000);

  it("resumes a pending OAuth request with persisted thread context", async () => {
    await testbed.storeOAuthState("eval-oauth-resume-state", {
      channelId: "C123",
      threadTs: "1700000000.001",
      pendingMessage: "list my sentry issues",
    });
    await testbed.stateAdapter
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

    const response = await testbed.runRoute({
      provider: EVAL_OAUTH_PROVIDER,
      state: "eval-oauth-resume-state",
    });

    expect(response.status).toBe(200);
    expect(testbed.generateAssistantReplyMock).toHaveBeenCalledWith(
      "list my sentry issues",
      expect.objectContaining({
        destination: SLACK_DESTINATION,
        conversationContext: expect.stringContaining(
          "You need the budget by Friday.",
        ),
      }),
    );
    const resumeContext = testbed.generateAssistantReplyMock.mock
      .calls[0]?.[1] as {
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

    await testbed.createAwaitingOauthTurnRecord({
      conversationId,
      sessionId,
      text: "list my sentry issues",
    });

    await testbed.storeOAuthState("eval-oauth-session-record-state", {
      channelId: "C123",
      threadTs: "1700000000.009",
      pendingMessage: "list my sentry issues",
      resumeConversationId: conversationId,
      resumeSessionId: sessionId,
    });
    await testbed.stateAdapter
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
          assistantContextChannelId: "C999",
          listColumnMap: {},
        },
      });

    const response = await testbed.runRoute({
      provider: EVAL_OAUTH_PROVIDER,
      state: "eval-oauth-session-record-state",
    });

    expect(response.status).toBe(200);
    const sessionRecordAfterAuth =
      await testbed.turnSessionStore.getAgentTurnSessionRecord(
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
    expect(testbed.generateAssistantReplyMock).toHaveBeenCalledWith(
      "list my sentry issues",
      expect.objectContaining({
        requester: expect.objectContaining({ userId: "U123" }),
        destination: SLACK_DESTINATION,
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
    const resumeContext = testbed.generateAssistantReplyMock.mock
      .calls[0]?.[1] as {
      conversationContext?: string;
    };
    expect(resumeContext.conversationContext).not.toContain(
      "list my sentry issues",
    );

    const persistedState = await testbed.stateAdapter
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
});
