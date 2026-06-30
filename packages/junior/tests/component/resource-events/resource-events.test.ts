import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "@/chat/db";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { ingestResourceEvent } from "@/chat/resource-events/ingest";
import {
  cancelResourceEventSubscription,
  createResourceEventSubscription,
  listResourceEventSubscriptions,
} from "@/chat/resource-events/store";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";

function createGithubPrSubscription(input: {
  events: string[];
  expiresAtMs?: number;
  intent?: string;
  nowMs?: number;
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
      source: {
        platform: "slack",
        type: "pub",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1712345.0001",
      },
    },
    { nowMs: input.nowMs ?? 1_000 },
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
      source: "event",
      input: {
        text: expect.stringContaining("CI failed on workflow test."),
        metadata: {
          kind: "resource_event",
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
    ).resolves.toEqual({ enqueued: 1 });

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
});
