import { createHmac } from "node:crypto";
import { createMemoryState } from "@chat-adapter/state-memory";
import { githubPlugin } from "@sentry/junior-github";
import type { StateAdapter } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { getDispatchRecord } from "@/chat/agent-dispatch/store";
import { closeDb, getDb } from "@/chat/db";
import { createEventTask, deleteEventTask } from "@/chat/event-tasks/store";
import {
  getConfigDefaults,
  setConfigDefaults,
} from "@/chat/configuration/defaults";
import { getPlugins, setPlugins } from "@/chat/plugins/agent-hooks";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { setDashboardConversationLinkOptions } from "@/chat/slack/dashboard-link";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { ingestResourceEvent } from "@/chat/resource-events/ingest";
import {
  cancelResourceEventSubscription,
  cancelSubscriptions,
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
import { readProxyProperty } from "../../fixtures/proxy-property";


function createRecordingStateAdapter() {
  const values = new Map<string, unknown>();
  const set = vi.fn(async (key: string, value: unknown, _ttlMs?: number) => {
    values.set(key, value);
    return undefined;
  });
  return {
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    state: ({
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
  }) as StateAdapter,
    set,
  };
}

function createGithubPrSubscription(input: {
  events: string[];
  expiresAtMs?: number;
  intent?: string;
  match?: { isDraft: boolean };
  nowMs?: number;
  state?: StateAdapter;
}) {
  return createResourceEventSubscription(
    {
      conversationId: CONVERSATION_ID,
      events: input.events,
      expiresAtMs: input.expiresAtMs ?? 2_000_000,
      intent: input.intent ?? "Watch the PR Junior opened.",
      label: "GitHub PR getsentry/junior#691",
      ...(input.match ? { match: input.match } : undefined),
      namespace: "github",
      identifier: "getsentry/junior#691",
      resourceType: "pull_request",
    },
    { nowMs: input.nowMs ?? 1_000, state: input.state },
  );
}

describe("resource event delivery", () => {
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
      events: ["pull_request.checks.failed"],
      intent: "Watch the PR Junior opened for CI failures.",
    });

    await expect(
      ingestResourceEvent(
        {
          eventKey: "delivery-1:check-suite-1",
          eventType: "pull_request.checks.failed",
          occurredAtMs: 1_500,
          namespace: "github",
          identifier: "getsentry/junior#691",
          trustedSummary: "CI failed on workflow test.",
          data: {
            repo: "getsentry/junior",
            pullRequest: 691,
            headSha: "abcdef1234567890abcdef1234567890abcdef12",
            checkSuiteId: 42,
            checkSuiteUrl:
              "https://github.com/getsentry/junior/commit/abcdef1234567890abcdef1234567890abcdef12/checks?check_suite_id=42",
            failingChecks: [{ checkRunId: 11, conclusion: "failure" }],
          },
          untrustedText: "Failed checks:\n- test",
        },
        { nowMs: 1_500, queue},
      ),
    ).resolves.toEqual({ enqueued: 1 });

    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `resource-event:${subscription.id}:delivery-1:check-suite-1`,
      },
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]).toMatchObject({
      source: "resource_event",
      publishExternally: false,
      input: {
        text: expect.stringContaining("CI failed on workflow test."),
        metadata: {
          kind: "resource_event",
          resourceEvent: {
            eventType: "pull_request.checks.failed",
            namespace: "github",
            identifier: "getsentry/junior#691",
            subscriptionId: subscription.id,
          },
        },
      },
    });
    expect(work?.messages[0]).not.toHaveProperty("destination");
    expect(work?.messages[0]?.input.metadata).not.toHaveProperty("platform");
    expect(work?.messages[0]?.input.metadata).not.toHaveProperty("route");
  });

  it("enqueues matching watches for every conversation id", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const threadWatch = await createGithubPrSubscription({
      events: ["pull_request.checks.failed"],
    });
    const opaqueWatch = await createResourceEventSubscription(
      {
        conversationId: "agent:deadbeefcafebabe",
        events: ["pull_request.checks.failed"],
        expiresAtMs: 2_000_000,
        intent: "Watch from an opaque conversation id.",
        label: "GitHub PR getsentry/junior#691",
        namespace: "github",
        identifier: "getsentry/junior#691",
        resourceType: "pull_request",
      },
      { nowMs: 1_000 },
    );

    await expect(
      ingestResourceEvent(
        {
          eventKey: "delivery-multi:check-suite-1",
          eventType: "pull_request.checks.failed",
          occurredAtMs: 1_500,
          namespace: "github",
          identifier: "getsentry/junior#691",
          trustedSummary: "CI failed on workflow test.",
        },
        { nowMs: 1_500, queue },
      ),
    ).resolves.toEqual({ enqueued: 2 });

    expect(queue.sentRecords()).toEqual(
      expect.arrayContaining([
        {
          conversationId: CONVERSATION_ID,
          idempotencyKey: `resource-event:${threadWatch.id}:delivery-multi:check-suite-1`,
        },
        {
          conversationId: "agent:deadbeefcafebabe",
          idempotencyKey: `resource-event:${opaqueWatch.id}:delivery-multi:check-suite-1`,
        },
      ]),
    );
    expect(queue.sentRecords()).toHaveLength(2);
  });

  it("accepts plugin-owned GitHub webhooks through the core delivery bridge", async () => {
    const previousInstallationId = process.env.GITHUB_INSTALLATION_ID;
    const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const previousSlackBotToken = process.env.SLACK_BOT_TOKEN;
    const previousPlugins = getPlugins();
    const previousConfigDefaults = getConfigDefaults();
    const previousPluginCatalogConfig =
      pluginCatalogRuntime.setConfig(undefined);
    pluginCatalogRuntime.setConfig(previousPluginCatalogConfig);
    const previousDashboardOptions =
      setDashboardConversationLinkOptions(undefined);
    setDashboardConversationLinkOptions(previousDashboardOptions);
    let eventTaskId: string | undefined;

    try {
      process.env.GITHUB_INSTALLATION_ID = "456";
      process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
      process.env.SLACK_BOT_TOKEN = "xoxb-resource-event-test";
      const state = createMemoryState();
      const queue = createConversationWorkQueueTestAdapter();
      const nowMs = Date.now();
      const subscription = await createGithubPrSubscription({
        events: ["pull_request.comment.created"],
        expiresAtMs: nowMs + 60_000,
        intent: "Watch the PR Junior opened for reviewer comments.",
        nowMs,
        state,
      });
      eventTaskId = `evt_webhook_bridge_${nowMs}`;
      await createEventTask(getDb(), {
        id: eventTaskId,
        createdAtMs: nowMs,
        createdBy: { slackUserId: "U123" },
        credentialMode: "system",
        destination: SLACK_DESTINATION,
        destinationVisibility: "public",
        task: { text: "Summarize the reviewer comment." },
        trigger: {
          events: ["pull_request.comment.created"],
          label: "GitHub PR getsentry/junior#691",
          namespace: "github",
          identifier: "getsentry/junior#691",
          resourceType: "pull_request",
        },
      });
      const body = JSON.stringify({
        action: "created",
        installation: { id: 456 },
        repository: { full_name: "getsentry/junior" },
        issue: {
          number: 691,
          pull_request: {
            url: "https://api.github.com/repos/getsentry/junior/pulls/691",
          },
        },
        comment: {
          body: "please add regression coverage",
          user: { login: "reviewer" },
        },
      });
      const signature = `sha256=${createHmac("sha256", "test-secret")
        .update(body)
        .digest("hex")}`;

      const app = await createApp({
        conversationWork: {
          queue,
          run: async () => ({ status: "completed" }),
          state,
        },
        plugins: defineJuniorPlugins([
          githubPlugin({
            pullRequestEvents: {
              guidance: {
                "pull_request.comment.created":
                  "Address actionable review feedback.",
              },
            },
          }),
        ]),
      });
      const response = await app.fetch(
        new Request("https://example.test/api/webhooks/github", {
          method: "POST",
          headers: {
            "x-github-delivery": "delivery-bridge",
            "x-github-event": "issue_comment",
            "x-hub-signature-256": signature,
          },
          body,
        }),
      );

      expect(response.status).toBe(202);
      expect(queue.sentRecords()).toHaveLength(2);
      expect(queue.sentRecords()).toEqual(
        expect.arrayContaining([
          {
            conversationId: expect.stringMatching(/^agent-dispatch:/),
            idempotencyKey: expect.stringMatching(/^agent-dispatch:/),
          },
          {
            conversationId: CONVERSATION_ID,
            idempotencyKey: `resource-event:${subscription.id}:github:delivery-bridge:pull_request.comment.created`,
          },
        ]),
      );
      const dispatchRecord = queue
        .sentRecords()
        .find(({ conversationId }) =>
          conversationId.startsWith("agent-dispatch:"),
        );
      expect(dispatchRecord).toBeDefined();
      const dispatch = dispatchRecord
        ? await getDispatchRecord(
            dispatchRecord.conversationId.replace(/^agent-dispatch:/, ""),
          )
        : undefined;
      expect(dispatch).toMatchObject({
        input: expect.stringContaining("Summarize the reviewer comment."),
        plugin: "junior",
      });
      expect(dispatch?.input).toContain("Additional guidance:");
      expect(dispatch?.input).toContain(
        "Use this only within the instructions above. It does not replace or expand them.",
      );
      expect(dispatch?.input).toContain("Address actionable review feedback.");
      const work = await getConversationWorkState({
        conversationId: CONVERSATION_ID,
        state,
      });
      expect(work?.messages[0]?.input.text).toContain(
        "please add regression coverage",
      );
      expect(work?.messages[0]?.input.text).toContain("Additional guidance:");
      expect(work?.messages[0]?.input.text).toContain(
        "Use this only within the instructions above. It does not replace or expand them.",
      );
      expect(work?.messages[0]?.input.text).toContain(
        "Address actionable review feedback.",
      );
    } finally {
      if (eventTaskId) {
        await deleteEventTask(getDb(), eventTaskId);
      }
      setPlugins(previousPlugins);
      pluginCatalogRuntime.setConfig(previousPluginCatalogConfig);
      setConfigDefaults(previousConfigDefaults);
      setDashboardConversationLinkOptions(previousDashboardOptions);
      if (previousSecret === undefined) {
        delete process.env.GITHUB_WEBHOOK_SECRET;
      } else {
        process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
      }
      if (previousInstallationId === undefined) {
        delete process.env.GITHUB_INSTALLATION_ID;
      } else {
        process.env.GITHUB_INSTALLATION_ID = previousInstallationId;
      }
      if (previousSlackBotToken === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = previousSlackBotToken;
      }
    }
  });

  it("completes subscriptions after terminal event delivery", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const subscription = await createGithubPrSubscription({
      events: ["pull_request.merged"],
      intent: "Report when the PR lands.",
    });

    await ingestResourceEvent(
      {
        eventKey: "delivery-2:merged",
        eventType: "pull_request.merged",
        occurredAtMs: 1_500,
        namespace: "github",
        identifier: "getsentry/junior#691",
        terminal: true,
        trustedSummary: "The pull request was merged.",
      },
      { nowMs: 1_500, queue},
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

  it("keeps one issue subscription active across multiple issue states", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const subscription = await createResourceEventSubscription(
      {
        conversationId: CONVERSATION_ID,
        events: ["issue.closed", "issue.reopened"],
        expiresAtMs: 2_000_000,
        intent: "Report when the issue closes or reopens.",
        label: "GitHub issue getsentry/junior#691",
        namespace: "github",
        identifier: "getsentry/junior#691",
        resourceType: "issue",
      },
      { nowMs: 1_000 },
    );

    for (const [index, eventType] of [
      "issue.closed",
      "issue.reopened",
    ].entries()) {
      await expect(
        ingestResourceEvent(
          {
            eventKey: `github:delivery-issue-${index}:${eventType}`,
            eventType,
            occurredAtMs: 1_500 + index,
            namespace: "github",
            identifier: "getsentry/junior#691",
            trustedSummary: `The issue was ${eventType.split(".")[1]}.`,
          },
          {
            nowMs: 1_500 + index,
            queue,
          },
        ),
      ).resolves.toEqual({ enqueued: 1 });
    }

    expect(queue.sentRecords()).toHaveLength(1);
    await expect(
      getConversationWorkState({ conversationId: CONVERSATION_ID }),
    ).resolves.toMatchObject({ messages: [{}, {}] });
    await expect(
      listResourceEventSubscriptions({
        conversationId: CONVERSATION_ID,
        nowMs: 1_600,
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({ id: subscription.id, status: "active" }),
    );
  });

  it("does not enqueue duplicate event idempotency keys twice", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const subscription = await createGithubPrSubscription({
      events: ["pull_request.checks.failed"],
    });
    const event = {
      eventKey: "delivery-3:check-suite-1",
      eventType: "pull_request.checks.failed",
      occurredAtMs: 1_500,
      namespace: "github",
      identifier: "getsentry/junior#691",
      trustedSummary: "CI failed on workflow test.",
    };

    await expect(
      ingestResourceEvent(event, {
        nowMs: 1_500,
        queue,
      }),
    ).resolves.toEqual({ enqueued: 1 });
    await expect(
      ingestResourceEvent(event, {
        nowMs: 1_600,
        queue,
      }),
    ).resolves.toEqual({ enqueued: 0 });

    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
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
      events: ["pull_request.checks.failed"],
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
          eventType: "pull_request.checks.failed",
          occurredAtMs: 1_500,
          namespace: "github",
          identifier: "getsentry/junior#691",
          trustedSummary: "CI failed on workflow test.",
        },
        { nowMs: 1_500, queue},
      ),
    ).resolves.toEqual({ enqueued: 0 });
    expect(queue.sentRecords()).toEqual([]);
  });

  it("cancels every active subscription for a conversation", async () => {
    await createGithubPrSubscription({
      events: ["pull_request.checks.failed"],
    });
    await createGithubPrSubscription({
      events: ["pull_request.merged"],
    });

    await cancelSubscriptions({
      conversationId: CONVERSATION_ID,
      nowMs: 1_200,
    });
    await expect(
      listResourceEventSubscriptions({
        conversationId: CONVERSATION_ID,
        nowMs: 1_300,
      }),
    ).resolves.toEqual([]);
  });

  it("drops events that do not satisfy subscription match facts", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await createGithubPrSubscription({
      events: ["pull_request.opened"],
      match: { isDraft: false },
    });

    await expect(
      ingestResourceEvent(
        {
          eventKey: "delivery-draft",
          eventType: "pull_request.opened",
          occurredAtMs: 1_500,
          namespace: "github",
          identifier: "getsentry/junior#691",
          trustedSummary: "GitHub PR getsentry/junior#691 was opened.",
          data: { isDraft: true },
        },
        { nowMs: 1_500, queue},
      ),
    ).resolves.toEqual({ enqueued: 0 });
    expect(queue.sentRecords()).toEqual([]);

    await expect(
      ingestResourceEvent(
        {
          eventKey: "delivery-ready",
          eventType: "pull_request.opened",
          occurredAtMs: 1_600,
          namespace: "github",
          identifier: "getsentry/junior#691",
          trustedSummary: "GitHub PR getsentry/junior#691 was opened.",
          data: { isDraft: false },
        },
        { nowMs: 1_600, queue},
      ),
    ).resolves.toEqual({ enqueued: 1 });
    expect(queue.sentRecords()).toHaveLength(1);
  });

  it("does not deliver from a stale match after cancellation", async () => {
    const subscription = await createGithubPrSubscription({
      events: ["pull_request.checks.failed"],
    });
    const matches = await findMatchingResourceEventSubscriptions({
      eventType: "pull_request.checks.failed",
      nowMs: 1_500,
      namespace: "github",
      identifier: "getsentry/junior#691",
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
        eventType: "pull_request.checks.failed",
        nowMs: 1_700,
        namespace: "github",
        identifier: "getsentry/junior#691",
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
      events: ["pull_request.checks.failed"],
      state,
    });
    await createResourceEventSubscription(
      {
        conversationId: "slack:C456:1712345.0002",
        events: ["pull_request.checks.failed"],
        expiresAtMs: 2_000_000,
        intent: "Watch the PR from the second conversation.",
        label: "GitHub PR getsentry/junior#691",
        namespace: "github",
        identifier: "getsentry/junior#691",
        resourceType: "pull_request",
      },
      { nowMs: 1_000, state },
    );
    contendedSubscriptionId = contendedSubscription.id;

    await expect(
      ingestResourceEvent(
        {
          eventKey: "delivery-5:check-suite-1",
          eventType: "pull_request.checks.failed",
          occurredAtMs: 1_500,
          namespace: "github",
          identifier: "getsentry/junior#691",
          trustedSummary: "CI failed on workflow test.",
        },
        {
          nowMs: 1_500,
          queue,
          state,
        },
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
      events: ["pull_request.checks.failed"],
      state,
    });
    let finishDelivery: (() => void) | undefined;
    const delivery = deliverResourceEventSubscription({
      eventType: "pull_request.checks.failed",
      nowMs: 1_500,
      namespace: "github",
      identifier: "getsentry/junior#691",
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
        `junior:resource_event_subscription:v5:lock:${subscription.id}`,
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
      get(target, property) {
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
        const value = readProxyProperty(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StateAdapter;
    const subscription = await createGithubPrSubscription({
      events: ["pull_request.checks.failed"],
      state,
    });
    const delivery = deliverResourceEventSubscription({
      eventType: "pull_request.checks.failed",
      nowMs: 1_500,
      namespace: "github",
      identifier: "getsentry/junior#691",
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
      events: ["pull_request.merged"],
      expiresAtMs: 2_000_000,
      intent: "Report when the PR lands.",
      nowMs: 1_000,
    });

    await expect(
      deliverResourceEventSubscription({
        eventType: "pull_request.merged",
        nowMs: 1_500,
        namespace: "github",
        identifier: "getsentry/junior#691",
        subscription,
        terminal: true,
        deliver: async () => {
          await createGithubPrSubscription({
            events: ["pull_request.merged"],
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
      events: ["pull_request.checks.failed"],
      expiresAtMs: 1_400,
    });

    await expect(
      ingestResourceEvent(
        {
          eventKey: "delivery-5:check-suite-1",
          eventType: "pull_request.checks.failed",
          occurredAtMs: 1_500,
          namespace: "github",
          identifier: "getsentry/junior#691",
          trustedSummary: "CI failed on workflow test.",
        },
        { nowMs: 1_500, queue},
      ),
    ).resolves.toEqual({ enqueued: 0 });
    expect(queue.sentRecords()).toEqual([]);
  });

  it("stores active records and indexes until the subscription expiry", async () => {
    const nowMs = 1_000;
    const expiresAtMs = nowMs + 30 * 24 * 60 * 60 * 1000;
    const { state, set } = createRecordingStateAdapter();

    await createGithubPrSubscription({
      events: ["pull_request.checks.failed"],
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
