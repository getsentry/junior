import { createHmac } from "node:crypto";
import type { StateAdapter } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST, normalizeGitHubResourceEvents } from "@/handlers/github-webhook";

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

afterEach(() => {
  vi.useRealTimers();
  if (originalGithubWebhookSecret === undefined) {
    delete process.env.GITHUB_WEBHOOK_SECRET;
  } else {
    process.env.GITHUB_WEBHOOK_SECRET = originalGithubWebhookSecret;
  }
});

describe("normalizeGitHubResourceEvents", () => {
  it("normalizes merged pull request events", () => {
    vi.setSystemTime(1_000);

    expect(
      normalizeGitHubResourceEvents({
        deliveryId: "delivery-1",
        eventName: "pull_request",
        body: {
          action: "closed",
          repository: { full_name: "getsentry/junior" },
          pull_request: { number: 691, merged: true },
        },
      }),
    ).toEqual([
      {
        eventKey: "github:delivery-1:state.merged",
        eventType: "state.merged",
        occurredAtMs: 1_000,
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        terminal: true,
        trustedSummary: "GitHub PR getsentry/junior#691 was merged.",
      },
    ]);
  });

  it("normalizes requested-changes review events with untrusted text", () => {
    vi.setSystemTime(1_000);

    expect(
      normalizeGitHubResourceEvents({
        deliveryId: "delivery-2",
        eventName: "pull_request_review",
        body: {
          action: "submitted",
          repository: { full_name: "getsentry/junior" },
          pull_request: { number: 691 },
          review: {
            body: "please handle the edge case",
            state: "changes_requested",
            user: { login: "reviewer" },
          },
        },
      }),
    ).toEqual([
      {
        eventKey: "github:delivery-2:review.changes_requested",
        eventType: "review.changes_requested",
        occurredAtMs: 1_000,
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        trustedSummary:
          "GitHub PR getsentry/junior#691 received requested changes from reviewer.",
        untrustedText: "please handle the edge case",
      },
    ]);
  });

  it("normalizes comment-only review events with untrusted text", () => {
    vi.setSystemTime(1_000);

    expect(
      normalizeGitHubResourceEvents({
        deliveryId: "delivery-commented-review",
        eventName: "pull_request_review",
        body: {
          action: "submitted",
          repository: { full_name: "getsentry/junior" },
          pull_request: { number: 691 },
          review: {
            body: "overall this looks close",
            state: "COMMENTED",
            user: { login: "reviewer" },
          },
        },
      }),
    ).toEqual([
      {
        eventKey: "github:delivery-commented-review:review.commented",
        eventType: "review.commented",
        occurredAtMs: 1_000,
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        trustedSummary:
          "GitHub PR getsentry/junior#691 received a review comment from reviewer.",
        untrustedText: "overall this looks close",
      },
    ]);
  });

  it("normalizes pull request issue comments with untrusted text", () => {
    vi.setSystemTime(1_000);

    expect(
      normalizeGitHubResourceEvents({
        deliveryId: "delivery-pr-comment",
        eventName: "issue_comment",
        body: {
          action: "created",
          repository: { full_name: "getsentry/junior" },
          issue: {
            number: 691,
            pull_request: {
              url: "https://api.github.com/repos/getsentry/junior/pulls/691",
            },
          },
          comment: {
            body: "could you add a changelog note?",
            user: { login: "reviewer" },
          },
        },
      }),
    ).toEqual([
      {
        eventKey: "github:delivery-pr-comment:comment.created",
        eventType: "comment.created",
        occurredAtMs: 1_000,
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        trustedSummary:
          "GitHub PR getsentry/junior#691 received a comment from reviewer.",
        untrustedText: "could you add a changelog note?",
      },
    ]);
  });

  it("ignores issue comments that are not on pull requests", () => {
    expect(
      normalizeGitHubResourceEvents({
        deliveryId: "delivery-issue-comment",
        eventName: "issue_comment",
        body: {
          action: "created",
          repository: { full_name: "getsentry/junior" },
          issue: { number: 691 },
          comment: {
            body: "plain issue comment",
            user: { login: "reviewer" },
          },
        },
      }),
    ).toEqual([]);
  });

  it("normalizes inline review comments with untrusted text", () => {
    vi.setSystemTime(1_000);

    expect(
      normalizeGitHubResourceEvents({
        deliveryId: "delivery-inline-comment",
        eventName: "pull_request_review_comment",
        body: {
          action: "created",
          repository: { full_name: "getsentry/junior" },
          pull_request: { number: 691 },
          comment: {
            body: "this branch needs the null case",
            user: { login: "reviewer" },
          },
        },
      }),
    ).toEqual([
      {
        eventKey: "github:delivery-inline-comment:review_comment.created",
        eventType: "review_comment.created",
        occurredAtMs: 1_000,
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        trustedSummary:
          "GitHub PR getsentry/junior#691 received an inline review comment from reviewer.",
        untrustedText: "this branch needs the null case",
      },
    ]);
  });

  it("normalizes completed check suite events for pull requests", () => {
    vi.setSystemTime(1_000);

    expect(
      normalizeGitHubResourceEvents({
        deliveryId: "delivery-3",
        eventName: "check_suite",
        body: {
          action: "completed",
          repository: { full_name: "getsentry/junior" },
          check_suite: {
            conclusion: "failure",
            head_sha: "abcdef1234567890",
            pull_requests: [{ number: 691 }, { number: 702 }],
          },
        },
      }),
    ).toEqual([
      {
        eventKey: "github:delivery-3:checks.failed:691",
        eventType: "checks.failed",
        occurredAtMs: 1_000,
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        trustedSummary:
          "GitHub PR getsentry/junior#691 checks failed for abcdef123456.",
      },
      {
        eventKey: "github:delivery-3:checks.failed:702",
        eventType: "checks.failed",
        occurredAtMs: 1_000,
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#702",
        trustedSummary:
          "GitHub PR getsentry/junior#702 checks failed for abcdef123456.",
      },
    ]);
  });

  it("ignores unsupported GitHub webhook actions", () => {
    expect(
      normalizeGitHubResourceEvents({
        deliveryId: "delivery-4",
        eventName: "pull_request",
        body: {
          action: "synchronize",
          repository: { full_name: "getsentry/junior" },
          pull_request: { number: 691, merged: false },
        },
      }),
    ).toEqual([]);
  });
});

describe("GitHub webhook handler", () => {
  it("rejects unsigned requests before creating the queue", async () => {
    const queue = vi.fn(() => {
      throw new Error("queue should not be created");
    });

    const response = await POST(
      new Request("https://example.test/api/webhooks/github", {
        method: "POST",
        body: "{}",
      }),
      { queue },
    );

    expect(response.status).toBe(401);
    expect(queue).not.toHaveBeenCalled();
  });

  it("ignores signed but unsupported events before creating the queue", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const queue = vi.fn(() => {
      throw new Error("queue should not be created");
    });

    const response = await POST(
      signedRequest({
        action: "synchronize",
        repository: { full_name: "getsentry/junior" },
        pull_request: { number: 691, merged: false },
      }),
      { queue },
    );

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("Ignored");
    expect(queue).not.toHaveBeenCalled();
  });

  it("uses the injected state adapter for supported event subscription lookup", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const state = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      acquireLock: vi.fn(async () => undefined),
      releaseLock: vi.fn(async () => {}),
    } as unknown as StateAdapter;

    const response = await POST(
      signedRequest({
        action: "closed",
        repository: { full_name: "getsentry/junior" },
        pull_request: { number: 691, merged: true },
      }),
      {
        queue: { send: vi.fn(async () => undefined) },
        state,
      },
    );

    expect(response.status).toBe(202);
    expect(state.connect).toHaveBeenCalled();
    expect(state.get).toHaveBeenCalled();
  });

  it("runs subscription lookup for every PR in a check suite event", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const state = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      acquireLock: vi.fn(async () => undefined),
      releaseLock: vi.fn(async () => {}),
    } as unknown as StateAdapter;

    const response = await POST(
      signedRequest(
        {
          action: "completed",
          repository: { full_name: "getsentry/junior" },
          check_suite: {
            conclusion: "success",
            head_sha: "abcdef1234567890",
            pull_requests: [{ number: 691 }, { number: 702 }],
          },
        },
        "check_suite",
      ),
      {
        queue: { send: vi.fn(async () => undefined) },
        state,
      },
    );

    expect(response.status).toBe(202);
    expect(state.connect).toHaveBeenCalledTimes(2);
    expect(state.get).toHaveBeenCalledTimes(2);
  });
});
