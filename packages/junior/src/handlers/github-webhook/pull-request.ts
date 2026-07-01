import { z } from "zod";
import type { IngestResourceEventInput } from "@/chat/resource-events/ingest";
import {
  gitHubEventKey,
  gitHubPullRequestResource,
} from "@/handlers/github-webhook/resource";

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    merged: z.boolean().optional(),
    number: z.number(),
  }),
  repository: z.object({
    full_name: z.string().min(1),
  }),
});

/** Normalize GitHub `pull_request` webhooks for subscribed PR state changes. */
export function normalizeGitHubPullRequestEvent(
  deliveryId: string,
  body: unknown,
): IngestResourceEventInput | undefined {
  const parsed = pullRequestWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "closed") {
    return undefined;
  }
  const eventType = parsed.data.pull_request.merged
    ? "state.merged"
    : "state.closed_unmerged";
  const resource = gitHubPullRequestResource({
    pullRequestNumber: parsed.data.pull_request.number,
    repositoryFullName: parsed.data.repository.full_name,
  });
  return {
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: Date.now(),
    provider: "github",
    resourceRef: resource.resourceRef,
    terminal: true,
    trustedSummary:
      eventType === "state.merged"
        ? `${resource.label} was merged.`
        : `${resource.label} was closed without being merged.`,
  };
}
