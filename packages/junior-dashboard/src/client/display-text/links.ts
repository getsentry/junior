import { createContext, useContext } from "react";

import { dashboardInlineLinkClass } from "../styles";

const ANCHOR_CLASS =
  "font-medium text-dashboard-accent-text underline decoration-dashboard-accent/35 underline-offset-2 transition-colors hover:text-dashboard-text hover:decoration-dashboard-text-solid";

// A row preview, such as an Inbox row's summary, sits in muted text under
// its title. Its links keep the text's weight with a quiet underline, so a
// line of links reads as links and does not shout over the title. A person
// is a name to read, not a link to open, so it underlines only on hover.
const PREVIEW_PERSON_CLASS =
  "text-dashboard-text no-underline underline-offset-2 hover:underline";

const PreviewLinks = createContext(false);

/** Draw the links of the display text inside it as a row preview's links. */
export const PreviewLinksProvider = PreviewLinks.Provider;

/** Return the class of a link in display text, or of a link to a person. */
export function useAnchorClass(target: "link" | "person" = "link"): string {
  if (!useContext(PreviewLinks)) return ANCHOR_CLASS;
  return target === "person" ? PREVIEW_PERSON_CLASS : dashboardInlineLinkClass;
}

/**
 * Keep a link destination only when it is an absolute `http:`,
 * `https:`, or `mailto:` URL. Return undefined to drop the link.
 */
export function safeHref(href: string): string | undefined {
  const trimmed = href.trim();
  const hasControlCharacter = Array.from(trimmed).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!trimmed || hasControlCharacter || /\s/.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Slack writes links as `<https://example.com>` or `<https://example.com|label>`. */
export const SLACK_LINK_RE = /<((?:https?|mailto):[^\s|<>]+)(?:\|([^<>]*))?>/g;

/**
 * Rewrite labeled Slack links as Markdown links. Markdown already reads a
 * bare `<https://example.com>` as a link.
 */
export function slackLinksToMarkdown(text: string): string {
  return text.replace(SLACK_LINK_RE, (match, url: string, label?: string) =>
    label?.trim() ? `[${label.trim()}](${url})` : match,
  );
}
