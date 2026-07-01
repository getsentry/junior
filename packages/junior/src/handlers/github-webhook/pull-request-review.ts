import { z } from "zod";
import type { IngestResourceEventInput } from "@/chat/resource-events/ingest";
import {
  gitHubEventKey,
  gitHubPullRequestResource,
} from "@/handlers/github-webhook/resource";

const pullRequestReviewWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
  }),
  repository: z.object({
    full_name: z.string().min(1),
  }),
  review: z.object({
    body: z.string().optional().nullable(),
    state: z.string(),
    user: z
      .object({
        login: z.string().optional(),
      })
      .optional(),
  }),
});

/** Normalize GitHub `pull_request_review` webhooks for subscribed review outcomes. */
export function normalizeGitHubPullRequestReviewEvent(
  deliveryId: string,
  body: unknown,
): IngestResourceEventInput | undefined {
  const parsed = pullRequestReviewWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "submitted") {
    return undefined;
  }
  const reviewState = parsed.data.review.state.toUpperCase();
  const eventType =
    reviewState === "APPROVED"
      ? "review.approved"
      : reviewState === "CHANGES_REQUESTED"
        ? "review.changes_requested"
        : undefined;
  if (!eventType) {
    return undefined;
  }
  const resource = gitHubPullRequestResource({
    pullRequestNumber: parsed.data.pull_request.number,
    repositoryFullName: parsed.data.repository.full_name,
  });
  const reviewer = parsed.data.review.user?.login;
  return {
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: Date.now(),
    provider: "github",
    resourceRef: resource.resourceRef,
    trustedSummary:
      eventType === "review.approved"
        ? `${resource.label} was approved${reviewer ? ` by ${reviewer}` : ""}.`
        : `${resource.label} received requested changes${reviewer ? ` from ${reviewer}` : ""}.`,
    untrustedText: parsed.data.review.body ?? undefined,
  };
}
