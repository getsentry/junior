import type { StateAdapter } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "@/chat/db";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { ingestResourceEvent } from "@/chat/resource-events/ingest";
import {
  cancelResourceEventSubscription,
  createResourceEventSubscription,
  deliverResourceEventSubscription,
  findMatchingResourceEventSubscriptions,
  listResourceEventSubscriptions,
} from "@/chat/resource-events/store";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";

function createRecordingStateAdapter() {
  const values = new Map<string, unknown>();
  const set = vi.fn(async (key: string, value: unknown, _ttlMs?: number) => {
    values.set(key, value);
    return undefined;
  });
  return {
    state: {
      connect: async () => {},
      disconnect: async () => {},
      get: async (key: string) => values.get(key),
      set,
      acquireLock: async (threadId: string) => ({
        threadId,
        token: `lock:${threadId}`,
        expiresAt: Date.now() + 10_000,
      }),
      extendLock: async () => true,
      releaseLock: async () => {},
    } as unknown as StateAdapter,
    set,
  };
}

function createGithubPrSubscription(input: {
  events: string[];
  expiresAtMs?: number;
  intent?: string;
  nowMs?: number;
  state?: StateAdapter;
}) {
  return createResourceEventSubscription(
    {
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      events: input.events,
      expiresAtMs: input.expiresAtMs ?? 2_000_000,
      intent: input.intent ?? "Watch the PR Junior opened.",
      label: "GitHub PR getsentry/junior#691",
      provider: "github",
      resourceRef: "github:pull_request:getsentry/junior#691",
      resourceType: "pull_request",
    },
    { nowMs: input.nowMs ?? 1_000, state: input.state },
  );
}

describe("resource event subscriptions", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await closeDb();
    await disconnectStateAdapter();
  });

  it("enqueues matching events as conversation mailbox messages", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const subscription = await createGithubPrSubscription({
      events: ["checks.failed"],
      intent: "Watch the PR Junior opened for CI failures.",
    });

    await expect(
      ingestResourceEvent(
        {
          eventKey: "delivery-1:check-suite-1",
          eventType: "checks.failed",
          occurredAtMs: 1_500,
          provider: "github",
          resourceRef: "github:pull_request:getsentry/junior#691",
          trustedSummary: "CI failed on workflow test.",
        },
        { nowMs: 1_500, queue },
      ),
    ).resolves.toEqual({ enqueued: 1 });

    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: `resource-event:${subscription.id}:delivery-1:check-suite-1`,
      },
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]).toMatchObject({
      source: "resource_event",
      input: {
        text: expect.stringContaining("CI failed on workflow test."),
        metadata: {
          kind: "resource_event",
          installation: {
            teamId: "T123",
          },
          route: "subscribed",
          resourceEvent: {
            eventType: "checks.failed",
            provider: "github",
            resourceRef: "github:pull_request:getsentry/junior#691",
            subscriptionId: subscription.id,
          },
        },
      },
    });
  });

  it("completes subscriptions after terminal event delivery", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const subscription = await createGithubPrSubscription({
      events: ["state.merged"],
      intent: "Report when the PR lands.",
    });

    await ingestResourceEvent(
      {
        eventKey: "delivery-2:merged",
        eventType: "state.merged",
        occurredAtMs: 1_500,
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        terminal: true,
        trustedSummary: "The pull request was merged.",
      },
      { nowMs: 1_500, queue },
    );

    await expect(
      listResourceEventSubscriptions({
        conversationId: CONVERSATION_ID,
        nowMs: 1_600,
      }),
    ).resolves.not.toContainEqual(
      expect.objectContaining({ id: subscription.id }),
    );
  });

  it("does not enqueue duplicate provider event keys twice", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const subscription = await createGithubPrSubscription({
      events: ["checks.failed"],
    });
    const event = {
      eventKey: "delivery-3:check-suite-1",
      eventType: "checks.failed",
      occurredAtMs: 1_500,
      provider: "github",
      resourceRef: "github:pull_request:getsentry/junior#691",
      trustedSummary: "CI failed on workflow test.",
    };

    await expect(
      ingestResourceEvent(event, { nowMs: 1_500, queue }),
    ).resolves.toEqual({ enqueued: 1 });
    await expect(
      ingestResourceEvent(event, { nowMs: 1_600, queue }),
    ).resolves.toEqual({ enqueued: 0 });

    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: `resource-event:${subscription.id}:delivery-3:check-suite-1`,
      },
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(work?.messages).toHaveLength(1);
  });

  it("does not enqueue cancelled subscriptions", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const subscription = await createGithubPrSubscription({
      events: ["checks.failed"],
    });

    await cancelResourceEventSubscription({
      conversationId: CONVERSATION_ID,
      id: subscription.id,
      nowMs: 1_200,
    });

    await expect(
      ingestResourceEvent(
        {
          eventKey: "delivery-4:check-suite-1",
          eventType: "checks.failed",
          occurredAtMs: 1_500,
          provider: "github",
          resourceRef: "github:pull_request:getsentry/junior#691",
          trustedSummary: "CI failed on workflow test.",
        },
        { nowMs: 1_500, queue },
      ),
    ).resolves.toEqual({ enqueued: 0 });
    expect(queue.sentRecords()).toEqual([]);
  });

  it("does not deliver from a stale match after cancellation", async () => {
    const subscription = await createGithubPrSubscription({
      events: ["checks.failed"],
    });
    const matches = await findMatchingResourceEventSubscriptions({
      eventType: "checks.failed",
      nowMs: 1_500,
      provider: "github",
      resourceRef: "github:pull_request:getsentry/junior#691",
    });
    expect(matches).toEqual([expect.objectContaining({ id: subscription.id })]);

    await cancelResourceEventSubscription({
      conversationId: CONVERSATION_ID,
      id: subscription.id,
      nowMs: 1_600,
    });

    const deliver = vi.fn(async () => true);
    await expect(
      deliverResourceEventSubscription({
        deliver,
        eventType: "checks.failed",
        nowMs: 1_700,
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        subscription: matches[0]!,
      }),
    ).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("waits for a contended delivery lock before delivering all matches", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const baseState = getStateAdapter();
    await baseState.connect();
    let contendedSubscriptionId: string | undefined;
    let contendedAttempts = 0;
    const state = {
      connect: async () => {
        await baseState.connect();
      },
      disconnect: async () => {
        await baseState.disconnect();
      },
      get: async (key: string) => await baseState.get(key),
      set: async (key: string, value: unknown, ttlMs?: number) =>
        await baseState.set(key, value, ttlMs),
      delete: async (key: string) => await baseState.delete(key),
      acquireLock: async (key: string, ttlMs?: number) => {
        if (
          contendedSubscriptionId &&
          key.endsWith(`:${contendedSubscriptionId}`) &&
          contendedAttempts < 2
        ) {
          contendedAttempts += 1;
          return null;
        }
        return await baseState.acquireLock(key, ttlMs ?? 10_000);
      },
      extendLock: async (
        lock: Parameters<StateAdapter["extendLock"]>[0],
        ttlMs: number,
      ) => await baseState.extendLock(lock, ttlMs),
      releaseLock: async (
        lock: Awaited<ReturnType<StateAdapter["acquireLock"]>>,
      ) => {
        if (lock) {
          await baseState.releaseLock(lock);
        }
      },
    } as StateAdapter;
    const contendedSubscription = await createGithubPrSubscription({
      events: ["checks.failed"],
      state,
    });
    await createResourceEventSubscription(
      {
        conversationId: "slack:C456:1712345.0002",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C456",
        },
        events: ["checks.failed"],
        expiresAtMs: 2_000_000,
        intent: "Watch the PR from the second conversation.",
        label: "GitHub PR getsentry/junior#691",
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        resourceType: "pull_request",
      },
      { nowMs: 1_000, state },
    );
    contendedSubscriptionId = contendedSubscription.id;

    await expect(
      ingestResourceEvent(
        {
          eventKey: "delivery-5:check-suite-1",
          eventType: "checks.failed",
          occurredAtMs: 1_500,
          provider: "github",
          resourceRef: "github:pull_request:getsentry/junior#691",
          trustedSummary: "CI failed on workflow test.",
        },
        { nowMs: 1_500, queue, state },
      ),
    ).resolves.toEqual({ enqueued: 2 });
    expect(contendedAttempts).toBe(2);

    expect(queue.sentRecords()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: CONVERSATION_ID }),
        expect.objectContaining({
          conversationId: "slack:C456:1712345.0002",
        }),
      ]),
    );
  });

  it("keeps the subscription lock leased during a long delivery", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const state = getStateAdapter();
    await state.connect();
    const subscription = await createGithubPrSubscription({
      events: ["checks.failed"],
      state,
    });
    let finishDelivery: (() => void) | undefined;
    const delivery = deliverResourceEventSubscription({
      eventType: "checks.failed",
      nowMs: 1_500,
      provider: "github",
      resourceRef: "github:pull_request:getsentry/junior#691",
      state,
      subscription,
      deliver: async () =>
        await new Promise<boolean>((resolve) => {
          finishDelivery = () => resolve(true);
        }),
    });

    await vi.advanceTimersByTimeAsync(12_000);

    await expect(
      state.acquireLock(
        `junior:resource_event_subscription:lock:${subscription.id}`,
        10_000,
      ),
    ).resolves.toBeNull();

    finishDelivery?.();
    await expect(delivery).resolves.toBe(true);
  });

  it("recovers after a transient subscription lock heartbeat failure", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const baseState = getStateAdapter();
    await baseState.connect();
    let extendAttempts = 0;
    const state = new Proxy(baseState, {
      get(target, property, receiver) {
        if (property === "extendLock") {
          return async (
            lock: Parameters<StateAdapter["extendLock"]>[0],
            ttlMs: number,
          ) => {
            extendAttempts += 1;
            if (extendAttempts === 1) {
              throw new Error("transient state backend failure");
            }
            return await target.extendLock(lock, ttlMs);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StateAdapter;
    const subscription = await createGithubPrSubscription({
      events: ["checks.failed"],
      state,
    });
    const delivery = deliverResourceEventSubscription({
      eventType: "checks.failed",
      nowMs: 1_500,
      provider: "github",
      resourceRef: "github:pull_request:getsentry/junior#691",
      state,
      subscription,
      deliver: async () => {
        await new Promise((resolve) => setTimeout(resolve, 7_000));
        return true;
      },
    });

    await vi.advanceTimersByTimeAsync(7_000);

    await expect(delivery).resolves.toBe(true);
    expect(extendAttempts).toBe(2);
  });

  it("does not complete a subscription refreshed during terminal delivery", async () => {
    const subscription = await createGithubPrSubscription({
      events: ["state.merged"],
      expiresAtMs: 2_000_000,
      intent: "Report when the PR lands.",
      nowMs: 1_000,
    });

    await expect(
      deliverResourceEventSubscription({
        eventType: "state.merged",
        nowMs: 1_500,
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        subscription,
        terminal: true,
        deliver: async () => {
          await createGithubPrSubscription({
            events: ["state.merged"],
            expiresAtMs: 3_000_000,
            intent: "Keep watching the refreshed PR subscription.",
            nowMs: 1_400,
          });
          return true;
        },
      }),
    ).resolves.toBe(true);

    await expect(
      listResourceEventSubscriptions({
        conversationId: CONVERSATION_ID,
        nowMs: 1_600,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: subscription.id,
        expiresAtMs: 3_000_000,
        status: "active",
      }),
    ]);
  });

  it("does not enqueue expired subscriptions", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await createGithubPrSubscription({
      events: ["checks.failed"],
      expiresAtMs: 1_400,
    });

    await expect(
      ingestResourceEvent(
        {
          eventKey: "delivery-5:check-suite-1",
          eventType: "checks.failed",
          occurredAtMs: 1_500,
          provider: "github",
          resourceRef: "github:pull_request:getsentry/junior#691",
          trustedSummary: "CI failed on workflow test.",
        },
        { nowMs: 1_500, queue },
      ),
    ).resolves.toEqual({ enqueued: 0 });
    expect(queue.sentRecords()).toEqual([]);
  });

  it("stores active records and indexes until the subscription expiry", async () => {
    const nowMs = 1_000;
    const expiresAtMs = nowMs + 30 * 24 * 60 * 60 * 1000;
    const { state, set } = createRecordingStateAdapter();

    await createGithubPrSubscription({
      events: ["checks.failed"],
      expiresAtMs,
      nowMs,
      state,
    });

    const ttlValues = set.mock.calls.map((call) => {
      const ttlMs = call[2];
      if (ttlMs === undefined) {
        throw new Error("Expected subscription state write to include a TTL");
      }
      return ttlMs;
    });
    expect(ttlValues).toHaveLength(3);
    expect(ttlValues).toEqual([
      expiresAtMs - nowMs,
      expiresAtMs - nowMs,
      expiresAtMs - nowMs,
    ]);
    expect(Math.min(...ttlValues)).toBeGreaterThan(JUNIOR_THREAD_STATE_TTL_MS);
  });
});
