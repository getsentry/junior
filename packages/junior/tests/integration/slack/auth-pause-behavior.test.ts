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

describe("Slack behavior: auth-pause turns", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it("parks MCP auth resume turns without rethrowing to the queue", async () => {
    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new RetryableTurnError(
              "mcp_auth_resume",
              "simulated auth pause",
              {
                authDisposition: "link_sent",
                authKind: "mcp",
                authProvider: "notion",
              },
            );
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_AUTH:1700000000.000" });
    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-auth-pause",
          threadId: "slack:C_AUTH:1700000000.000",
          text: "please use notion",
          isMention: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(thread.posts).toEqual([
      expect.objectContaining({
        markdown: expect.stringContaining("private link"),
      }),
    ]);
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: {
          processing?: { activeTurnId?: string };
          messages?: Array<{
            id?: string;
            meta?: { replied?: boolean; skippedReason?: string };
            role?: string;
            text?: string;
          }>;
        };
      }
    ).conversation;
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
      conversation?.messages?.find(
        (message) => message.id === "msg-auth-pause",
      ),
    ).toMatchObject({
      meta: {
        replied: true,
        skippedReason: undefined,
      },
    });
  });

  it("parks plugin auth resume turns without rethrowing to the queue", async () => {
    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new RetryableTurnError(
              "plugin_auth_resume",
              "simulated plugin auth pause",
              {
                authDisposition: "link_sent",
                authKind: "plugin",
                authProvider: "github",
              },
            );
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_PLUGIN_AUTH:1700000000.000",
    });
    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-plugin-auth-pause",
          threadId: "slack:C_PLUGIN_AUTH:1700000000.000",
          text: "please use github",
          isMention: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(thread.posts).toEqual([
      expect.objectContaining({
        markdown: expect.stringContaining("private link"),
      }),
    ]);
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: {
          processing?: { activeTurnId?: string };
          messages?: Array<{
            id?: string;
            meta?: { replied?: boolean; skippedReason?: string };
            role?: string;
            text?: string;
          }>;
        };
      }
    ).conversation;
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
      conversation?.messages?.find(
        (message) => message.id === "msg-plugin-auth-pause",
      ),
    ).toMatchObject({
      meta: {
        replied: true,
        skippedReason: undefined,
      },
    });
  });

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
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: {
          messages?: Array<{
            id?: string;
            meta?: { replied?: boolean; skippedReason?: string };
          }>;
          processing?: { activeTurnId?: string };
        };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBe(activeSessionId);
    const followUp = conversation?.messages?.find(
      (message) => message.id === "msg-auth-follow-up",
    );
    expect(followUp).toBeDefined();
    expect(followUp?.meta?.replied).toBeUndefined();
    expect(followUp?.meta?.skippedReason).toBeUndefined();
  });
});
