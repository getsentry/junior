import type { SlackAdapter } from "@chat-adapter/slack";
import type { Message, StateAdapter } from "chat";
import * as z from "zod";
import { escapeTagText, renderChildTag, renderTag } from "@/chat/input-tags";
import { isSlackWorkspaceMember } from "@/chat/ingress/workspace-membership";
import { parseSlackMetadata } from "@/chat/task-execution/slack-work";
import type { AgentInput, InboundMessage } from "@/chat/task-execution/state";

const EDIT_ID_SEPARATOR = ":edit:";

const slackEditSchema = z.object({
  channel: z.string().min(1),
  channel_type: z.string().optional(),
  message: z.looseObject({
    bot_id: z.string().optional(),
    edited: z.object({ ts: z.string().min(1) }).optional(),
    text: z.string().optional(),
    ts: z.string().min(1),
  }),
  previous_message: z.looseObject({ text: z.string().optional() }),
});

const previousTextSchema = z.object({
  previous_message: z.object({ text: z.string() }),
});

/**
 * Parse a person's edit from a Slack `message_changed` event. Returns the
 * edited Message, and the id and raw event of its correction. An edit by a
 * bot or with the same text returns undefined.
 */
export async function parseSlackMessageEdit(
  adapter: SlackAdapter,
  event: unknown,
  state: StateAdapter,
): Promise<{ id: string; message: Message; raw: unknown } | undefined> {
  const parsed = slackEditSchema.safeParse(event);
  if (!parsed.success) return undefined;
  const { channel, channel_type, message: edited } = parsed.data;
  const previous = parsed.data.previous_message;
  if (
    edited.bot_id ||
    !edited.edited ||
    (edited.text ?? "") === (previous.text ?? "") ||
    !(await isSlackWorkspaceMember(edited, state))
  ) {
    return undefined;
  }
  return {
    // Distinct from the original, so a redelivered edit dedupes.
    id: `${edited.ts}${EDIT_ID_SEPARATOR}${edited.edited.ts}`,
    message: adapter.parseMessage({
      ...edited,
      type: "message",
      channel,
      channel_type,
    }),
    raw: { ...edited, previous_message: previous },
  };
}

/**
 * Return the new input of a pending original. Its route and mention stay, so
 * a mention that the edit adds starts no Turn.
 */
export function editedSlackInput(
  original: InboundMessage,
  message: Message,
  text: string,
): AgentInput {
  const isMention = parseSlackMetadata(original.input.metadata)?.message
    .isMention;
  return {
    ...original.input,
    text,
    metadata: {
      ...original.input.metadata,
      message: { ...message.toJSON(), isMention },
    },
  };
}

/** Whether a Slack Message id is of the correction that an edit added. */
export function isSlackEditCorrection(messageId: string): boolean {
  return messageId.includes(EDIT_ID_SEPARATOR);
}

/**
 * Render a correction as its own input. The person wrote both texts, so the
 * tag carries the author like `<current-instruction>` does.
 */
export function renderSlackMessageEdit(message: Message, text: string): string {
  const previous = previousTextSchema.safeParse(message.raw).data
    ?.previous_message.text;
  return renderTag(
    "message-edit",
    {
      author_id: message.author.userId,
      author_name: message.author.fullName,
      slack_ts: message.id.split(EDIT_ID_SEPARATOR)[0],
    },
    [
      ...(previous !== undefined
        ? [renderChildTag("previous-text", escapeTagText(previous))]
        : []),
      renderChildTag("text", escapeTagText(text)),
    ],
  );
}
