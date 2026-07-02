import { z } from "zod";
import type { IngestResourceEventInput } from "@/chat/resource-events/ingest";
import {
  gitHubEventKey,
  gitHubPullRequestResource,
} from "@/handlers/github-webhook/resource";

// GitHub webhook payloads carry many provider fields; normalize only the
// routed PR identity, author, and inline comment body used by Junior.
const pullRequestReviewCommentWebhookSchema = z
  .object({
    action: z.string(),
    comment: z
      .object({
        body: z.string(),
        user: z
          .object({
            login: z.string().optional(),
          })
          .strip()
          .optional(),
      })
      .strip(),
    pull_request: z
      .object({
        number: z.number(),
      })
      .strip(),
    repository: z
      .object({
        full_name: z.string().min(1),
      })
      .strip(),
  })
  .strip();

/** Normalize GitHub `pull_request_review_comment` webhooks for inline PR comments. */
export function normalizeGitHubPullRequestReviewCommentEvent(
  deliveryId: string,
  body: unknown,
): IngestResourceEventInput | undefined {
  const parsed = pullRequestReviewCommentWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "created") {
    return undefined;
  }
  const eventType = "review_comment.created";
  const resource = gitHubPullRequestResource({
    pullRequestNumber: parsed.data.pull_request.number,
    repositoryFullName: parsed.data.repository.full_name,
  });
  const author = parsed.data.comment.user?.login;
  return {
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: Date.now(),
    provider: "github",
    resourceRef: resource.resourceRef,
    trustedSummary: `${resource.label} received an inline review comment${author ? ` from ${author}` : ""}.`,
    untrustedText: parsed.data.comment.body,
  };
}
