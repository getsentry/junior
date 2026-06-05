import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTH_PROVIDER,
  SLACK_DESTINATION,
  createMcpOauthCallbackRouteFixture,
} from "../../fixtures/mcp-oauth-callback-route";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createMcpOauthCallbackRouteFixture>>;

describe("mcp oauth callback resume lock", () => {
  beforeEach(async () => {
    testbed = await createMcpOauthCallbackRouteFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
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
            kind: "mcp",
            provider: EVAL_MCP_AUTH_PROVIDER,
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
            kind: "mcp",
            provider: EVAL_MCP_AUTH_PROVIDER,
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

    const authProvider = await testbed.createPendingAuthSession({
      conversationId: threadId,
      sessionId,
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      threadTs: "1700000000.005",
    });
    await testbed.createAwaitingMcpTurnRecord({
      conversationId: threadId,
      sessionId,
      text: "what did i say about the budget?",
    });
    await testbed.stateAdapter
      .getStateAdapter()
      .set(`thread-state:${threadId}`, freshState);

    const adapter = testbed.stateAdapter.getStateAdapter();
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
      const response = await testbed.runRoute({
        provider: EVAL_MCP_AUTH_PROVIDER,
        state: authProvider.authSessionId,
        code: EVAL_MCP_AUTH_CODE,
      });

      expect(response.status).toBe(200);
    } finally {
      getSpy.mockRestore();
    }

    expect(testbed.generateAssistantReplyMock).toHaveBeenCalledWith(
      "what did i say about the budget?",
      expect.objectContaining({
        destination: SLACK_DESTINATION,
        toolChannelId: "CFRESH",
        conversationContext: expect.stringContaining(
          "Fresh MCP context loaded after the lock.",
        ),
      }),
    );
    const resumeContext = testbed.generateAssistantReplyMock.mock
      .calls[0]?.[1] as {
      conversationContext?: string;
    };
    expect(resumeContext.conversationContext).not.toContain(
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
});
