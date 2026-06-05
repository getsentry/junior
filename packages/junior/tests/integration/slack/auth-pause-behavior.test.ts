import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableTurnError } from "@/chat/runtime/turn";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { createSlackBehaviorRuntime } from "../../fixtures/slack-behavior";
import {
  createAwaitingSlackTurnState,
  createPiUserTurn,
} from "../../fixtures/slack-turn-state";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

interface AuthPauseConversationState {
  processing?: { activeTurnId?: string };
  messages?: Array<{
    id?: string;
    meta?: { replied?: boolean; skippedReason?: string };
    role?: string;
    text?: string;
  }>;
}

function conversationState(thread: ReturnType<typeof createTestThread>) {
  return (thread.getState() as { conversation?: AuthPauseConversationState })
    .conversation;
}

function expectAuthPauseParked(
  thread: ReturnType<typeof createTestThread>,
  messageId: string,
): void {
  expect(thread.posts).toEqual([
    expect.objectContaining({
      markdown: expect.stringContaining("private link"),
    }),
  ]);
  const conversation = conversationState(thread);
  expect(conversation?.processing?.activeTurnId).toBeUndefined();
  expect(conversation?.messages).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        text: expect.stringContaining("private link"),
      }),
    ]),
  );
  expect(
    conversation?.messages?.find((message) => message.id === messageId),
  ).toMatchObject({
    meta: {
      replied: true,
      skippedReason: undefined,
    },
  });
}

describe("Slack behavior: auth-pause turns", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it.each([
    {
      name: "MCP",
      threadId: "slack:C_AUTH:1700000000.000",
      messageId: "msg-auth-pause",
      text: "please use notion",
      resumeReason: "mcp_auth_resume",
      authKind: "mcp",
      authProvider: "notion",
    },
    {
      name: "plugin",
      threadId: "slack:C_PLUGIN_AUTH:1700000000.000",
      messageId: "msg-plugin-auth-pause",
      text: "please use github",
      resumeReason: "plugin_auth_resume",
      authKind: "plugin",
      authProvider: "github",
    },
  ] as const)(
    "parks $name auth resume turns without rethrowing to the queue",
    async ({
      authKind,
      authProvider,
      messageId,
      resumeReason,
      text,
      threadId,
    }) => {
      const { slackRuntime } = createSlackBehaviorRuntime({
        services: {
          replyExecutor: {
            generateAssistantReply: async () => {
              throw new RetryableTurnError(
                resumeReason,
                "simulated auth pause",
                {
                  authDisposition: "link_sent",
                  authKind,
                  authProvider,
                },
              );
            },
          },
        },
      });

      const thread = createTestThread({ id: threadId });
      await expect(
        slackRuntime.handleNewMention(
          thread,
          createTestMessage({
            id: messageId,
            threadId,
            text,
            isMention: true,
          }),
        ),
      ).resolves.toBeUndefined();

      expectAuthPauseParked(thread, messageId);
    },
  );

  it("parks auth-paused active turns without starting a new follow-up turn", async () => {
    const conversationId = "slack:C_AUTH_PARKED:1700000000.000";
    const activeSessionId = "turn_msg-auth-original";
    const generateAssistantReply = vi.fn();
    const onTurnStatePersisted = vi.fn();
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: activeSessionId,
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "auth",
      piMessages: createPiUserTurn("please use notion"),
    });
    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply,
        },
      },
    });

    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingSlackTurnState({ activeSessionId }),
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-auth-follow-up",
        threadId: conversationId,
        text: "any update?",
        isMention: true,
      }),
      { onTurnStatePersisted },
    );

    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(onTurnStatePersisted).toHaveBeenCalledOnce();
    expect(thread.posts).toEqual([]);
    const conversation = conversationState(thread);
    expect(conversation?.processing?.activeTurnId).toBe(activeSessionId);
    const followUp = conversation?.messages?.find(
      (message) => message.id === "msg-auth-follow-up",
    );
    expect(followUp).toBeDefined();
    expect(followUp?.meta?.replied).toBeUndefined();
    expect(followUp?.meta?.skippedReason).toBeUndefined();
  });
});
