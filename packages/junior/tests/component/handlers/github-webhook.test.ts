import { createHmac } from "node:crypto";
import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createResourceEventSubscription } from "@/chat/resource-events/store";
import { POST } from "@/handlers/github-webhook";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";

const originalGithubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

function signedRequest(body: unknown, eventName = "pull_request"): Request {
  const rawBody = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", "test-secret")
    .update(rawBody)
    .digest("hex")}`;
  return new Request("https://example.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-delivery": "delivery-1",
      "x-github-event": eventName,
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
}

describe("GitHub webhook handler resource-event ingestion", () => {
  afterEach(() => {
    vi.useRealTimers();
    if (originalGithubWebhookSecret === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = originalGithubWebhookSecret;
    }
  });

  it("accepts signed pull request comment webhooks and enqueues matching subscriptions", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    vi.setSystemTime(1_000);
    const state = createMemoryState();
    const queue = createConversationWorkQueueTestAdapter();
    const subscription = await createResourceEventSubscription(
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        events: ["comment.created"],
        expiresAtMs: 2_000,
        intent: "Watch the PR Junior opened for reviewer comments.",
        label: "GitHub PR getsentry/junior#691",
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        resourceType: "pull_request",
      },
      { nowMs: 1_000, state },
    );

    const response = await POST(
      signedRequest(
        {
          action: "created",
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
        },
        "issue_comment",
      ),
      { queue, state },
    );

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("Accepted");
    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: `resource-event:${subscription.id}:github:delivery-1:comment.created`,
      },
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]).toMatchObject({
      source: "resource_event",
      input: {
        text: expect.stringContaining("please add regression coverage"),
        metadata: {
          kind: "resource_event",
          route: "subscribed",
          resourceEvent: {
            eventType: "comment.created",
            provider: "github",
            resourceRef: "github:pull_request:getsentry/junior#691",
            subscriptionId: subscription.id,
          },
        },
      },
    });
  });
});
