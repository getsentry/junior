import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_MCP_AUTH_PROVIDER,
  createMcpAuthRuntimeSlackFixture,
  priorBudgetContext,
} from "../../fixtures/mcp-auth-runtime-slack";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

let testbed: Awaited<ReturnType<typeof createMcpAuthRuntimeSlackFixture>>;

describe("mcp auth runtime subscribed parking", () => {
  beforeEach(async () => {
    testbed = await createMcpAuthRuntimeSlackFixture();
  }, 45_000);

  afterEach(async () => {
    await testbed.cleanup();
  }, 45_000);

  it("parks a subscribed-thread MCP auth challenge with the same pending-auth state", async () => {
    const threadId = "slack:C124:1700000000.002";
    const turnId = "turn_user-2";
    const generateAssistantReply = testbed.createMcpAuthReplyGenerator();
    const { slackRuntime } = testbed.chatRuntime.createTestChatRuntime({
      services: {
        replyExecutor: { generateAssistantReply },
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: true,
                confidence: 1,
                reason: "requires thread follow-up",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"requires thread follow-up"}',
            }) as never,
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const destination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C124",
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

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "user-2",
        threadId,
        text: "what did i say about the budget?",
        isMention: false,
        author: {
          userId: "U123",
          userName: "dcramer",
        },
        raw: {
          channel: "C124",
          team_id: "T123",
          ts: "1700000000.004",
          thread_ts: "1700000000.002",
        },
      }),
      { destination },
    );

    expect(testbed.agentProbe.promptCallCount).toBe(1);
    expect(testbed.agentProbe.continueCallCount).toBe(0);
    expect(thread.posts).toEqual([
      expect.objectContaining({
        markdown: expect.stringContaining("private link"),
      }),
    ]);

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
  });
});
