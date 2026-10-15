import type { ActionsBlock, Button, KnownBlock } from "@slack/types";
import {
  escapeSlackMrkdwnText,
  normalizeSlackReplyMarkdown,
  slackMention,
} from "@/chat/slack/mrkdwn";

// Slack block limits: https://docs.slack.dev/reference/block-kit/blocks/actions-block
// and https://docs.slack.dev/reference/block-kit/block-elements/button-element
export const SLACK_BUTTON_LIMITS = {
  maxButtons: 5,
  maxLabelChars: 75,
  maxTextChars: 12_000,
  maxValueChars: 2_000,
} as const;

/** Block id of the actions block that holds Junior's buttons. */
export const SLACK_BUTTONS_BLOCK_ID = "junior_buttons";
const SLACK_BUTTON_ACTION_ID_PREFIX = "junior_button:";

export interface SlackButton {
  label: string;
  style?: "danger" | "primary";
  value: string;
}

/** Build a Slack message with model-authored text and one row of buttons. */
export function buildSlackButtonMessage(args: {
  buttons: readonly SlackButton[];
  text: string;
}): { blocks: KnownBlock[]; text: string } {
  const text = normalizeSlackReplyMarkdown(args.text);
  const elements: Button[] = args.buttons.map((button, index) => ({
    type: "button",
    // Slack requires a unique action_id for each element in one message.
    action_id: `${SLACK_BUTTON_ACTION_ID_PREFIX}${index}`,
    text: { type: "plain_text", text: button.label, emoji: true },
    value: button.value,
    ...(button.style ? { style: button.style } : undefined),
  }));
  const actions: ActionsBlock = {
    type: "actions",
    block_id: SLACK_BUTTONS_BLOCK_ID,
    elements,
  };
  return { blocks: [{ type: "markdown", text }, actions], text };
}

/** Return true when a Slack action id came from a Junior button. */
export function isSlackButtonActionId(actionId: string | undefined): boolean {
  return actionId?.startsWith(SLACK_BUTTON_ACTION_ID_PREFIX) === true;
}

/**
 * Replace the buttons with a note that names the person and their choice.
 * This keeps the question visible and stops more clicks on the same message.
 */
export function buildAnsweredSlackButtonBlocks(args: {
  blocks: readonly KnownBlock[];
  label: string;
  userId: string;
}): KnownBlock[] {
  return [
    ...args.blocks.filter(
      (block) =>
        !("block_id" in block) || block.block_id !== SLACK_BUTTONS_BLOCK_ID,
    ),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${slackMention(args.userId)} chose *${escapeSlackMrkdwnText(args.label)}*`,
        },
      ],
    },
  ];
}

/** Build the agent input text for one button click. */
export function formatSlackButtonClickText(args: {
  label: string;
  messageText?: string;
  value: string;
}): string {
  const lines = [
    "Clicked a button on a Slack message from Junior.",
    `Button label: ${args.label}`,
    `Button value: ${args.value}`,
  ];
  if (args.messageText?.trim()) {
    lines.push(`Button message: ${args.messageText.trim()}`);
  }
  return lines.join("\n");
}
