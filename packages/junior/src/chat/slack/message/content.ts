/**
 * Slack message content projection.
 *
 * This module is the typed entry point for agent-visible Slack text. Raw block
 * and attachment details stay behind this boundary.
 */
import { SlackFormatConverter } from "@chat-adapter/slack";
import { stringifyMarkdown, type Message } from "chat";
import { isRecord } from "@/chat/coerce";
import { renderAttachmentText } from "@/chat/slack/message/attachments";
import { renderBlockText } from "@/chat/slack/message/blocks";
import { SLACK_USER_MENTION_RE } from "@/chat/slack/mrkdwn";

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
  return (raw as Record<string, unknown>)["blocks"];
}

function readRawText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const text = (raw as Record<string, unknown>)["text"];
  return typeof text === "string" ? text : "";
}

const slackFormat = new SlackFormatConverter();
const SLACK_ENTITY_RE = /<[@#][A-Z0-9]+(?:\|[^<>]*)?>/g;
const ENTITY_PLACEHOLDER_RE = /\uE000(\d+)\uE001/g;
// The SDK parser keeps broadcast mentions such as `<!here>` as raw tokens.
const SLACK_BROADCAST_RE = /<!(here|channel|everyone)(?:\|[^<>]*)?>/g;

/**
 * Convert Slack mrkdwn to Markdown and keep user and channel mentions as
 * `<@U123>` and `<#C123|name>`.
 *
 * The SDK conversion turns `<@U123>` into a bare `@U123`. That is not a
 * mention when the agent copies it, and it does not say what the ID is.
 * Private-use placeholders keep each token out of the conversion.
 */
function renderSlackMrkdwn(mrkdwn: string): string {
  const entities: string[] = [];
  const markdown = stringifyMarkdown(
    slackFormat.toAst(
      mrkdwn.replace(
        SLACK_ENTITY_RE,
        (entity) => `\uE000${entities.push(entity) - 1}\uE001`,
      ),
    ),
  );
  return markdown
    .replace(ENTITY_PLACEHOLDER_RE, (_, index) => entities[Number(index)]!)
    .trim();
}

/**
 * Convert Slack mrkdwn to plain text for people. A user mention shows as
 * `@name` when `userNames` has the user.
 */
export function renderSlackPlainText(
  mrkdwn: string,
  userNames: ReadonlyMap<string, string>,
): string {
  // The SDK shows a labeled mention as `@label`.
  const labeled = mrkdwn
    .replace(SLACK_USER_MENTION_RE, (mention: string, id: string) => {
      const name = userNames.get(id);
      return name ? `<@${id}|${name.replace(/[<>|]/g, "")}>` : mention;
    })
    .replace(SLACK_BROADCAST_RE, "@$1");
  return slackFormat.extractPlainText(labeled).trim();
}

function renderTopLevelText(
  message: Pick<Message, "formatted" | "raw" | "text">,
): string {
  const blocks = readRawBlocks(message.raw);
  const blockText = renderBlockText(blocks);
  // Section blocks contain the body; text can be only a notification summary.
  if (
    Array.isArray(blocks) &&
    blocks.some(
      (block: unknown) => isRecord(block) && block["type"] === "section",
    ) &&
    blockText
  ) {
    return blockText;
  }

  const rawText = readRawText(message.raw);
  if (rawText.trim()) {
    return renderSlackMrkdwn(rawText);
  }

  if (message.formatted.children.length > 0) {
    return stringifyMarkdown(message.formatted).trim();
  }

  return message.text.trim() || blockText;
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
