/** Reduce message Markdown to compact plain text for conversation previews. */
export function formatConversationActivityPreview(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^\s)]+(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/(^|\s)([*_~`]{1,3})(?=\S)/g, "$1")
    .replace(/([*_~`]{1,3})(?=\s|$|[.,!?;:])/g, "")
    .replace(/^\s*(?:#{1,6}|[-+*]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
