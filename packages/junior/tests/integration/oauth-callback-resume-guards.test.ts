import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_OAUTH_PROVIDER,
  SLACK_DESTINATION,
  createOauthCallbackSlackFixture,
} from "../fixtures/oauth-callback-slack";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createOauthCallbackSlackFixture>>;

describe("oauth callback resume guards", () => {
  beforeEach(async () => {
    testbed = await createOauthCallbackSlackFixture();
  }, 45_000);

  afterEach(async () => {
    await testbed.cleanup();
  }, 45_000);

  it("does not re-post the pending message when the session record is already abandoned", async () => {
    const conversationId = "slack:C123:1700000000.010";
    const sessionId = "turn_msg_10";

    await testbed.turnSessionStore.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "abandoned",
      destination: SLACK_DESTINATION,
      piMessages: [],
      resumeReason: "auth",
      resumedFromSliceId: 1,
    });

    await testbed.storeOAuthState("eval-oauth-abandoned-state", {
      channelId: "C123",
      threadTs: "1700000000.010",
      pendingMessage: "list my sentry issues",
      resumeConversationId: conversationId,
      resumeSessionId: sessionId,
    });

    const response = await testbed.runRoute({
      provider: EVAL_OAUTH_PROVIDER,
      state: "eval-oauth-abandoned-state",
    });

    expect(response.status).toBe(200);
    expect(testbed.generateAssistantReplyMock).not.toHaveBeenCalled();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
  });

  it("resumes the latest pending OAuth session when a reused link points at an abandoned session", async () => {
    const conversationId = "slack:C123:1700000000.012";
    const oldSessionId = "turn_msg_old_12";
    const newSessionId = "turn_msg_new_12";

    await testbed.turnSessionStore.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: oldSessionId,
      sliceId: 2,
      state: "abandoned",
      destination: SLACK_DESTINATION,
      piMessages: [],
      resumeReason: "auth",
      resumedFromSliceId: 1,
    });
    await testbed.turnSessionStore.upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: newSessionId,
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      piMessages: [],
      resumeReason: "auth",
      resumedFromSliceId: 1,
    });

    await testbed.storeOAuthState("eval-oauth-reused-link-state", {
      channelId: "C123",
      threadTs: "1700000000.012",
      pendingMessage: "old request",
      resumeConversationId: conversationId,
      resumeSessionId: oldSessionId,
    });
    await testbed.stateAdapter
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
              provider: EVAL_OAUTH_PROVIDER,
              requesterId: "U123",
              sessionId: newSessionId,
              linkSentAtMs: 1,
            },
          },
        },
      });

    const response = await testbed.runRoute({
      provider: EVAL_OAUTH_PROVIDER,
      state: "eval-oauth-reused-link-state",
    });

    expect(response.status).toBe(200);
    expect(testbed.generateAssistantReplyMock).toHaveBeenCalledWith(
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
});
