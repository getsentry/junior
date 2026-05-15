import type { Message } from "chat";
import { createGitHubAdapter } from "@chat-adapter/github";
import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it } from "vitest";
import { createGitHubRuntime } from "@/chat/app/factory";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import type { WaitUntilFn } from "@/handlers/types";
import { handlePlatformWebhook } from "@/handlers/webhooks";
import {
  githubIssueCommentWebhook,
  githubReviewCommentWebhook,
  signGitHubWebhookBody,
} from "../../fixtures/github/factories/webhooks";
import { getCapturedGitHubApiCalls } from "../../msw/handlers/github-api";

const GITHUB_WEBHOOK_SECRET = "github-webhook-secret";

async function flushWaitUntil(tasks: Array<Promise<unknown>>): Promise<void> {
  for (let index = 0; index < tasks.length; index += 1) {
    await tasks[index];
  }
}

function collectWaitUntil(tasks: Array<Promise<unknown>>): WaitUntilFn {
  return (task) => {
    tasks.push(typeof task === "function" ? task() : task);
  };
}

function createGitHubRequest(args: {
  eventType: "issue_comment" | "pull_request_review_comment";
  payload: Record<string, unknown>;
  signatureOverride?: string;
}): Request {
  const body = JSON.stringify(args.payload);
  return new Request("https://example.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": args.eventType,
      "x-hub-signature-256":
        args.signatureOverride ??
        signGitHubWebhookBody(body, GITHUB_WEBHOOK_SECRET),
    },
    body,
  });
}

function makeDiagnostics() {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome: "success" as const,
    toolCalls: [],
    toolErrorCount: 0,
    toolResultCount: 0,
    usedPrimaryText: true,
  };
}

describe("GitHub webhook mention handling", () => {
  afterEach(() => {
    delete process.env.GITHUB_BOT_USERNAME;
  });

  async function createGitHubBot() {
    process.env.GITHUB_BOT_USERNAME = "junior";
    const bot = new JuniorChat({
      userName: "junior",
      adapters: {
        github: createGitHubAdapter({
          token: "ghs_test_token",
          webhookSecret: GITHUB_WEBHOOK_SECRET,
          userName: "junior",
        }),
      },
      state: createMemoryState(),
    });
    const runtime = createGitHubRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "GitHub final reply",
            diagnostics: makeDiagnostics(),
          }),
        },
      },
    });
    const handledMessages: Array<
      Pick<Message, "id" | "isMention" | "text" | "threadId">
    > = [];
    bot.onNewMention((thread, message) => {
      handledMessages.push({
        id: message.id,
        isMention: message.isMention,
        text: message.text,
        threadId: message.threadId,
      });
      return runtime.handleNewMention(thread, message);
    });
    return { bot, handledMessages };
  }

  it("rejects invalid webhook signatures", async () => {
    const { bot } = await createGitHubBot();
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const payload = githubIssueCommentWebhook({
      issueNumber: 11,
      isPullRequest: false,
      body: "@junior investigate this",
    }) as Record<string, unknown>;
    const request = createGitHubRequest({
      eventType: "issue_comment",
      payload,
      signatureOverride: "sha256=forged",
    });

    const response = await handlePlatformWebhook(
      request,
      "github",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(response.status).toBe(401);
    const postCalls = getCapturedGitHubApiCalls().filter(
      (entry) =>
        entry.method === "POST" &&
        (entry.url.includes("/issues/") || entry.url.includes("/pulls/")),
    );
    expect(postCalls).toHaveLength(0);
  });

  it("replies to explicit mentions in issue comments", async () => {
    const { bot, handledMessages } = await createGitHubBot();
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const payload = githubIssueCommentWebhook({
      issueNumber: 11,
      isPullRequest: false,
      body: "@junior can you debug this issue?",
    }) as Record<string, unknown>;
    const request = createGitHubRequest({
      eventType: "issue_comment",
      payload,
    });

    const response = await handlePlatformWebhook(
      request,
      "github",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(response.status).toBe(200);
    expect(handledMessages).toHaveLength(1);
    expect(handledMessages[0]).toMatchObject({
      isMention: true,
    });
    const commentPosts = getCapturedGitHubApiCalls().filter(
      (entry) =>
        entry.method === "POST" &&
        entry.url.includes("/repos/acme/junior/issues/11/comments"),
    );
    expect(commentPosts).toHaveLength(1);
    expect(commentPosts[0]?.body).toMatchObject({
      body: "GitHub final reply",
    });
  });

  it("replies to explicit mentions in PR conversation comments", async () => {
    const { bot } = await createGitHubBot();
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const payload = githubIssueCommentWebhook({
      issueNumber: 22,
      isPullRequest: true,
      body: "@junior please review this PR context",
    }) as Record<string, unknown>;
    const request = createGitHubRequest({
      eventType: "issue_comment",
      payload,
    });

    const response = await handlePlatformWebhook(
      request,
      "github",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(response.status).toBe(200);
    const commentPosts = getCapturedGitHubApiCalls().filter(
      (entry) =>
        entry.method === "POST" &&
        entry.url.includes("/repos/acme/junior/issues/22/comments"),
    );
    expect(commentPosts).toHaveLength(1);
    expect(commentPosts[0]?.body).toMatchObject({
      body: "GitHub final reply",
    });
  });

  it("replies to explicit mentions in PR review comment threads", async () => {
    const { bot } = await createGitHubBot();
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const payload = githubReviewCommentWebhook({
      pullRequestNumber: 33,
      reviewCommentId: 9001,
      body: "@junior reply in this review thread",
    }) as Record<string, unknown>;
    const request = createGitHubRequest({
      eventType: "pull_request_review_comment",
      payload,
    });

    const response = await handlePlatformWebhook(
      request,
      "github",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(response.status).toBe(200);
    const reviewReplyPosts = getCapturedGitHubApiCalls().filter(
      (entry) =>
        entry.method === "POST" &&
        entry.url.includes("/repos/acme/junior/pulls/33/comments/9001/replies"),
    );
    expect(reviewReplyPosts).toHaveLength(1);
    expect(reviewReplyPosts[0]?.body).toMatchObject({
      body: "GitHub final reply",
    });
  });

  it("ignores untagged GitHub comments in V1", async () => {
    const { bot, handledMessages } = await createGitHubBot();
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const payload = githubIssueCommentWebhook({
      issueNumber: 44,
      isPullRequest: false,
      body: "can someone help with this issue?",
    }) as Record<string, unknown>;
    const request = createGitHubRequest({
      eventType: "issue_comment",
      payload,
    });

    const response = await handlePlatformWebhook(
      request,
      "github",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(response.status).toBe(200);
    expect(handledMessages).toHaveLength(0);
    const postCalls = getCapturedGitHubApiCalls().filter(
      (entry) =>
        entry.method === "POST" &&
        (entry.url.includes("/issues/") || entry.url.includes("/pulls/")),
    );
    expect(postCalls).toHaveLength(0);
  });
});
