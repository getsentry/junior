import { z } from "zod";
import type { IngestResourceEventInput } from "@/chat/resource-events/ingest";
import {
  gitHubEventKey,
  gitHubPullRequestResource,
} from "@/handlers/github-webhook/resource";

const checkSuiteWebhookSchema = z.object({
  action: z.string(),
  check_suite: z.object({
    conclusion: z.string().optional().nullable(),
    head_sha: z.string().optional(),
    pull_requests: z.array(
      z.object({
        number: z.number(),
      }),
    ),
  }),
  repository: z.object({
    full_name: z.string().min(1),
  }),
});

/** Normalize GitHub `check_suite` webhooks for subscribed PR check outcomes. */
export function normalizeGitHubCheckSuiteEvents(
  deliveryId: string,
  body: unknown,
): IngestResourceEventInput[] {
  const parsed = checkSuiteWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") {
    return [];
  }
  const conclusion = parsed.data.check_suite.conclusion;
  const eventType =
    conclusion === "failure" || conclusion === "timed_out"
      ? "checks.failed"
      : conclusion === "success"
        ? "checks.recovered"
        : undefined;
  if (!eventType) {
    return [];
  }
  const sha = parsed.data.check_suite.head_sha?.slice(0, 12);
  return parsed.data.check_suite.pull_requests.map((pullRequest) => {
    const resource = gitHubPullRequestResource({
      pullRequestNumber: pullRequest.number,
      repositoryFullName: parsed.data.repository.full_name,
    });
    return {
      eventKey: gitHubEventKey(
        deliveryId,
        `${eventType}:${pullRequest.number}`,
      ),
      eventType,
      occurredAtMs: Date.now(),
      provider: "github",
      resourceRef: resource.resourceRef,
      trustedSummary:
        eventType === "checks.failed"
          ? `${resource.label} checks failed${sha ? ` for ${sha}` : ""}.`
          : `${resource.label} checks recovered${sha ? ` for ${sha}` : ""}.`,
    };
  });
}
