import { z } from "zod";
import type { StateAdapter } from "chat";
import { logException } from "@/chat/logging";
import { updateSlackMessage } from "@/chat/slack/outbound";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";
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

interface OpenSlackUserInput {
  channelId: string;
  messageTs: SlackMessageTs;
  request: UserInputRequest;
}

/** Claim the open question of a Slack thread for a reply, if there is one. */
async function claimOpenSlackUserInput(args: {
  author: { userId: string };
  event: { channel?: string; thread_ts?: string };
  state: StateAdapter;
}): Promise<OpenSlackUserInput | undefined> {
  const channelId = args.event.channel;
  const threadTs = parseSlackMessageTs(args.event.thread_ts);
  if (!channelId || !threadTs) return undefined;
  const open = openUserInputSchema.safeParse(
    await args.state.get(openKey(channelId, threadTs)),
  );
  if (!open.success) return undefined;
  const messageTs = parseSlackMessageTs(open.data.messageTs);
  if (
    !messageTs ||
    !(await claimSlackUserInput(args.state, {
      channelId,
      messageTs,
      userId: args.author.userId,
    }))
  ) {
    return undefined;
  }
  return { channelId, messageTs, request: open.data.request };
}

/** Replace the buttons of an answered question with a note. Best effort. */
async function closeAnsweredSlackUserInput(
  open: OpenSlackUserInput,
  author: { userId: string },
): Promise<void> {
  const message = buildSlackUserInputMessage(open.request);
  try {
    await updateSlackMessage({
      blocks: buildAnsweredSlackUserInputBlocks({
        blocks: message.blocks,
        userId: author.userId,
      }),
      channelId: open.channelId,
      text: message.text,
      timestamp: open.messageTs,
    });
  } catch (error) {
    // The reply is already saved. A stale button row is only cosmetic.
    logException(error, "slack.user_input.reply_close.failed", {
      "app.slack.channel_id": open.channelId,
      "app.slack.message_ts": open.messageTs,
    });
  }
}

/**
 * Save a message to Junior that can answer the open question of its Slack
 * thread instead of a click. The reply claims the question before Junior saves
 * it, the same order as a click, so only the first of them is the answer. When
 * the reply wins, its buttons change to a note. When Junior did not save the
 * reply, the claim is released so a click or a Slack retry can answer.
 *
 * `isSaved` tells if a failed `persist` still saved the reply.
 */
export async function persistSlackUserInputReply(args: {
  author: { userId: string };
  event: { channel?: string; thread_ts?: string };
  isSaved: (error: unknown) => boolean;
  persist: () => Promise<void>;
  state: StateAdapter;
}): Promise<void> {
  const open = await claimOpenSlackUserInput(args);
  if (!open) {
    await args.persist();
    return;
  }
  try {
    await args.persist();
  } catch (error) {
    if (args.isSaved(error)) {
      await closeAnsweredSlackUserInput(open, args.author);
    } else {
      await releaseSlackUserInput(args.state, open);
    }
    throw error;
  }
  await closeAnsweredSlackUserInput(open, args.author);
}
