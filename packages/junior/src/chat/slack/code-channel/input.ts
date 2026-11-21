/**
 * Mailbox shape of one person's message in a Slack code channel. A channel
 * Thread runs on its Conversation loop, so its Slack input carries the Slack
 * Actor and Source facts that a Slack thread Turn gets from its webhook.
 */
import { createSlackSource } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { createSlackActor } from "@/chat/actor";
import type { MailboxTurnInput } from "@/chat/task-execution/mailbox-turn";
import type { InboundMessage } from "@/chat/task-execution/store";

const codeChannelMessageMetadataSchema = z.object({
  kind: z.literal("slack_code_channel_message"),
  channelId: z.string().min(1),
  fullName: z.string().min(1).optional(),
  messageTs: z.string().min(1),
  teamId: z.string().min(1),
  userId: z.string().min(1),
  userName: z.string().min(1).optional(),
});

/** Facts of one person's message in a code channel. */
type CodeChannelMessageMetadata = z.output<
  typeof codeChannelMessageMetadataSchema
>;

/** Build the mailbox metadata of one code channel message. */
export function codeChannelMessageMetadata(
  input: Omit<CodeChannelMessageMetadata, "kind">,
): CodeChannelMessageMetadata {
  return { kind: "slack_code_channel_message", ...input };
}

/**
 * Read one code channel input batch as Turn input. A batch with none gives
 * []. A Slack code channel that Junior binds is public, as its origin is.
 */
export function parseCodeChannelMessages(
  messages: readonly InboundMessage[],
): MailboxTurnInput[] {
  const parsed = messages.map((message) => ({
    message,
    metadata: codeChannelMessageMetadataSchema.safeParse(
      message.input.metadata,
    ),
  }));
  if (parsed.every((entry) => !entry.metadata.success)) {
    return [];
  }
  return parsed.map(({ message, metadata }) => {
    if (!metadata.success) {
      throw new Error("A Turn cannot combine different kinds of input");
    }
    const facts = metadata.data;
    const profile = {
      ...(facts.fullName ? { fullName: facts.fullName } : undefined),
      ...(facts.userName ? { userName: facts.userName } : undefined),
    };
    return {
      actor: createSlackActor(facts.teamId, facts.userId, profile),
      author: { userId: facts.userId, ...profile },
      message,
      source: createSlackSource({
        channelId: facts.channelId,
        messageTs: facts.messageTs,
        teamId: facts.teamId,
        visibility: "public",
      }),
    };
  });
}
