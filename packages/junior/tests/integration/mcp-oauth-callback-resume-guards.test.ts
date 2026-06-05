import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTH_PROVIDER,
  SLACK_DESTINATION,
  createMcpOauthCallbackRouteFixture,
} from "../fixtures/mcp-oauth-callback-route";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createMcpOauthCallbackRouteFixture>>;

describe("mcp oauth callback resume guards", () => {
  beforeEach(async () => {
    testbed = await createMcpOauthCallbackRouteFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
  });

  it("does not resume a stale MCP-blocked request after a newer thread message", async () => {
    const sessionId = "turn_user-4";
    await testbed.turnSessionStore.upsertAgentTurnSessionRecord({
      conversationId: "conversation-4",
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      piMessages: [],
      resumeReason: "auth",
      resumedFromSliceId: 1,
    });
    await testbed.stateAdapter
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

    const authProvider = await testbed.createPendingAuthSession({
      conversationId: "conversation-4",
      sessionId,
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.004",
    });

    const response = await testbed.runRoute({
      provider: EVAL_MCP_AUTH_PROVIDER,
      state: authProvider.authSessionId,
      code: EVAL_MCP_AUTH_CODE,
    });

    expect(response.status).toBe(200);
    expect(testbed.generateAssistantReplyMock).not.toHaveBeenCalled();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);

    const persistedState = await testbed.stateAdapter
      .getStateAdapter()
      .get<Record<string, unknown>>("thread-state:slack:C123:1700000000.004");
    const conversation =
      testbed.conversationState.coerceThreadConversationState(persistedState);
    expect(conversation.processing.pendingAuth).toBeUndefined();

    const sessionRecord =
      await testbed.turnSessionStore.getAgentTurnSessionRecord(
        "conversation-4",
        sessionId,
      );
    expect(sessionRecord?.state).toBe("abandoned");
  });

  it("does not resume MCP OAuth without an awaiting turn-session record", async () => {
    const sessionId = "turn_missing_record";
    await testbed.storePendingMcpThreadState({
      threadId: "slack:C123:1700000000.006",
      messageId: "user-6",
      text: "list mcp data",
      sessionId,
    });

    const authProvider = await testbed.createPendingAuthSession({
      conversationId: "conversation-missing-record",
      sessionId,
      userMessage: "list mcp data",
      channelId: "C123",
      threadTs: "1700000000.006",
    });

    const response = await testbed.runRoute({
      provider: EVAL_MCP_AUTH_PROVIDER,
      state: authProvider.authSessionId,
      code: EVAL_MCP_AUTH_CODE,
    });

    expect(response.status).toBe(200);
    expect(testbed.generateAssistantReplyMock).not.toHaveBeenCalled();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
  });
});
