import type { ActionsBlock, Button, KnownBlock } from "@slack/types";
import {
  escapeSlackMrkdwnText,
  normalizeSlackReplyMarkdown,
  slackMention,
} from "@/chat/slack/mrkdwn";
import type { UserInputRequest } from "@/chat/tools/runtime/request-user-input";

/** Block id of the actions block that holds the choices of a request. */
export const SLACK_USER_INPUT_BLOCK_ID = "junior_user_input";
const SLACK_USER_INPUT_ACTION_ID_PREFIX = "junior_user_input:";

/**
 * Render a user input request as one Slack message: the question, the notes
 * of the choices that have one, and one button per choice. The button value
 * is the choice label, which is the answer that a click sends.
 */
export function buildSlackUserInputMessage(request: UserInputRequest): {
  blocks: KnownBlock[];
  text: string;
} {
  const notes = request.options
    .filter((option) => option.description)
    .map((option) => `- **${option.label}**: ${option.description}`);
  const text = normalizeSlackReplyMarkdown(
    [request.question, ...(notes.length ? [notes.join("\n")] : [])].join(
      "\n\n",
    ),
  );
  const elements: Button[] = request.options.map((option, index) => ({
    type: "button",
    // Slack requires a unique action_id for each element in one message.
    action_id: `${SLACK_USER_INPUT_ACTION_ID_PREFIX}${index}`,
    text: { type: "plain_text", text: option.label, emoji: true },
    value: option.label,
  }));
  const actions: ActionsBlock = {
    type: "actions",
    block_id: SLACK_USER_INPUT_BLOCK_ID,
    elements,
  };
  return { blocks: [{ type: "markdown", text }, actions], text };
}

/** Return true when a Slack action id came from a user input request. */
export function isSlackUserInputActionId(
  actionId: string | undefined,
): boolean {
  return actionId?.startsWith(SLACK_USER_INPUT_ACTION_ID_PREFIX) === true;
}

/**
 * Replace the choices with a note that names the person and their answer.
 * Without a clicked answer, the note says that the person replied. This
 * keeps the question visible and stops more clicks on the same message.
 */
export function buildAnsweredSlackUserInputBlocks(args: {
  answer?: string;
  blocks: readonly KnownBlock[];
  userId: string;
}): KnownBlock[] {
  const note = args.answer
    ? `${slackMention(args.userId)} chose *${escapeSlackMrkdwnText(args.answer)}*`
    : `${slackMention(args.userId)} replied in the thread`;
  return [
    ...args.blocks.filter(
      (block) =>
        !("block_id" in block) || block.block_id !== SLACK_USER_INPUT_BLOCK_ID,
    ),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: note,
        },
      ],
    },
  ];
}
