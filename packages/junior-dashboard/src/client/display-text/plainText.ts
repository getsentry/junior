import type { ActorIdentity } from "@sentry/junior/api/schema";
import {
  markdownNodes,
  markdownPlainText,
  parseMarkdown,
} from "@sentry/junior-plugin-api";

import { plainTextTokens } from "./mentions";
import { SLACK_LINK_RE, slackLinksToMarkdown } from "./links";

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
  return markdownPlainText(
    text.replace(SLACK_LINK_RE, (_, url: string, label?: string) =>
      label?.trim() ? label.trim() : url,
    ),
  );
}

/**
 * Return the web links that `DisplayText` shows for display text, once
 * each, in text order: Slack links, Markdown links, and bare links.
 */
export function displayTextWebLinks(text: string): string[] {
  const tree = parseMarkdown(slackLinksToMarkdown(text));
  const links = markdownNodes(tree, ["link"]).flatMap(({ url }) => {
    const protocol = URL.canParse(url) ? new URL(url).protocol : undefined;
    return protocol === "http:" || protocol === "https:" ? [url] : [];
  });
  return [...new Set(links)];
}
