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

function renderTopLevelText(
  message: Pick<Message, "formatted" | "raw" | "text">,
): string {
  if (message.formatted.children.length > 0) {
    return stringifyMarkdown(message.formatted).trim();
  }

  const text = message.text.trim();
  return text || renderBlockText(readRawBlocks(message.raw));
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
