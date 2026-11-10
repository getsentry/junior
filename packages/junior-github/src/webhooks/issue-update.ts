import type { EventInput } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { gitHubIssueResource } from "../events/issue.js";
import { gitHubRepositoryResource } from "../events/repository.js";
import { gitHubRepoDataSchema } from "../events/scope.js";
import {
  gitHubDoneBy,
  gitHubEventKey,
  nonBlank,
  providerTime,
  titleAndBodyText,
} from "./event-targets.js";
import { isBotLogin } from "./ownership.js";

const issueUpdateWebhookSchema = z.object({
  action: z.string(),
  assignee: z.object({ login: z.string().nullish() }).nullish(),
  changes: z.record(z.string(), z.unknown()).optional(),
  issue: z.object({
    body: z.string().optional().nullable(),
    number: z.number(),
    title: z.string().optional(),
    updated_at: z.string().optional(),
  }),
  label: z.object({ name: z.string() }).nullish(),
  milestone: z.object({ title: z.string() }).nullish(),
  repository: z.object({ full_name: z.string().min(1) }),
  sender: z.object({ login: z.string().min(1) }).optional(),
});
type IssueUpdateWebhook = z.output<typeof issueUpdateWebhookSchema>;

/**
 * Describe what an `issues` update action changed. `change` is trusted text:
 * GitHub logins and field names only. Label and milestone names are
 * repository-controlled text, so they go in `untrustedText`.
 */
function describeIssueUpdate(
  delivery: IssueUpdateWebhook,
): { change: string; untrustedText?: string } | undefined {
  const assignee = nonBlank(delivery.assignee?.login);
  switch (delivery.action) {
    case "edited": {
      const fields = ["title", "body"].filter(
        (field) => field in (delivery.changes ?? {}),
      );
      return {
        change: fields.length ? `edited (${fields.join(", ")})` : "edited",
      };
    }
    case "labeled":
    case "unlabeled":
      return {
        change: delivery.action,
        untrustedText: delivery.label
          ? `Label: ${delivery.label.name}`
          : undefined,
      };
    case "assigned":
      return { change: assignee ? `assigned to ${assignee}` : "assigned" };
    case "unassigned":
      return {
        change: assignee ? `unassigned from ${assignee}` : "unassigned",
      };
    case "milestoned":
    case "demilestoned":
      return {
        change: delivery.action,
        untrustedText: delivery.milestone
          ? `Milestone: ${delivery.milestone.title}`
          : undefined,
      };
    default:
      return undefined;
  }
}

/**
 * Normalize an issue edit, label, assignee, or milestone change into
 * `issue.updated` for the issue and its repository. Return undefined when the
 * delivery is not one of these updates. Changes that the bot makes publish
 * nothing, so Junior's own issue updates do not wake its Watches.
 */
export function normalizeIssueUpdateEvents(
  deliveryId: string,
  body: unknown,
  botEmail: string | undefined,
): EventInput[] | undefined {
  const parsed = issueUpdateWebhookSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const update = describeIssueUpdate(parsed.data);
  if (!update) return undefined;
  const doneBy = parsed.data.sender?.login;
  if (isBotLogin(doneBy, botEmail)) return [];

  const input = {
    number: parsed.data.issue.number,
    repo: parsed.data.repository.full_name,
  };
  const issue = gitHubIssueResource(input);
  const untrustedText = [
    update.untrustedText,
    titleAndBodyText(parsed.data.issue),
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  return [issue, gitHubRepositoryResource(input)].map((resource) => ({
    eventKey: gitHubEventKey(deliveryId, "issue.updated"),
    eventType: "issue.updated",
    occurredAtMs: providerTime(parsed.data.issue.updated_at) ?? Date.now(),
    identifier: resource.identifier,
    trustedSummary: `${issue.label} was ${update.change}${doneBy ? ` by ${doneBy}` : ""}.`,
    ...gitHubDoneBy(doneBy),
    data: { repo: gitHubRepoDataSchema.parse(input.repo), issue: input.number },
    ...(untrustedText ? { untrustedText } : undefined),
  }));
}
