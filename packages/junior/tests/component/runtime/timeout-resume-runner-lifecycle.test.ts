import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resumeTimedOutTurn,
  type TimeoutResumeRunnerOptions,
} from "@/chat/runtime/timeout-resume-runner";
import * as threadStateModule from "@/chat/runtime/thread-state";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { RetryableTurnError } from "@/chat/runtime/turn";
import { getStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import {
  cleanupTimeoutResumeRunnerTest,
  createResumeSlackTurnMock,
  createTimeoutResumeScenario,
  prepareResumeArgs,
  setupTimeoutResumeRunnerTest,
  TIMEOUT_RESUME_DESTINATION,
} from "../../fixtures/timeout-resume-runner";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";

describe("timeout resume runner lifecycle", () => {
  beforeEach(setupTimeoutResumeRunnerTest);
  afterEach(cleanupTimeoutResumeRunnerTest);

  it("drops stale callbacks after the resume lock is acquired", async () => {
    const { conversationId, payload, sessionId, sessionRecord } =
      await createTimeoutResumeScenario({
        conversationId: "slack:C123:1712345.0000",
        messageId: "msg.0",
        sessionId: "turn_msg_0",
      });
    const resumeSlackTurn = createResumeSlackTurnMock();
    resumeSlackTurn.mockImplementationOnce(async (args) => {
      await upsertAgentTurnSessionRecord({
        conversationId,
        sessionId,
        sliceId: sessionRecord.sliceId,
        state: "completed",
        piMessages: sessionRecord.piMessages,
      });

      return (await prepareResumeArgs(args)) !== false;
    });

    await expect(
      resumeTimedOutTurn(payload, { resumeSlackTurn }),
    ).resolves.toBe(false);
  });

  it("re-enqueues the next slice when a resumed turn times out again", async () => {
    const { conversationId, payload, sessionId, sessionRecord } =
      await createTimeoutResumeScenario({
        conversationId: "slack:C123:1712345.0001",
      });
    const resumeSlackTurn = createResumeSlackTurnMock();
    const scheduleTurnTimeoutResume = vi
      .fn<
        NonNullable<TimeoutResumeRunnerOptions["scheduleTurnTimeoutResume"]>
      >()
      .mockResolvedValue(undefined);
    resumeSlackTurn.mockImplementationOnce(async (args) => {
      const runArgs = await prepareResumeArgs(args);
      if (runArgs === false) return false;
      await runArgs.onTimeoutPause?.(
        new RetryableTurnError("turn_timeout_resume", "timed out again", {
          conversationId,
          sessionId,
          version: sessionRecord.version + 1,
          sliceId: sessionRecord.sliceId + 1,
        }),
      );
      return true;
    });

    await expect(
      resumeTimedOutTurn(payload, {
        resumeSlackTurn,
        scheduleTurnTimeoutResume,
      }),
    ).resolves.toBe(true);

    expect(scheduleTurnTimeoutResume).toHaveBeenCalledWith({
      conversationId,
      destination: TIMEOUT_RESUME_DESTINATION,
      sessionId,
      expectedVersion: sessionRecord.version + 1,
    });
  });

  it("leaves persisted state unchanged when completion persistence fails after delivery", async () => {
    const { conversationId, payload, sessionId } =
      await createTimeoutResumeScenario({
        conversationId: "slack:C123:1712345.0002",
      });
    const resumeSlackTurn = createResumeSlackTurnMock();
    vi.spyOn(threadStateModule, "persistThreadStateById").mockRejectedValueOnce(
      new Error("state write failed"),
    );
    resumeSlackTurn.mockImplementationOnce(async (args) => {
      const runArgs = await prepareResumeArgs(args);
      if (runArgs === false) return false;
      await runArgs.onSuccess?.(
        successfulAssistantReply("Final resumed answer", {
          diagnostics: {
            outcome: "success",
            assistantMessageCount: 1,
            toolCalls: [],
            toolResultCount: 0,
            toolErrorCount: 0,
            usedPrimaryText: true,
          },
        }),
      );
      return true;
    });

    await expect(
      resumeTimedOutTurn(payload, { resumeSlackTurn }),
    ).rejects.toThrow("state write failed");

    const persisted = await getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      processing?: { activeTurnId?: string };
      messages?: Array<{ role?: string; text?: string }>;
    };
    expect(conversation.processing?.activeTurnId).toBe(sessionId);
    expect(conversation.messages).toHaveLength(1);
  });

  it("persists timeout-resume failure state when continuation scheduling fails", async () => {
    const { conversationId, payload, sessionId, sessionRecord } =
      await createTimeoutResumeScenario({
        conversationId: "slack:C123:1712345.0003",
        sliceId: 5,
      });
    const resumeSlackTurn = createResumeSlackTurnMock();
    const scheduleTurnTimeoutResume = vi
      .fn<
        NonNullable<TimeoutResumeRunnerOptions["scheduleTurnTimeoutResume"]>
      >()
      .mockRejectedValueOnce(new Error("queue unavailable"));
    resumeSlackTurn.mockImplementationOnce(async (args) => {
      const runArgs = await prepareResumeArgs(args);
      if (runArgs === false) return false;
      try {
        await runArgs.onTimeoutPause?.(
          new RetryableTurnError("turn_timeout_resume", "timed out again", {
            conversationId,
            sessionId,
            version: sessionRecord.version + 1,
            sliceId: 6,
          }),
        );
      } catch (error) {
        const adapter = getStateAdapter();
        const originalGet = adapter.get.bind(adapter);
        vi.spyOn(adapter, "get").mockImplementation(async (key: string) => {
          if (key.startsWith("junior:agent_turn_session:")) {
            throw new Error("session record store unavailable");
          }
          return await originalGet(key);
        });
        await runArgs.onFailure?.(error);
      }
      return true;
    });

    await expect(
      resumeTimedOutTurn(payload, {
        resumeSlackTurn,
        scheduleTurnTimeoutResume,
      }),
    ).resolves.toBe(true);

    expect(scheduleTurnTimeoutResume).toHaveBeenCalledWith({
      conversationId,
      destination: TIMEOUT_RESUME_DESTINATION,
      sessionId,
      expectedVersion: sessionRecord.version + 1,
    });

    const persisted = await getPersistedThreadState(conversationId);
    const conversation = (persisted.conversation ?? {}) as {
      processing?: { activeTurnId?: string };
    };
    expect(conversation.processing?.activeTurnId).toBeUndefined();
  });
});
