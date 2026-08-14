import type { ResourceEventInput } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  linearIssueResource,
  linearTeamResource,
} from "../resource-events/issue.js";

const issueWebhookSchema = z
  .object({
    action: z.string(),
    createdAt: z.string().optional(),
    data: z
      .object({
        assignee: z
          .object({ name: z.string().optional() })
          .passthrough()
          .optional()
          .nullable(),
        description: z.string().optional().nullable(),
        id: z.string().min(1),
        identifier: z.string().trim().min(1),
        labels: z
          .array(z.object({ name: z.string().min(1) }).passthrough())
          .optional(),
        priorityLabel: z.string().optional(),
        project: z
          .object({ name: z.string().optional() })
          .passthrough()
          .optional()
          .nullable(),
        state: z
          .object({ name: z.string().optional() })
          .passthrough()
          .optional()
          .nullable(),
        team: z
          .object({ key: z.string().trim().min(1) })
          .passthrough()
          .optional(),
        teamKey: z.string().trim().min(1).optional(),
        title: z.string().optional(),
        url: z.url(),
      })
      .passthrough(),
    type: z.string(),
    url: z.url().optional(),
    webhookTimestamp: z.number().finite().optional(),
  })
  .passthrough();

function issueText(
  issue: z.output<typeof issueWebhookSchema>["data"],
): string | undefined {
  const labels = issue.labels?.map((label) => label.name).join(", ");
  const parts = [
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.description ? `Description: ${issue.description}` : undefined,
    issue.state?.name ? `State: ${issue.state.name}` : undefined,
    issue.priorityLabel ? `Priority: ${issue.priorityLabel}` : undefined,
    issue.project?.name ? `Project: ${issue.project.name}` : undefined,
    labels ? `Labels: ${labels}` : undefined,
    issue.assignee?.name ? `Assignee: ${issue.assignee.name}` : undefined,
    `URL: ${issue.url}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function occurredAtMs(input: {
  createdAt?: string;
  webhookTimestamp?: number;
}): number {
  const createdAt = input.createdAt ? Date.parse(input.createdAt) : Number.NaN;
  if (Number.isFinite(createdAt)) return createdAt;
  if (Number.isFinite(input.webhookTimestamp)) return input.webhookTimestamp!;
  return Date.now();
}

/** Normalize one verified Linear webhook into issue- and team-scoped events. */
export function normalizeLinearResourceEvents(input: {
  body: unknown;
  linearEvent: string;
}): ResourceEventInput[] {
  if (input.linearEvent.toLowerCase() !== "issue") return [];
  const parsed = issueWebhookSchema.safeParse(input.body);
  if (
    !parsed.success ||
    parsed.data.action !== "create" ||
    parsed.data.type.toLowerCase() !== "issue"
  ) {
    return [];
  }

  const issue = parsed.data.data;
  const teamKey = issue.team?.key ?? issue.teamKey;
  if (!teamKey) return [];
  const issueResource = linearIssueResource({ identifier: issue.identifier });
  const teamResource = linearTeamResource({ teamKey });
  const eventType = "issue.created";
  const event = {
    eventKey: `linear:${issue.id}:${eventType}`,
    eventType,
    occurredAtMs: occurredAtMs(parsed.data),
    trustedSummary: `${issueResource.label} was created.`,
    data: {
      issueId: issue.id,
      issueIdentifier: issueResource.identifier,
      teamKey: teamResource.identifier,
      url: issue.url,
    },
    untrustedText: issueText(issue),
  } satisfies Omit<ResourceEventInput, "identifier">;

  return [
    { ...event, identifier: issueResource.identifier },
    { ...event, identifier: teamResource.identifier },
  ];
}
