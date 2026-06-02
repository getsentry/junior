import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  scheduleTurnTimeoutResume,
  verifyTurnTimeoutResumeRequest,
} from "@/chat/services/timeout-resume";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";

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

class FakeQueue implements ConversationWorkQueue {
  sent: Array<{
    conversationId: string;
    delayMs?: number;
    idempotencyKey?: string;
  }> = [];

  async send(
    message: { conversationId: string },
    options?: { delayMs?: number; idempotencyKey?: string },
  ): Promise<{ messageId: string }> {
    this.sent.push({
      conversationId: message.conversationId,
      delayMs: options?.delayMs,
      idempotencyKey: options?.idempotencyKey,
    });
    return { messageId: `queue-${this.sent.length}` };
  }
}

function makeSignedResumeRequest(body: Record<string, unknown>): Request {
  const timestamp = Date.now().toString();
  const serializedBody = JSON.stringify(body);
  const signature = createHmac("sha256", "resume-secret")
    .update(`junior.turn_timeout_resume.v1:${timestamp}:${serializedBody}`)
    .digest("hex");
  return new Request("https://junior.example.com/api/internal/turn-resume", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-junior-resume-timestamp": timestamp,
      "x-junior-resume-signature": `v1=${signature}`,
    },
    body: serializedBody,
  });
}

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
    const queue = new FakeQueue();
    const conversationId = "slack:C123:1712345.0001";

    await scheduleTurnTimeoutResume(
      {
        conversationId,
        sessionId: "turn_msg_1",
        expectedVersion: 3,
      },
      { queue, nowMs: 1_000 },
    );

    expect(queue.sent).toEqual([
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
    const request = makeSignedResumeRequest({
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
    const request = makeSignedResumeRequest({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedCheckpointVersion: 3,
    });

    await expect(verifyTurnTimeoutResumeRequest(request)).resolves.toEqual({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });
  });

  it("rejects requests whose signature does not match the body", async () => {
    const request = makeSignedResumeRequest({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });
    const headers = new Headers(request.headers);
    headers.set("x-junior-resume-signature", "v1=deadbeef");
    const tampered = new Request(request.url, {
      method: request.method,
      headers,
      body: await request.text(),
    });

    await expect(
      verifyTurnTimeoutResumeRequest(tampered),
    ).resolves.toBeUndefined();
  });

  it("requires the Junior secret to verify legacy callbacks", async () => {
    const request = makeSignedResumeRequest({
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
