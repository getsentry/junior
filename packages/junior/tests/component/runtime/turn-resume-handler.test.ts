import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/handlers/turn-resume";
import {
  cleanupTimeoutResumeRunnerTest,
  createResumeSlackTurnMock,
  setupTimeoutResumeRunnerTest,
  TIMEOUT_RESUME_DESTINATION,
} from "../../fixtures/timeout-resume-runner";
import { createTurnResumeTestClient } from "../../fixtures/turn-resume";
import { createWaitUntilCollector } from "../../fixtures/wait-until";

describe("turn resume handler", () => {
  beforeEach(async () => {
    process.env.JUNIOR_SECRET = "resume-secret";
    await setupTimeoutResumeRunnerTest();
  });

  afterEach(async () => {
    await cleanupTimeoutResumeRunnerTest();
    delete process.env.JUNIOR_SECRET;
  });

  it("rejects unauthenticated internal resume callbacks", async () => {
    const waitUntil = createWaitUntilCollector();

    const response = await POST(
      new Request("https://example.com/api/internal/turn-resume", {
        method: "POST",
      }),
      waitUntil.fn,
    );

    expect(response.status).toBe(401);
    expect(waitUntil.pendingCount()).toBe(0);
  });

  it("accepts signed callbacks and runs timeout resume work in waitUntil", async () => {
    const waitUntil = createWaitUntilCollector();
    const resumeSlackTurn = createResumeSlackTurnMock();
    resumeSlackTurn.mockResolvedValueOnce(true);
    const client = createTurnResumeTestClient({
      juniorSecret: "resume-secret",
    });

    const response = await POST(
      client.request({
        conversationId: "slack:C123:1712345.0001",
        destination: TIMEOUT_RESUME_DESTINATION,
        sessionId: "turn_msg_1",
        expectedVersion: 3,
      }),
      waitUntil.fn,
      { resumeSlackTurn },
    );

    expect(response.status).toBe(202);
    expect(waitUntil.pendingCount()).toBe(1);

    await waitUntil.flush();

    expect(resumeSlackTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        threadTs: "1712345.0001",
        lockKey: "slack:C123:1712345.0001",
      }),
    );
  });
});
