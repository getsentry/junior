const PREVIEW_MAX_CHARS = 180;

/** Turn Markdown text into one short plain line for a notification. */
export function notificationPreview(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > PREVIEW_MAX_CHARS
    ? `${plain.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`
    : plain;
}
