export const ANCHOR_CLASS =
  "font-medium text-dashboard-accent-text underline decoration-dashboard-accent/35 underline-offset-2 transition-colors hover:text-dashboard-text hover:decoration-dashboard-text-solid";

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
