import { z } from "zod";
import type { IngestResourceEventInput } from "@/chat/resource-events/ingest";
import {
  gitHubEventKey,
  gitHubPullRequestResource,
} from "@/handlers/github-webhook/resource";

// GitHub webhook payloads carry many provider fields; normalize only the
// routed PR identity, author, and comment body used by Junior.
const issueCommentWebhookSchema = z
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
    issue: z
      .object({
        number: z.number(),
        pull_request: z
          .object({
            url: z.string().min(1),
          })
          .strip()
          .optional(),
      })
      .strip(),
    repository: z
      .object({
        full_name: z.string().min(1),
      })
      .strip(),
  })
  .strip();

/** Normalize GitHub `issue_comment` webhooks for PR-level comments. */
export function normalizeGitHubIssueCommentEvent(
  deliveryId: string,
  body: unknown,
): IngestResourceEventInput | undefined {
  const parsed = issueCommentWebhookSchema.safeParse(body);
  if (
    !parsed.success ||
    parsed.data.action !== "created" ||
    !parsed.data.issue.pull_request
  ) {
    return undefined;
  }
  const eventType = "comment.created";
  const resource = gitHubPullRequestResource({
    pullRequestNumber: parsed.data.issue.number,
    repositoryFullName: parsed.data.repository.full_name,
  });
  const author = parsed.data.comment.user?.login;
  return {
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: Date.now(),
    provider: "github",
    resourceRef: resource.resourceRef,
    trustedSummary: `${resource.label} received a comment${author ? ` from ${author}` : ""}.`,
    untrustedText: parsed.data.comment.body,
  };
}
