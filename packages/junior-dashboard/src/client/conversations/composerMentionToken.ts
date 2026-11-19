import type { MentionablePerson } from "@sentry/junior/api/schema";
import type { ComposerToken } from "./composerSkillToken";

// A letter, digit, `_` or `@` before the `@` makes it part of an email
// address or a handle, so `me@example.com` and `müller@…` open no menu.
const TOKEN_BEFORE_CARET = /(?<![\p{L}\p{N}_@])@([\p{L}\p{N}._-]*)$/u;
const NAME_AFTER_CARET = /^[\p{L}\p{N}._-]*/u;
// The token that core keeps in message text for a Slack user mention. Only
// the form without a label: the composer writes no label, so text that it
// reads back keeps the same characters.
const MENTION_TOKEN = /<@([A-Z0-9]+)>/g;

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

/** One part of composer text: plain text, or a mention. */
type ComposerTextPart = { text: string } | { slackUserId: string };

/** Split message text into plain text and the mentions in it. */
export function splitMentions(text: string): ComposerTextPart[] {
  const parts: ComposerTextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION_TOKEN)) {
    if (match.index > cursor) {
      parts.push({ text: text.slice(cursor, match.index) });
    }
    parts.push({ slackUserId: match[1]! });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
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
