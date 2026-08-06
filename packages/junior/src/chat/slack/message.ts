import { stringifyMarkdown, type Message } from "chat";
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
 * Return the Chat SDK's canonical formatted representation by default.
 * Fall back to plain text only when the message has no formatted content.
 */
export function getSlackMessageText(
  message: Pick<Message, "formatted" | "text">,
): string {
  if (message.formatted.children.length > 0) {
    return stringifyMarkdown(message.formatted).trim();
  }
  return message.text.trim();
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
  message: Pick<Message, "formatted" | "raw" | "text">,
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
