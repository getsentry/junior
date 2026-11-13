/**
 * Event data, event key, and target helpers shared by the GitHub webhook
 * normalizers.
 */
import type { EventAuthor, EventInput } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { gitHubRepositoryResource } from "../events/repository.js";
import { isBotLogin, mentionsBotLogin, ownCommentText } from "./ownership.js";

/**
 * The user who sent a webhook. GitHub authenticates this user, so on a comment
 * or review it is the author, and on an issue update it made the change.
 * Match on the numeric id; logins can be renamed and reused.
 */
export const gitHubSenderSchema = z.object({
  id: z.number(),
  login: z.string().min(1),
  type: z.string().optional(),
});

/** What the plugin needs to describe the author of a webhook. */
export interface GitHubAuthorOptions {
  /** Junior's committer email. It names Junior's own bot login. */
  botEmail?: string;
  /** Logins that the app config lists as trusted, such as review bots. */
  trustedAuthors?: readonly string[];
}

/**
 * Describe who wrote a GitHub Event, from the one place that reads the
 * webhook sender. The same author feeds the Event `author` for core trust,
 * the trusted match data (`senderId`, `senderLogin`, `mentionsBot`), and the
 * check that drops Junior's own writes.
 *
 * `login` is the GitHub user that the Event names: the comment or review
 * author, or the sender of an update. GitHub authenticates the sender, so
 * the sender's numeric id is the `subjectId` only when the sender is that
 * user. The plugin turns its `trustedAuthors` list into `trusted`, so core
 * never reads a login. `text` is the comment body, for comment and review
 * Events only.
 */
export function gitHubEventAuthor(
  input: {
    login: string | null | undefined;
    sender: z.output<typeof gitHubSenderSchema> | undefined;
    text?: string | null;
  },
  options: GitHubAuthorOptions,
): {
  author?: EventAuthor;
  data: { mentionsBot?: boolean; senderId?: number; senderLogin?: string };
  isSelf: boolean;
} {
  const handle = input.login?.trim();
  const { sender } = input;
  const data = {
    ...(input.text !== undefined && options.botEmail
      ? { mentionsBot: mentionsBotLogin(input.text ?? "", options.botEmail) }
      : undefined),
    senderId: sender?.id,
    senderLogin: sender?.login,
  };
  if (!handle) return { data, isSelf: false };
  const lower = handle.toLowerCase();
  const text = ownCommentText(input.text);
  // GitHub logins are case-insensitive, so the sender and the author match without case.
  const isSender = sender?.login?.toLowerCase() === lower;
  return {
    author: {
      handle,
      ...(isSender ? { subjectId: String(sender.id) } : undefined),
      ...((isSender && sender.type === "Bot") || /\[bot\]$/i.test(handle)
        ? { bot: true }
        : undefined),
      ...(options.trustedAuthors?.some(
        (login) => login.trim().toLowerCase() === lower,
      )
        ? { trusted: true }
        : undefined),
      ...(text ? { text } : undefined),
    },
    data,
    isSelf: isBotLogin(handle, options.botEmail),
  };
}

/** The text of a webhook value, or undefined when it is missing or blank. */
export function nonBlank(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** The title and body of an issue or pull request, as untrusted text. */
export function titleAndBodyText(item: {
  body?: string | null;
  title?: string;
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
