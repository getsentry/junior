import { markdownPlainText } from "@sentry/junior-plugin-api";

const PREVIEW_MAX_CHARS = 180;

/** Turn Markdown text into one short plain line for a notification. */
export function notificationPreview(text: string): string {
  // A notification has no room for code blocks, images, or HTML.
  const plain = markdownPlainText(text, { proseOnly: true });
  return plain.length > PREVIEW_MAX_CHARS
    ? `${plain.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`
    : plain;
}
