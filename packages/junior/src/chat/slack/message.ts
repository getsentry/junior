import { stringifyMarkdown, type Message } from "chat";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

/** Expand Slack mrkdwn labeled links so truncated display labels keep their targets. */
const SLACK_LABELED_LINK_RE = /<(https?:\/\/[^|<>]+)\|([^<>]+)>/g;
const SLACK_BARE_LINK_RE = /<(https?:\/\/[^<>]+)>/g;

/**
 * Preserve the native Slack message timestamp when a synthetic message ID is
 * used for routing or deduplication.
 */
export function getSlackMessageTs(
  message: Pick<Message, "id" | "raw">,
): SlackMessageTs | undefined {
  const idTs = parseSlackMessageTs(message.id);
  if (idTs) {
    return idTs;
  }

  if (message.raw && typeof message.raw === "object") {
    return parseSlackMessageTs((message.raw as Record<string, unknown>).ts);
  }

  return undefined;
}

function readRawEventText(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const text = (raw as Record<string, unknown>).text;
  return typeof text === "string" ? text : undefined;
}

function hasFormattedContent(
  formatted: Message["formatted"] | undefined,
): formatted is Message["formatted"] {
  return Boolean(
    formatted &&
      typeof formatted === "object" &&
      Array.isArray(formatted.children) &&
      formatted.children.length > 0,
  );
}

/** Expand Slack mrkdwn link tokens into markdown that keeps the full URL target. */
export function expandSlackMrkdwnLinks(text: string): string {
  return text
    .replace(SLACK_LABELED_LINK_RE, "[$2]($1)")
    .replace(SLACK_BARE_LINK_RE, "$1");
}

/**
 * Prefer the original Slack event text for routing/mention detection.
 *
 * Adapter plain-text extraction drops labeled-link targets and mention entity
 * tokens, so fall back to `message.raw.text` when present.
 */
export function getSlackMessageSourceText(
  message: Pick<Message, "text" | "raw">,
): string {
  return readRawEventText(message.raw) ?? message.text ?? "";
}

/**
 * Build agent/conversation-facing text that keeps full URLs from Slack links.
 *
 * The chat Slack adapter stores full link targets in `message.formatted` and
 * the raw event text, but `message.text` is plain text that keeps only the
 * often-truncated display label.
 */
export function getSlackMessageAgentText(
  message: Pick<Message, "text" | "raw" | "formatted">,
): string {
  if (hasFormattedContent(message.formatted)) {
    return stringifyMarkdown(message.formatted).trimEnd();
  }

  const sourceText = getSlackMessageSourceText(message);
  return expandSlackMrkdwnLinks(sourceText);
}
