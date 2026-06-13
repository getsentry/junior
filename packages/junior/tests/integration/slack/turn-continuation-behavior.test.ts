import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableTurnError } from "@/chat/runtime/turn";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import {
  createSlackBehaviorRuntime,
  threadHasPostText,
} from "../../fixtures/slack/behavior";
import {
  createAwaitingSlackTurnState,
  createPiUserTurn,
} from "../../fixtures/slack/turn-state";
import {
  createTestDestination,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack/harness";

describe("Slack behavior: turn continuation", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it("parks the active session when live execution yields to timeout resume", async () => {
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const conversationId = "slack:C_TIMEOUT:1700000000.000";
    const sessionId = "turn_msg-timeout";
    const { slackRuntime } = createSlackBehaviorRuntime({
      adapters: {
        scheduleAgentContinue,
        generateAssistantReply: async () => {
          throw new RetryableTurnError(
            "agent_continue",
            "simulated timeout continuation",
            {
              conversationId,
              sessionId,
              version: 3,
              sliceId: 2,
            },
          );
        },
      },
    });

    const thread = createTestThread({ id: conversationId });
    const destination = createTestDestination(thread);
    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-timeout",
          threadId: conversationId,
          text: "please keep working",
          isMention: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination,
      sessionId,
      expectedVersion: 3,
    });
    expect(thread.posts).toEqual([]);

    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: {
          processing?: { activeTurnId?: string };
        };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBe(sessionId);
  });

  it("reschedules an awaiting turn continuation without replying to the follow-up", async () => {
    const conversationId = "slack:C_TIMEOUT_RETRY:1700000000.000";
    const activeSessionId = "turn_msg-original";
    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingSlackTurnState({ activeSessionId }),
    });
    const destination = createTestDestination(thread);
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      destination,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    const generateAssistantReply = vi.fn();
    const onInputCommitted = vi.fn();
    const onTurnStatePersisted = vi.fn();
    const { slackRuntime } = createSlackBehaviorRuntime({
      adapters: {
        generateAssistantReply,
        getAwaitingAgentContinueRequest,
        scheduleAgentContinue,
      },
    });

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-retry",
          threadId: conversationId,
          text: "what happened?",
          isMention: true,
        }),
        { onInputCommitted, onTurnStatePersisted },
      ),
    ).resolves.toBeUndefined();

    expect(getAwaitingAgentContinueRequest).toHaveBeenCalledWith({
      conversationId,
      sessionId: activeSessionId,
    });
    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(onTurnStatePersisted).toHaveBeenCalledOnce();
    expect(onInputCommitted).toHaveBeenCalledOnce();
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
      (message) => message.id === "msg-retry",
    );
    expect(followUp).toBeDefined();
    expect(followUp?.meta?.replied).toBeUndefined();
    expect(followUp?.meta?.skippedReason).toBeUndefined();
  });

  it("terminalizes malformed awaiting continuations before handling the follow-up", async () => {
    const conversationId = "slack:C_BAD_CONTINUATION:1700000000.000";
    const activeSessionId = "turn_msg-timeout-original";
    const generateAssistantReply = vi
      .fn()
      .mockResolvedValue(successfulAssistantReply("Recovered."));
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: activeSessionId,
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "timeout",
      piMessages: createPiUserTurn("please keep working"),
    });
    const { slackRuntime } = createSlackBehaviorRuntime({
      adapters: {
        generateAssistantReply,
      },
    });

    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingSlackTurnState({ activeSessionId }),
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-timeout-follow-up",
        threadId: conversationId,
        text: "what happened?",
        isMention: true,
      }),
    );

    expect(generateAssistantReply).toHaveBeenCalledOnce();
    expect(threadHasPostText(thread, "Recovered.")).toBe(true);
    const failedRecord = await getAgentTurnSessionRecord(
      conversationId,
      activeSessionId,
    );
    expect(failedRecord?.state).toBe("failed");
    expect(failedRecord?.errorMessage).toBe(
      "Awaiting agent continuation metadata could not be materialized",
    );
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: { processing?: { activeTurnId?: string } };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBeUndefined();
  });

  it("reschedules an awaiting continuation for repeated delivery of the active message", async () => {
    const conversationId = "slack:C_TIMEOUT_DUPLICATE:1700000000.000";
    const activeSessionId = "turn_msg-duplicate";
    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingSlackTurnState({
        activeSessionId,
        userMessageId: "msg-duplicate",
      }),
    });
    const destination = createTestDestination(thread);
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      destination,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    const generateAssistantReply = vi.fn();
    const { slackRuntime } = createSlackBehaviorRuntime({
      adapters: {
        generateAssistantReply,
        getAwaitingAgentContinueRequest,
        scheduleAgentContinue,
      },
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-duplicate",
        threadId: conversationId,
        text: "please keep working",
        isMention: true,
      }),
    );

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    expect(generateAssistantReply).not.toHaveBeenCalled();
  });

  it("does not reschedule an already-replied duplicate continuation message", async () => {
    const conversationId = "slack:C_TIMEOUT_REPLIED_DUP:1700000000.000";
    const activeSessionId = "turn_msg-replied-duplicate";
    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingSlackTurnState({
        activeSessionId,
        replied: true,
        userMessageId: "msg-replied-duplicate",
      }),
    });
    const destination = createTestDestination(thread);
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      destination,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    const generateAssistantReply = vi.fn();
    const onTurnStatePersisted = vi.fn();
    const { slackRuntime } = createSlackBehaviorRuntime({
      adapters: {
        generateAssistantReply,
        getAwaitingAgentContinueRequest,
        scheduleAgentContinue,
      },
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-replied-duplicate",
        threadId: conversationId,
        text: "please keep working",
        isMention: true,
      }),
      { onTurnStatePersisted },
    );

    expect(getAwaitingAgentContinueRequest).not.toHaveBeenCalled();
    expect(scheduleAgentContinue).not.toHaveBeenCalled();
    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(onTurnStatePersisted).toHaveBeenCalledOnce();
    expect(thread.posts).toEqual([]);
  });

  it("does not start a new turn when rescheduling an active continuation fails", async () => {
    const conversationId = "slack:C_TIMEOUT_RETRY_FAIL:1700000000.000";
    const activeSessionId = "turn_msg-original";
    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingSlackTurnState({ activeSessionId }),
    });
    const destination = createTestDestination(thread);
    const scheduleAgentContinue = vi
      .fn()
      .mockRejectedValue(new Error("resume callback unavailable"));
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      destination,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    const generateAssistantReply = vi.fn();
    const { slackRuntime } = createSlackBehaviorRuntime({
      adapters: {
        generateAssistantReply,
        getAwaitingAgentContinueRequest,
        scheduleAgentContinue,
      },
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-retry-fail",
        threadId: conversationId,
        text: "what happened?",
        isMention: true,
      }),
    );

    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(thread.posts).toEqual([
      expect.stringContaining(
        "I ran into an internal error while processing that.",
      ),
    ]);
  });
});
