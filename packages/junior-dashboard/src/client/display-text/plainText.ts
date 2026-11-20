import type { ActorIdentity } from "@sentry/junior/api/schema";

import { plainTextTokens } from "./mentions";
import { SLACK_LINK_RE } from "./links";

/**
 * Return display text as one plain string for places that cannot hold
 * markup, such as a `title` attribute. It shows the same names and emoji as
 * `DisplayText`, without the Markdown syntax.
 */
export function displayPlainText(
  text: string,
  mentions: readonly ActorIdentity[] = [],
): string {
  return plainTextTokens(stripMarkdown(text), mentions);
}

function stripMarkdown(text: string): string {
  return text
    .replace(SLACK_LINK_RE, (_, url: string, label?: string) =>
      label?.trim() ? label.trim() : url,
    )
    .replace(/\[([^\]]+)\]\([^\s)]+(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/(^|\s)([*_~`]{1,3})(?=\S)/g, "$1")
    .replace(/([*_~`]{1,3})(?=\s|$|[.,!?;:])/g, "")
    .replace(/^\s*(?:#{1,6}|[-+*]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
