import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resumeTimedOutTurnWithLockRetry,
  type TimeoutResumeRunnerOptions,
} from "@/chat/runtime/timeout-resume-runner";
import { ResumeTurnBusyError } from "@/chat/runtime/slack-resume";
import {
  cleanupTimeoutResumeRunnerTest,
  createResumeSlackTurnMock,
  setupTimeoutResumeRunnerTest,
  TIMEOUT_RESUME_DESTINATION,
} from "../../fixtures/timeout-resume-runner";

describe("timeout resume runner lock retry", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await setupTimeoutResumeRunnerTest();
  });

  afterEach(cleanupTimeoutResumeRunnerTest);

  it("retries when the timeout-resume callback races the active thread lock", async () => {
    const conversationId = "slack:C123:1712345.0005";
    const payload = {
      conversationId,
      destination: TIMEOUT_RESUME_DESTINATION,
      sessionId: "turn_msg_5",
      expectedVersion: 1,
    };
    const resumeSlackTurn = createResumeSlackTurnMock();
    resumeSlackTurn
      .mockRejectedValueOnce(new ResumeTurnBusyError(conversationId))
      .mockResolvedValueOnce(true);

    const result = resumeTimedOutTurnWithLockRetry(payload, {
      resumeSlackTurn,
    });
    await vi.runOnlyPendingTimersAsync();

    await expect(result).resolves.toBe(true);
    expect(resumeSlackTurn).toHaveBeenCalledTimes(2);
  });

  it("reschedules when the timeout-resume callback remains lock-busy", async () => {
    const conversationId = "slack:C123:1712345.0006";
    const payload = {
      conversationId,
      destination: TIMEOUT_RESUME_DESTINATION,
      sessionId: "turn_msg_6",
      expectedVersion: 1,
    };
    const resumeSlackTurn = createResumeSlackTurnMock();
    const scheduleTurnTimeoutResume = vi
      .fn<
        NonNullable<TimeoutResumeRunnerOptions["scheduleTurnTimeoutResume"]>
      >()
      .mockResolvedValue(undefined);
    resumeSlackTurn.mockRejectedValue(new ResumeTurnBusyError(conversationId));

    const result = resumeTimedOutTurnWithLockRetry(payload, {
      resumeSlackTurn,
      scheduleTurnTimeoutResume,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(true);
    expect(resumeSlackTurn).toHaveBeenCalledTimes(4);
    expect(scheduleTurnTimeoutResume).toHaveBeenCalledWith(payload);
  });
});
