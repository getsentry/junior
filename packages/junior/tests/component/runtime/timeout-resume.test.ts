import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  scheduleTurnTimeoutResume,
  verifyTurnTimeoutResumeRequest,
} from "@/chat/services/timeout-resume";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createConversationWorkQueueTestAdapter } from "../../fixtures/conversation-work";
import { createTurnResumeTestClient } from "../../fixtures/turn-resume";

const ORIGINAL_ENV = vi.hoisted(() => {
  const original = {
    JUNIOR_SECRET: process.env.JUNIOR_SECRET,
    JUNIOR_STATE_ADAPTER: process.env.JUNIOR_STATE_ADAPTER,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
  };
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  process.env.JUNIOR_SECRET = "resume-secret";
  return original;
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("timeout resume callback signing", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    process.env.JUNIOR_SECRET = "resume-secret";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    restoreEnv("JUNIOR_STATE_ADAPTER", ORIGINAL_ENV.JUNIOR_STATE_ADAPTER);
    restoreEnv("JUNIOR_SECRET", ORIGINAL_ENV.JUNIOR_SECRET);
    restoreEnv("SLACK_SIGNING_SECRET", ORIGINAL_ENV.SLACK_SIGNING_SECRET);
    vi.restoreAllMocks();
  });

  it("marks timeout continuations runnable and wakes the durable queue", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0001";

    await scheduleTurnTimeoutResume(
      {
        conversationId,
        sessionId: "turn_msg_1",
        expectedVersion: 3,
      },
      { queue, nowMs: 1_000 },
    );

    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
        idempotencyKey: `timeout:${conversationId}:turn_msg_1:3`,
      },
    ]);
    await expect(
      getConversationWorkState({ conversationId }),
    ).resolves.toMatchObject({
      conversationId,
      needsRun: true,
      lastEnqueuedAtMs: 1_000,
    });
  });

  it("still verifies signed callbacks that were already in flight", async () => {
    const client = createTurnResumeTestClient({
      juniorSecret: "resume-secret",
    });
    const request = client.request({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });

    await expect(verifyTurnTimeoutResumeRequest(request)).resolves.toEqual({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });
  });

  it("accepts the previous expected checkpoint version field", async () => {
    const client = createTurnResumeTestClient({
      juniorSecret: "resume-secret",
    });
    const request = client.legacyRequest({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });

    await expect(verifyTurnTimeoutResumeRequest(request)).resolves.toEqual({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });
  });

  it("rejects requests whose signature does not match the body", async () => {
    const client = createTurnResumeTestClient({
      juniorSecret: "resume-secret",
    });
    const request = client.invalidSignature({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });

    await expect(
      verifyTurnTimeoutResumeRequest(request),
    ).resolves.toBeUndefined();
  });

  it("requires the Junior secret to verify legacy callbacks", async () => {
    const client = createTurnResumeTestClient({
      juniorSecret: "resume-secret",
    });
    const request = client.request({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });
    delete process.env.JUNIOR_SECRET;
    process.env.SLACK_SIGNING_SECRET = "slack-secret";

    await expect(
      verifyTurnTimeoutResumeRequest(request),
    ).resolves.toBeUndefined();
  });
});
