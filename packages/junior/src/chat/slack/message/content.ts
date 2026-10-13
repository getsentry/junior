/**
 * Slack message content projection.
 *
 * This module is the typed entry point for agent-visible Slack text. Raw block
 * and attachment details stay behind this boundary.
 */
import { stringifyMarkdown, type Message } from "chat";
import { renderAttachmentText } from "@/chat/slack/message/attachments";
import { renderBlockText } from "@/chat/slack/message/blocks";

/** Agent-visible content projected from a Slack message. */
export interface MessageContent {
  attachmentText: string;
  hasAttachments: boolean;
  text: string;
  topLevelText: string;
}

function combineText(text: string, attachmentText: string): string {
  const topLevelText = text.trim();
  if (!attachmentText) return topLevelText;
  if (!topLevelText) return attachmentText;
  return `${topLevelText}\n${attachmentText}`;
}

/** Replace top-level text while preserving the parsed attachment projection. */
export function replaceTopLevelText(
  content: Pick<MessageContent, "attachmentText">,
  text: string,
): string {
  return combineText(text, content.attachmentText);
}

function readRawBlocks(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return undefined;
  return (raw as Record<string, unknown>).blocks;
}

function readRawText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const text = (raw as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

const SLACK_ENTITY_TOKEN_RE = /<([@#])([A-Z0-9]+)(?:\|([^<>]*))?>/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Put back the Slack user and channel mentions that the SDK flattened.
 *
 * The SDK renders `<@U123>` as `@U123` and `<#C123|name>` as `#name`. A bare
 * ID does not say what kind of entity it is, and a reply that copies it is not
 * a mention. The agent sees the same `<@U123>` form that Slack tools return.
 * Markdown output escapes `_`, so a label can also appear as `#name\_x`.
 */
function restoreSlackEntityTokens(text: string, rawText: string): string {
  let restored = text;
  for (const [token, sigil, id, label] of rawText.matchAll(
    SLACK_ENTITY_TOKEN_RE,
  )) {
    const name = label || id;
    const flattened = [name, name.replaceAll("_", "\\_")]
      .map((value) => escapeRegExp(`${sigil}${value}`))
      .join("|");
    const pattern = new RegExp(`(?<![<\\w])(?:${flattened})(?![\\w|>])`);
    restored = restored.replace(pattern, label ? token : `<${sigil}${id}>`);
  }
  return restored;
}

function renderTopLevelText(
  message: Pick<Message, "formatted" | "raw" | "text">,
): string {
  const blocks = readRawBlocks(message.raw);
  const blockText = renderBlockText(blocks);
  // Section blocks contain the body; text can be only a notification summary.
  if (
    Array.isArray(blocks) &&
    blocks.some((block) => block?.type === "section") &&
    blockText
  ) {
    return blockText;
  }

  const rawText = readRawText(message.raw);
  if (message.formatted.children.length > 0) {
    return restoreSlackEntityTokens(
      stringifyMarkdown(message.formatted).trim(),
      rawText,
    );
  }

  return restoreSlackEntityTokens(message.text.trim(), rawText) || blockText;
}

/** Parse the agent-visible content and attachment state of a Slack message. */
export function parseContent(
  message: Pick<Message, "attachments" | "formatted" | "raw" | "text">,
): MessageContent {
  const topLevelText = renderTopLevelText(message);
  const attachmentText = renderAttachmentText(message.raw);

  return {
    attachmentText,
    hasAttachments: message.attachments.length > 0 || attachmentText.length > 0,
    text: combineText(topLevelText, attachmentText),
    topLevelText,
  };
}
