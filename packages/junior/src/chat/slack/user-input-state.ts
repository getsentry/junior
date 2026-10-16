import { z } from "zod";
import type { StateAdapter } from "chat";
import { logException } from "@/chat/logging";
import { updateSlackMessage } from "@/chat/slack/outbound";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import {
  buildAnsweredSlackUserInputBlocks,
  buildSlackUserInputMessage,
} from "@/chat/slack/user-input";
import {
  userInputRequestSchema,
  type UserInputRequest,
} from "@/chat/tools/runtime/request-user-input";

// One answer per question. Keep the state longer than people are likely to
// come back to an old thread.
const USER_INPUT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const openUserInputSchema = z.object({
  messageTs: z.string(),
  request: userInputRequestSchema,
});

function claimKey(channelId: string, messageTs: string): string {
  return `slack:user-input-claim:${channelId}:${messageTs}`;
}

function openKey(channelId: string, threadTs: string): string {
  return `slack:user-input-open:${channelId}:${threadTs}`;
}

/**
 * Claim the one answer of a Slack question. Return false when a click or a
 * reply already answered it.
 */
export async function claimSlackUserInput(
  state: StateAdapter,
  args: { channelId: string; messageTs: string; userId: string },
): Promise<boolean> {
  return state.setIfNotExists(
    claimKey(args.channelId, args.messageTs),
    args.userId,
    USER_INPUT_TTL_MS,
  );
}

/** Release a claim when Junior could not save the answer. */
export async function releaseSlackUserInput(
  state: StateAdapter,
  args: { channelId: string; messageTs: string },
): Promise<void> {
  await state.delete(claimKey(args.channelId, args.messageTs));
}

/**
 * Remember the open question of a Slack thread, so a typed reply can close
 * it. A newer question in the same thread replaces the older one.
 */
export async function recordOpenSlackUserInput(
  state: StateAdapter,
  args: {
    channelId: string;
    messageTs: string;
    request: UserInputRequest;
    threadTs: string;
  },
): Promise<void> {
  await state.set(
    openKey(args.channelId, args.threadTs),
    { messageTs: args.messageTs, request: args.request },
    USER_INPUT_TTL_MS,
  );
}

/**
 * Close the open question of a Slack thread after a person answers it with a
 * message to Junior instead of a click. This claims the question, so a later
 * click does nothing, and replaces the buttons with a note.
 *
 * The answer is already saved, so a failure here only leaves stale buttons.
 */
export async function closeSlackUserInputOnReply(
  state: StateAdapter,
  event: { channel?: string; thread_ts?: string },
  author: { userId: string },
): Promise<void> {
  const channelId = event.channel;
  const threadTs = parseSlackMessageTs(event.thread_ts);
  if (!channelId || !threadTs) return;
  const key = openKey(channelId, threadTs);
  try {
    const open = openUserInputSchema.safeParse(await state.get(key));
    if (!open.success) return;
    await state.delete(key);
    const messageTs = parseSlackMessageTs(open.data.messageTs);
    if (
      !messageTs ||
      !(await claimSlackUserInput(state, {
        channelId,
        messageTs,
        userId: author.userId,
      }))
    ) {
      return;
    }
    const message = buildSlackUserInputMessage(open.data.request);
    await updateSlackMessage({
      blocks: buildAnsweredSlackUserInputBlocks({
        blocks: message.blocks,
        userId: author.userId,
      }),
      channelId,
      text: message.text,
      timestamp: messageTs,
    });
  } catch (error) {
    logException(error, "slack.user_input.reply_close.failed", {
      "app.slack.channel_id": channelId,
      "app.slack.thread_ts": threadTs,
    });
  }
}
