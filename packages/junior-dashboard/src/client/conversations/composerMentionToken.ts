import type { MentionablePerson } from "@sentry/junior/api/schema";
import type { ComposerToken } from "./skillReferences";

// A letter, digit, `_` or `@` before the `@` makes it part of an email
// address or a handle, so `me@example.com` and `müller@…` open no menu.
const TOKEN_BEFORE_CARET = /(?<![\p{L}\p{N}_@])@([\p{L}\p{N}._-]*)$/u;
const NAME_AFTER_CARET = /^[\p{L}\p{N}._-]*/u;

/** Find the `@name` reference that a caret at `caret` is in, if any. */
export function mentionTokenAt(
  text: string,
  caret: number,
): ComposerToken | undefined {
  const match = TOKEN_BEFORE_CARET.exec(text.slice(0, caret));
  if (!match) return undefined;
  const rest = NAME_AFTER_CARET.exec(text.slice(caret))?.[0] ?? "";
  return { start: match.index, end: caret + rest.length, query: match[1]! };
}

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
