import type { Message } from "chat";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";
import { appendSlackLegacyAttachmentText } from "@/chat/slack/legacy-attachments";
import { stripLeadingSteeringOverride } from "@/chat/slack/message-control";

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

/**
 * Return plain message text with every structured link target available.
 *
 * Slack may shorten a link's visible label, while the Chat SDK preserves its
 * target in `message.links`. Keep the existing plain-text contract and append
 * only targets that are not already visible.
 */
export function getSlackMessageText(
  message: Pick<Message, "links" | "text">,
): string {
  const text = message.text.trim();
  const visibleLinks = new Set<string>();
  for (const link of message.links) {
    if (!text.includes(link.url)) {
      visibleLinks.add(link.url);
    }
  }
  if (visibleLinks.size === 0) {
    return text;
  }

  const links = [...visibleLinks].join("\n");
  return text ? `${text}\n\nLinks:\n${links}` : links;
}

interface SlackMessageInputOptions {
  stripLeadingBotMention: (
    text: string,
    options: { stripLeadingSlackMentionToken?: boolean },
  ) => string;
  stripLeadingSlackMentionToken: boolean;
}

/** Build the source and user text for one inbound Slack message. */
export function getSlackMessageInput(
  message: Pick<Message, "links" | "raw" | "text">,
  options: SlackMessageInputOptions,
): { sourceText: string; userText: string } {
  const sourceText = getSlackMessageText(message);
  const userText = options.stripLeadingBotMention(
    stripLeadingSteeringOverride(sourceText),
    {
      stripLeadingSlackMentionToken: options.stripLeadingSlackMentionToken,
    },
  );
  return {
    sourceText: appendSlackLegacyAttachmentText(sourceText, message.raw),
    userText: appendSlackLegacyAttachmentText(userText, message.raw),
  };
}
