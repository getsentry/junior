import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createOrGetDispatch } from "@/chat/agent-dispatch/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { POST } from "@/handlers/agent-dispatch";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createWaitUntilCollector } from "../fixtures/wait-until";
import { createSignedDispatchCallbackRequest } from "../fixtures/agent-dispatch";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

describe("legacy agent dispatch callback", () => {
  beforeEach(async () => {
    process.env.JUNIOR_SECRET = "dispatch-secret";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    delete process.env.JUNIOR_SECRET;
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("converts an authenticated callback into conversation mailbox work", async () => {
    const created = await createOrGetDispatch({
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        destinationVisibility: "private",
        idempotencyKey: "legacy-callback",
        input: "Run the scheduled task.",
        source: createSlackSource({
          teamId: "T123",
          channelId: "C123",
          visibility: "private",
        }),
      },
      plugin: "scheduler",
    });
    const request = createSignedDispatchCallbackRequest({
      id: created.record.id,
      expectedVersion: 1,
    });
    const waitUntil = createWaitUntilCollector();
    const queue = createConversationWorkQueueTestAdapter();

    await expect(
      POST(request, waitUntil.fn, {
        conversationWorkQueue: queue,
      }),
    ).resolves.toMatchObject({ status: 202 });
    await waitUntil.flush();

    expect(queue.sentRecords()).toEqual([
      {
        conversationId: `agent-dispatch:${created.record.id}`,
        idempotencyKey: `agent-dispatch:${created.record.id}`,
      },
    ]);
    await expect(
      getConversationWorkState({
        conversationId: `agent-dispatch:${created.record.id}`,
      }),
    ).resolves.toMatchObject({
      execution: {
        pendingCount: 1,
        status: "pending",
      },
    });
  });

  it("contains a background enqueue failure after accepting the callback", async () => {
    const created = await createOrGetDispatch({
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        destinationVisibility: "private",
        idempotencyKey: "legacy-callback-failure",
        input: "Run the scheduled task.",
        source: createSlackSource({
          teamId: "T123",
          channelId: "C123",
          visibility: "private",
        }),
      },
      plugin: "scheduler",
    });
    const waitUntil = createWaitUntilCollector();
    const queue = createConversationWorkQueueTestAdapter();
    queue.rejectSends();

    await expect(
      POST(
        createSignedDispatchCallbackRequest({
          id: created.record.id,
          expectedVersion: 1,
        }),
        waitUntil.fn,
        { conversationWorkQueue: queue },
      ),
    ).resolves.toMatchObject({ status: 202 });

    await expect(waitUntil.flush()).resolves.toBeUndefined();
    await expect(
      getConversationWorkState({
        conversationId: `agent-dispatch:${created.record.id}`,
      }),
    ).resolves.toMatchObject({
      execution: {
        pendingCount: 1,
        status: "pending",
      },
    });
  });
});
