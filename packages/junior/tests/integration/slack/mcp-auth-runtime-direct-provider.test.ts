import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_MCP_AUTH_PROVIDER,
  MCP_TOOL_NAME,
  assistantReplyWithContext,
  createMcpAuthRuntimeSlackFixture,
  priorBudgetContext,
} from "../../fixtures/mcp-auth-runtime-slack";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createMcpAuthRuntimeSlackFixture>>;

describe("mcp auth runtime direct provider activation", () => {
  beforeEach(async () => {
    testbed = await createMcpAuthRuntimeSlackFixture();
  }, 45_000);

  afterEach(async () => {
    await testbed.cleanup();
  }, 45_000);

  it("parks and resumes an MCP auth challenge from direct provider activation", async () => {
    testbed.agentProbe.directProviderSearch = true;
    const threadId = "slack:C125:1700000000.003";
    const turnId = "turn_user-3";
    const generateAssistantReply = testbed.createMcpAuthReplyGenerator();
    const { slackRuntime } = testbed.chatRuntime.createTestChatRuntime({
      services: {
        replyExecutor: { generateAssistantReply },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const destination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C125",
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
        id: "user-3",
        threadId,
        text: "use eval-auth directly for the budget answer",
        isMention: true,
        author: {
          userId: "U123",
          userName: "dcramer",
        },
        raw: {
          channel: "C125",
          team_id: "T123",
          ts: "1700000000.004",
          thread_ts: "1700000000.003",
        },
      }),
      { destination },
    );

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
      destination,
    });

    const response = await testbed.runMcpOauthCallback({
      state: pendingAuthSession!.authSessionId,
      generateReply: generateAssistantReply,
    });

    expect(response.status).toBe(200);
    expect(testbed.agentProbe.searchToolNames).toEqual([[MCP_TOOL_NAME]]);

    const completedCheckpoint =
      await testbed.turnSessionStore.getAgentTurnSessionRecord(
        threadId,
        turnId,
      );
    expect(completedCheckpoint).toMatchObject({
      conversationId: threadId,
      sessionId: turnId,
      state: "completed",
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C125",
          thread_ts: "1700000000.003",
          text: assistantReplyWithContext,
        }),
      }),
    ]);
  });
});
