import type { EventInput } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  GITHUB_ISSUE_UPDATE_CHANGES,
  gitHubIssueResource,
} from "../events/issue.js";
import { gitHubRepositoryResource } from "../events/repository.js";
import { gitHubRepoDataSchema } from "../events/scope.js";
import {
  definedValues,
  gitHubDoneBy,
  gitHubEventKey,
  gitHubSenderData,
  gitHubSenderSchema,
  nonBlank,
  providerTime,
  titleAndBodyText,
} from "./event-targets.js";
import { isBotLogin } from "./ownership.js";

// Other `issues` actions, such as `opened`, fail this schema and fall through
// to the issue lifecycle normalizer.
const issueUpdateWebhookSchema = z.object({
  action: z.enum(GITHUB_ISSUE_UPDATE_CHANGES),
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
  sender: gitHubSenderSchema.optional(),
});
type IssueUpdateWebhook = z.output<typeof issueUpdateWebhookSchema>;

/**
 * Describe what an `issues` update action changed. `change` is trusted text:
 * GitHub logins and field names only. Label and milestone names are
 * repository-controlled text, so they stay out of `change` and go in
 * `untrustedText`. Event data also carries the lowercase label name as a
 * match value; only people with repository write access create labels.
 */
function describeIssueUpdate(delivery: IssueUpdateWebhook): {
  change: string;
  untrustedText?: string | undefined;
} {
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
  const { action, label, sender } = parsed.data;
  const doneBy = sender?.login;
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
    // `change` and `label` let an automation select one label change in code,
    // so the model does not decide from untrusted text.
    data: definedValues({
      repo: gitHubRepoDataSchema.parse(input.repo),
      issue: input.number,
      change: action,
      label: label?.name.toLowerCase(),
      ...gitHubSenderData(sender),
    }),
    ...(untrustedText ? { untrustedText } : undefined),
  }));
}
