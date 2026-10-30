export const TRANSCRIPT_ANCHOR_CLASS =
  "font-medium text-dashboard-accent-text underline decoration-dashboard-accent/35 underline-offset-2 transition-colors hover:text-dashboard-text hover:decoration-dashboard-text-solid";

/**
 * Keep a transcript link destination only when it is an absolute `http:`,
 * `https:`, or `mailto:` URL. Return undefined to drop the link.
 */
export function safeTranscriptHref(href: string): string | undefined {
  const trimmed = href.trim();
  const hasControlCharacter = [...trimmed].some((character) => {
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
