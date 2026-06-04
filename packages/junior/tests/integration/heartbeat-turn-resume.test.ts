import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { getConversationWorkState } from "@/chat/task-execution/store";
import type { PiMessage } from "@/chat/pi/messages";
import { GET as heartbeat } from "@/handlers/heartbeat";
import { scheduleAgentContinue } from "@/chat/services/agent-continue";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import {
  heartbeatRequest,
  persistActiveTurn,
  resetHeartbeatTestEnv,
  SLACK_DESTINATION,
  setupHeartbeatTestEnv,
  TEST_NOW_MS,
} from "../fixtures/heartbeat";
import { createWaitUntilCollector } from "../fixtures/wait-until";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

describe("heartbeat turn resume recovery", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    await setupHeartbeatTestEnv();
  });

  afterEach(async () => {
    await resetHeartbeatTestEnv(originalFetch);
  });

  it("reschedules stale timeout resume records", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0001";
    const sessionId = "turn-timeout";
    const staleNowMs = TEST_NOW_MS - 3 * 60 * 1000;
    vi.setSystemTime(staleNowMs);
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      destination: SLACK_DESTINATION,
      state: "awaiting_resume",
      resumeReason: "timeout",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "finish this" }],
          timestamp: staleNowMs,
        } as PiMessage,
      ],
    });
    await persistActiveTurn(conversationId, sessionId);
    await scheduleAgentContinue(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        sessionId,
        expectedVersion: 1,
      },
      { queue, nowMs: staleNowMs },
    );
    queue.clearSentRecords();
    vi.setSystemTime(TEST_NOW_MS);

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(heartbeatRequest(), waitUntil.fn, {
      conversationWorkQueue: queue,
    });

    expect(response.status).toBe(202);
    await waitUntil.flush();
    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
        destination: SLACK_DESTINATION,
        idempotencyKey: `heartbeat:pending:${conversationId}:${TEST_NOW_MS}`,
      },
    ]);
    await expect(
      getConversationWorkState({ conversationId }),
    ).resolves.toMatchObject({
      conversationId,
      needsRun: true,
    });
  });

  it("reschedules stale cooperative yield resume records", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0008";
    const sessionId = "turn-yield";
    const staleNowMs = TEST_NOW_MS - 3 * 60 * 1000;
    vi.setSystemTime(staleNowMs);
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 1,
      destination: SLACK_DESTINATION,
      state: "awaiting_resume",
      resumeReason: "yield",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "keep going" }],
          timestamp: staleNowMs,
        } as PiMessage,
      ],
    });
    await persistActiveTurn(conversationId, sessionId);
    await scheduleAgentContinue(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        sessionId,
        expectedVersion: 1,
      },
      { queue, nowMs: staleNowMs },
    );
    queue.clearSentRecords();
    vi.setSystemTime(TEST_NOW_MS);

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(heartbeatRequest(), waitUntil.fn, {
      conversationWorkQueue: queue,
    });

    expect(response.status).toBe(202);
    await waitUntil.flush();
    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
        destination: SLACK_DESTINATION,
        idempotencyKey: `heartbeat:pending:${conversationId}:${TEST_NOW_MS}`,
      },
    ]);
    await expect(
      getConversationWorkState({ conversationId }),
    ).resolves.toMatchObject({
      conversationId,
      needsRun: true,
    });
  });

  it("skips stale timeout resume records for inactive turns", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0007";
    const sessionId = "turn-timeout-inactive";
    const staleNowMs = TEST_NOW_MS - 3 * 60 * 1000;
    vi.setSystemTime(staleNowMs);
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      destination: SLACK_DESTINATION,
      state: "awaiting_resume",
      resumeReason: "timeout",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "finish this" }],
          timestamp: staleNowMs,
        } as PiMessage,
      ],
    });
    await persistActiveTurn(conversationId, "turn-newer");
    vi.setSystemTime(TEST_NOW_MS);

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(heartbeatRequest(), waitUntil.fn, {
      conversationWorkQueue: queue,
    });

    expect(response.status).toBe(202);
    await waitUntil.flush();
    expect(queue.sentRecords()).toEqual([]);
    await expect(getConversationWorkState({ conversationId })).resolves.toBe(
      undefined,
    );
  });

  it("does not scan stale timeout resume records outside active conversation work", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0009";
    const sessionId = "turn-timeout-no-active-work";
    const staleNowMs = TEST_NOW_MS - 3 * 60 * 1000;
    vi.setSystemTime(staleNowMs);
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      destination: SLACK_DESTINATION,
      state: "awaiting_resume",
      resumeReason: "timeout",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "finish this" }],
          timestamp: staleNowMs,
        } as PiMessage,
      ],
    });
    await persistActiveTurn(conversationId, sessionId);
    vi.setSystemTime(TEST_NOW_MS);

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(heartbeatRequest(), waitUntil.fn, {
      conversationWorkQueue: queue,
    });

    expect(response.status).toBe(202);
    await waitUntil.flush();
    expect(queue.sentRecords()).toEqual([]);
    await expect(getConversationWorkState({ conversationId })).resolves.toBe(
      undefined,
    );
  });
});
