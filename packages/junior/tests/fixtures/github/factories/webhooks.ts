import { createHmac } from "node:crypto";

interface BaseWebhookOptions {
  body?: string;
  commentId?: number;
  installationId?: number;
  owner?: string;
  repo?: string;
  senderId?: number;
  senderLogin?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function signGitHubWebhookBody(body: string, webhookSecret: string): string {
  return `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
}

export function githubIssueCommentWebhook(options: BaseWebhookOptions & {
  issueNumber: number;
  isPullRequest: boolean;
}) {
  const owner = options.owner ?? "acme";
  const repo = options.repo ?? "junior";
  const senderId = options.senderId ?? 42;
  const senderLogin = options.senderLogin ?? "octocat";
  const commentId = options.commentId ?? 1_001;
  const createdAt = nowIso();
  return {
    action: "created",
    installation: {
      id: options.installationId ?? 1,
    },
    issue: {
      number: options.issueNumber,
      ...(options.isPullRequest ? { pull_request: { url: "https://api.github.com/pr/1" } } : {}),
    },
    comment: {
      id: commentId,
      body: options.body ?? "@junior please help",
      created_at: createdAt,
      updated_at: createdAt,
      user: {
        id: senderId,
        login: senderLogin,
        type: "User",
      },
    },
    repository: {
      id: 501,
      name: repo,
      full_name: `${owner}/${repo}`,
      owner: {
        id: 77,
        login: owner,
        type: "Organization",
      },
    },
    sender: {
      id: senderId,
      login: senderLogin,
      type: "User",
    },
  };
}

export function githubReviewCommentWebhook(
  options: BaseWebhookOptions & {
    pullRequestNumber: number;
    reviewCommentId?: number;
    inReplyToId?: number;
  },
) {
  const owner = options.owner ?? "acme";
  const repo = options.repo ?? "junior";
  const senderId = options.senderId ?? 42;
  const senderLogin = options.senderLogin ?? "octocat";
  const commentId = options.reviewCommentId ?? 2_001;
  const createdAt = nowIso();
  return {
    action: "created",
    installation: {
      id: options.installationId ?? 1,
    },
    pull_request: {
      number: options.pullRequestNumber,
    },
    comment: {
      id: commentId,
      in_reply_to_id: options.inReplyToId,
      body: options.body ?? "@junior can you review this line?",
      created_at: createdAt,
      updated_at: createdAt,
      user: {
        id: senderId,
        login: senderLogin,
        type: "User",
      },
    },
    repository: {
      id: 501,
      name: repo,
      full_name: `${owner}/${repo}`,
      owner: {
        id: 77,
        login: owner,
        type: "Organization",
      },
    },
    sender: {
      id: senderId,
      login: senderLogin,
      type: "User",
    },
  };
}
