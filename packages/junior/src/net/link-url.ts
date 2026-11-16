/**
 * Return the normalized href of an HTTP or HTTPS link, or undefined. Agents,
 * plugins and messages supply these links, and URL parsing also accepts
 * `javascript:` and `data:` URLs.
 */
export function safeLinkUrl(
  url: string | null | undefined,
): string | undefined {
  if (!url || !URL.canParse(url)) return undefined;
  const href = new URL(url);
  return href.protocol === "https:" || href.protocol === "http:"
    ? href.href
    : undefined;
}
