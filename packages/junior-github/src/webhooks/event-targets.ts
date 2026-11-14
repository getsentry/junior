/**
 * Event data, event key, and target helpers shared by the GitHub webhook
 * normalizers.
 */
import type { EventInput } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { gitHubRepositoryResource } from "../events/repository.js";

/**
 * The user who sent a webhook. GitHub authenticates this user, so on a comment
 * or review it is the author, and on an issue update it made the change.
 * Match on the numeric id; logins can be renamed and reused.
 */
export const gitHubSenderSchema = z.object({
  id: z.number(),
  login: z.string().min(1),
});

/** Trusted event data that names who sent a webhook. */
export function gitHubSenderData(
  sender: z.output<typeof gitHubSenderSchema> | undefined,
): { senderId?: number | undefined; senderLogin?: string | undefined } {
  return { senderId: sender?.id, senderLogin: sender?.login };
}

/** The GitHub user who did what an Event describes, when GitHub names one. */
export function gitHubDoneBy(
  login: string | undefined,
): Pick<EventInput, "doneBy"> | undefined {
  const handle = login?.trim();
  return handle ? { doneBy: { provider: "github", handle } } : undefined;
}

/** The text of a webhook value, or undefined when it is missing or blank. */
export function nonBlank(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** The title and body of an issue or pull request, as untrusted text. */
export function titleAndBodyText(item: {
  body?: string | null | undefined;
  title?: string | undefined;
}): string | undefined {
  const parts = [
    item.title ? `Title: ${item.title}` : undefined,
    nonBlank(item.body),
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Convert an optional provider timestamp for receipt-time fallback ordering. */
export function providerTime(
  value: string | null | undefined,
): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Drop missing values from event data. A filter on a value that GitHub did not
 * send then does not match.
 */
export function definedValues(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

/** Build the event key for one event type from one webhook delivery. */
export function gitHubEventKey(deliveryId: string, eventType: string): string {
  return `github:${deliveryId}:${eventType}`;
}

/**
 * Address a pull request event through both the pull request and its
 * repository. Only the pull request copy keeps `terminal`, so a terminal
 * event never completes a repository Watch.
 */
export function pullRequestTargets(
  event: EventInput,
  repo: string,
): EventInput[] {
  const { terminal: _terminal, ...repositoryEvent } = event;
  return [
    event,
    {
      ...repositoryEvent,
      identifier: gitHubRepositoryResource({ repo }).identifier,
    },
  ];
}
