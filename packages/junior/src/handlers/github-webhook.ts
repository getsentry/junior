import { createHmac, timingSafeEqual } from "node:crypto";
import type { StateAdapter } from "chat";
import {
  ingestResourceEvent,
  type IngestResourceEventInput,
} from "@/chat/resource-events/ingest";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { normalizeGitHubCheckSuiteEvents } from "@/handlers/github-webhook/check-suite";
import { normalizeGitHubIssueCommentEvent } from "@/handlers/github-webhook/issue-comment";
import { normalizeGitHubPullRequestEvent } from "@/handlers/github-webhook/pull-request";
import { normalizeGitHubPullRequestReviewCommentEvent } from "@/handlers/github-webhook/pull-request-review-comment";
import { normalizeGitHubPullRequestReviewEvent } from "@/handlers/github-webhook/pull-request-review";

export interface GitHubWebhookHandlerOptions {
  queue: ConversationWorkQueue | (() => ConversationWorkQueue);
  state?: StateAdapter | (() => StateAdapter | undefined);
}

function resolveState(
  state: GitHubWebhookHandlerOptions["state"],
): StateAdapter | undefined {
  return typeof state === "function" ? state() : state;
}

function githubWebhookSecret(): string | undefined {
  return process.env.GITHUB_WEBHOOK_SECRET?.trim();
}

function verifyGitHubSignature(body: string, signature: string): boolean {
  const secret = githubWebhookSecret();
  if (!secret || !signature.startsWith("sha256=")) {
    return false;
  }
  const actual = Buffer.from(signature);
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Normalize a verified GitHub webhook delivery into resource events. */
export function normalizeGitHubResourceEvents(args: {
  body: unknown;
  deliveryId: string;
  eventName: string;
}): IngestResourceEventInput[] {
  switch (args.eventName) {
    case "pull_request": {
      const event = normalizeGitHubPullRequestEvent(args.deliveryId, args.body);
      return event ? [event] : [];
    }
    case "pull_request_review": {
      const event = normalizeGitHubPullRequestReviewEvent(
        args.deliveryId,
        args.body,
      );
      return event ? [event] : [];
    }
    case "issue_comment": {
      const event = normalizeGitHubIssueCommentEvent(
        args.deliveryId,
        args.body,
      );
      return event ? [event] : [];
    }
    case "pull_request_review_comment": {
      const event = normalizeGitHubPullRequestReviewCommentEvent(
        args.deliveryId,
        args.body,
      );
      return event ? [event] : [];
    }
    case "check_suite":
      return normalizeGitHubCheckSuiteEvents(args.deliveryId, args.body);
    default:
      return [];
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Handle signed GitHub webhooks for resource event subscriptions. */
export async function POST(
  request: Request,
  options: GitHubWebhookHandlerOptions,
): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!verifyGitHubSignature(body, signature)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const deliveryId = request.headers.get("x-github-delivery");
  const eventName = request.headers.get("x-github-event");
  if (!deliveryId || !eventName) {
    return new Response("Malformed GitHub webhook", { status: 400 });
  }

  const events = normalizeGitHubResourceEvents({
    body: parseJson(body),
    deliveryId,
    eventName,
  });
  if (events.length === 0) {
    return new Response("Ignored", { status: 202 });
  }

  const queue =
    typeof options.queue === "function" ? options.queue() : options.queue;
  const state = resolveState(options.state);
  for (const event of events) {
    await ingestResourceEvent(
      { ...event, occurredAtMs: Date.now() },
      { queue, state },
    );
  }
  return new Response("Accepted", { status: 202 });
}
