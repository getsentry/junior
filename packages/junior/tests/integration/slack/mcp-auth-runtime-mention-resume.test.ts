import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_MCP_AUTH_PROVIDER,
  MCP_TOOL_NAME,
  assistantReplyWithContext,
  createMcpAuthRuntimeSlackFixture,
  expectProcessingReactionLifecycles,
  priorBudgetContext,
} from "../../fixtures/mcp-auth-runtime-slack";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createMcpAuthRuntimeSlackFixture>>;

describe("mcp auth runtime mention resume", () => {
  beforeEach(async () => {
    testbed = await createMcpAuthRuntimeSlackFixture();
  }, 45_000);

  afterEach(async () => {
    await testbed.cleanup();
  }, 45_000);

  it("parks an MCP auth challenge from the real Slack runtime and resumes after OAuth callback", async () => {
    const threadId = "slack:C123:1700000000.001";
    const turnId = "turn_user-1";
    const generateAssistantReply = testbed.createMcpAuthReplyGenerator();
    const { slackRuntime } = testbed.chatRuntime.createTestChatRuntime({
      adapters: {
        generateAssistantReply,
        listThreadReplies: async () => [],
      },
    });

    const destination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C123",
    };
    const thread = createTestThread({
      id: threadId,
      state: {
        conversation: {
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: priorBudgetContext,
              createdAtMs: 1,
              author: {
                userName: "junior",
                isBot: true,
              },
            },
          ],
        },
      },
    });
    await testbed.mirrorThreadStateToAdapter(thread);

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "user-1",
        threadId,
        text: "what did i say about the budget?",
        isMention: true,
        author: {
          userId: "U123",
          userName: "dcramer",
        },
        raw: {
          channel: "C123",
          team_id: "T123",
          ts: "1700000000.002",
          thread_ts: "1700000000.001",
        },
      }),
      { destination },
    );

    expect(getCapturedSlackApiCalls("chat.postEphemeral")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          user: "U123",
          thread_ts: "1700000000.001",
          text: expect.stringContaining(
            "Click here to link your Eval-auth MCP access",
          ),
        }),
      }),
    ]);
    expect(thread.posts).toEqual([
      expect.objectContaining({
        markdown: expect.stringContaining("private link"),
      }),
    ]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expectProcessingReactionLifecycles({
      channel: "C123",
      timestamp: "1700000000.002",
      count: 1,
    });

    const pendingAuthSession =
      await testbed.mcpAuthStore.getLatestMcpAuthSessionForUserProvider(
        "U123",
        EVAL_MCP_AUTH_PROVIDER,
      );
    expect(pendingAuthSession).toMatchObject({
      provider: EVAL_MCP_AUTH_PROVIDER,
      conversationId: threadId,
      sessionId: turnId,
      userId: "U123",
      userMessage: "what did i say about the budget?",
      channelId: "C123",
      destination,
      threadTs: "1700000000.001",
      authorizationUrl: expect.stringContaining(
        "https://eval-auth.example.test/oauth/authorize",
      ),
    });
    const parkedAuthSessionId = pendingAuthSession!.authSessionId;

    const pendingCheckpoint =
      await testbed.turnSessionStore.getAgentTurnSessionRecord(
        threadId,
        turnId,
      );
    expect(pendingCheckpoint).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      sliceId: 2,
      state: "awaiting_resume",
      resumeReason: "auth",
      resumedFromSliceId: 1,
    });

    const parkedState =
      await testbed.threadState.getPersistedThreadState(threadId);
    expect(parkedState).toMatchObject({
      conversation: {
        processing: {
          activeTurnId: undefined,
          pendingAuth: {
            kind: "mcp",
            provider: EVAL_MCP_AUTH_PROVIDER,
            requesterId: "U123",
            sessionId: turnId,
            linkSentAtMs: expect.any(Number),
          },
        },
      },
    });

    const response = await testbed.runMcpOauthCallback({
      state: pendingAuthSession!.authSessionId,
      generateReply: generateAssistantReply,
    });

    expect(response.status).toBe(200);
    const sessionRecordAfterAuth =
      await testbed.turnSessionStore.getAgentTurnSessionRecord(
        threadId,
        turnId,
      );
    expect(sessionRecordAfterAuth?.piMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [
            {
              type: "text",
              text: `MCP authorization completed for provider "${EVAL_MCP_AUTH_PROVIDER}". Continue the blocked request and retry the provider operation if needed.`,
            },
          ],
        }),
      ]),
    );
    expect(testbed.agentProbe.searchToolNames).toEqual([[MCP_TOOL_NAME]]);

    const latestReusableSession =
      await testbed.mcpAuthStore.getLatestMcpAuthSessionForUserProvider(
        "U123",
        EVAL_MCP_AUTH_PROVIDER,
      );
    expect(latestReusableSession).toMatchObject({
      provider: EVAL_MCP_AUTH_PROVIDER,
      conversationId: threadId,
      sessionId: turnId,
      userId: "U123",
      userMessage: "what did i say about the budget?",
    });
    expect(latestReusableSession?.authSessionId).not.toBe(parkedAuthSessionId);
    expect(latestReusableSession?.authorizationUrl).toBeUndefined();
    expect(latestReusableSession?.codeVerifier).toBeUndefined();
    expect(
      await testbed.mcpAuthStore.getMcpStoredOAuthCredentials(
        "U123",
        EVAL_MCP_AUTH_PROVIDER,
      ),
    ).toMatchObject({
      tokens: {
        access_token: "eval-auth-access-token",
        refresh_token: "eval-auth-refresh-token",
      },
    });

    const completedCheckpoint =
      await testbed.turnSessionStore.getAgentTurnSessionRecord(
        threadId,
        turnId,
      );
    expect(completedCheckpoint).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      sliceId: 2,
      state: "completed",
    });

    const resumedState =
      await testbed.threadState.getPersistedThreadState(threadId);
    expect(resumedState).toMatchObject({
      conversation: {
        processing: {
          activeTurnId: undefined,
          pendingAuth: undefined,
        },
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "user-1",
            role: "user",
            meta: expect.objectContaining({
              replied: true,
            }),
          }),
          expect.objectContaining({
            role: "assistant",
            text: assistantReplyWithContext,
          }),
        ]),
      },
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.001",
          text: assistantReplyWithContext,
        }),
      }),
    ]);
    expectProcessingReactionLifecycles({
      channel: "C123",
      timestamp: "1700000000.002",
      count: 2,
      completedCount: 1,
    });
  });
});
