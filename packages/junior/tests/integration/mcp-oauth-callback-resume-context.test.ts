import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTH_PROVIDER,
  SLACK_DESTINATION,
  createMcpOauthCallbackRouteFixture,
} from "../fixtures/mcp-oauth-callback-route";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createMcpOauthCallbackRouteFixture>>;

describe("mcp oauth callback resume context", () => {
  beforeEach(async () => {
    testbed = await createMcpOauthCallbackRouteFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
  });

  it("finalizes MCP OAuth and resumes the stored thread with persisted context", async () => {
    const threadId = "slack:C123:1700000000.001";
    const sessionId = "turn_user-1";

    await testbed.stateAdapter
      .getStateAdapter()
      .set(`thread-state:${threadId}`, {
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
              meta: {
                attachmentCount: 1,
                imageAttachmentCount: 1,
                imagesHydrated: false,
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
          assistantContextChannelId: "C999",
          lastCanvasId: "F123",
        },
      });
    await testbed.stateAdapter.getStateAdapter().set("channel-state:C123", {
      configuration: {
        schemaVersion: 1,
        entries: {
          region: {
            key: "region",
            value: "us",
            scope: "conversation",
            updatedAt: new Date(0).toISOString(),
          },
        },
      },
    });
    await testbed.createAwaitingMcpTurnRecord({
      conversationId: "conversation-1",
      sessionId,
      text: "what did i say about the budget?",
    });

    const authProvider = await testbed.createPendingAuthSession({
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
    });

    const pendingSession = await testbed.mcpAuthStore.getMcpAuthSession(
      authProvider.authSessionId,
    );
    expect(pendingSession).toMatchObject({
      authSessionId: authProvider.authSessionId,
      provider: EVAL_MCP_AUTH_PROVIDER,
      userId: "U123",
      conversationId: "conversation-1",
      destination: SLACK_DESTINATION,
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

    const response = await testbed.runRoute({
      provider: EVAL_MCP_AUTH_PROVIDER,
      state: authProvider.authSessionId,
      code: EVAL_MCP_AUTH_CODE,
    });

    expect(response.status).toBe(200);

    expect(
      await testbed.mcpAuthStore.getMcpAuthSession(authProvider.authSessionId),
    ).toBeUndefined();

    const storedCredentials =
      await testbed.mcpAuthStore.getMcpStoredOAuthCredentials(
        "U123",
        EVAL_MCP_AUTH_PROVIDER,
      );
    expect(storedCredentials?.tokens).toMatchObject({
      access_token: "eval-auth-access-token",
      refresh_token: "eval-auth-refresh-token",
    });

    expect(testbed.generateAssistantReplyMock).toHaveBeenCalledWith(
      "what did i say about the budget?",
      expect.objectContaining({
        requester: expect.objectContaining({ userId: "U123" }),
        destination: SLACK_DESTINATION,
        toolChannelId: "C999",
        inboundAttachmentCount: 1,
        omittedImageAttachmentCount: 1,
        artifactState: expect.objectContaining({
          assistantContextChannelId: "C999",
          lastCanvasId: "F123",
        }),
        conversationContext: expect.stringContaining(
          "You need the budget by Friday.",
        ),
      }),
    );

    const resumeContext = testbed.generateAssistantReplyMock.mock
      .calls[0]?.[1] as {
      conversationContext?: string;
      configuration?: Record<string, unknown>;
    };
    expect(resumeContext.conversationContext).not.toContain(
      "what did i say about the budget?",
    );
    expect(resumeContext.configuration?.region).toBe("us");

    const persistedState = await testbed.stateAdapter
      .getStateAdapter()
      .get<Record<string, unknown>>(`thread-state:${threadId}`);
    const conversation =
      testbed.conversationState.coerceThreadConversationState(persistedState);
    const artifacts =
      testbed.artifactState.coerceThreadArtifactsState(persistedState);

    expect(
      conversation.messages.find((message) => message.id === "user-1"),
    ).toMatchObject({
      meta: {
        replied: true,
      },
    });
    expect(conversation.processing.pendingAuth).toBeUndefined();
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
            status: expect.any(String),
            loading_messages: expect.arrayContaining([expect.any(String)]),
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
            text: "The budget deadline you mentioned earlier was Friday.",
          }),
        }),
      ]),
    );
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
