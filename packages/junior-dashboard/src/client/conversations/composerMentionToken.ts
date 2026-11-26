import type { MentionablePerson } from "@sentry/junior/api/schema";
import { composerTokenFinder } from "./composerTypeaheadToken";

/**
 * Find the `@name` reference that a caret is in, if any. A letter, digit,
 * `_` or `@` before the `@` makes it part of an email address or a handle,
 * so `me@example.com` and `müller@…` open no menu.
 */
export const mentionTokenAt = composerTokenFinder(
  String.raw`(?<![\p{L}\p{N}_@])@`,
  String.raw`[\p{L}\p{N}._-]`,
  "u",
);

/** The message text for a mention, which the runtime reads as a Slack mention. */
export function mentionText(slackUserId: string): string {
  return `<@${slackUserId}>`;
}

/**
 * The name that a mention of this person shows: the display name, never an
 * email address or a Slack handle.
 */
export function mentionName(
  person: Partial<MentionablePerson> & { slackUserId: string },
): string {
  return person.fullName ?? person.slackUserId;
}
