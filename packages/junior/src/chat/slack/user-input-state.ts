import { z } from "zod";
import type { StateAdapter } from "chat";
import { logException } from "@/chat/logging";
import { updateSlackMessage } from "@/chat/slack/outbound";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";
import {
  buildClosedSlackUserInputMessage,
  slackUserInputAnswerNote,
} from "@/chat/slack/user-input";
import {
  userInputRequestSchema,
  type UserInputRequest,
} from "@/chat/tools/runtime/user-input-request";

// One answer per request. Keep the state longer than people are likely to
// come back to an old thread.
const USER_INPUT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const openUserInputSchema = z.object({
  messageTs: z.string(),
  request: userInputRequestSchema,
  requestId: z.string().min(1),
});

function claimKey(channelId: string, messageTs: string): string {
  return `slack:user-input-claim:${channelId}:${messageTs}`;
}

function openKey(channelId: string, threadTs: string): string {
  return `slack:user-input-open:${channelId}:${threadTs}`;
}

/** The open user input request of one Slack thread. */
export interface OpenSlackUserInput {
  channelId: string;
  messageTs: SlackMessageTs;
  request: UserInputRequest;
  requestId: string;
}

/**
 * Claim the one answer of a Slack request. Return false when a click, a
 * form, or a reply already answered it.
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
 * Remember the open request of a Slack thread. Clicks and forms read it to
 * build the answer, and a typed reply closes it. A newer request in the same
 * thread replaces the older one. Return the replaced request, if any.
 */
export async function recordOpenSlackUserInput(
  state: StateAdapter,
  args: {
    channelId: string;
    messageTs: string;
    request: UserInputRequest;
    requestId: string;
    threadTs: string;
  },
): Promise<OpenSlackUserInput | undefined> {
  const replaced = await getOpenSlackUserInput(state, args);
  await state.set(
    openKey(args.channelId, args.threadTs),
    {
      messageTs: args.messageTs,
      request: args.request,
      requestId: args.requestId,
    },
    USER_INPUT_TTL_MS,
  );
  return replaced && replaced.messageTs !== args.messageTs
    ? replaced
    : undefined;
}

/** Read the open request of a Slack thread, if there is one. */
export async function getOpenSlackUserInput(
  state: StateAdapter,
  args: { channelId: string; threadTs: string },
): Promise<OpenSlackUserInput | undefined> {
  const open = openUserInputSchema.safeParse(
    await state.get(openKey(args.channelId, args.threadTs)),
  );
  if (!open.success) return undefined;
  const messageTs = parseSlackMessageTs(open.data.messageTs);
  if (!messageTs) return undefined;
  return {
    channelId: args.channelId,
    messageTs,
    request: open.data.request,
    requestId: open.data.requestId,
  };
}

/** Claim the open request of a Slack thread for a reply, if there is one. */
async function claimOpenSlackUserInput(args: {
  author: { userId: string };
  event: { channel?: string; thread_ts?: string };
  state: StateAdapter;
}): Promise<OpenSlackUserInput | undefined> {
  const channelId = args.event.channel;
  const threadTs = parseSlackMessageTs(args.event.thread_ts);
  if (!channelId || !threadTs) return undefined;
  const open = await getOpenSlackUserInput(args.state, {
    channelId,
    threadTs,
  });
  if (
    !open ||
    !(await claimSlackUserInput(args.state, {
      channelId,
      messageTs: open.messageTs,
      userId: args.author.userId,
    }))
  ) {
    return undefined;
  }
  return open;
}

/**
 * Replace the controls of a closed request with a note, such as the answer.
 * Best effort: the answer is already saved, so stale controls are only
 * cosmetic.
 */
export async function closeSlackUserInput(args: {
  note: string;
  open: OpenSlackUserInput;
}): Promise<void> {
  const message = buildClosedSlackUserInputMessage({
    note: args.note,
    request: args.open.request,
  });
  try {
    await updateSlackMessage({
      ...message,
      channelId: args.open.channelId,
      timestamp: args.open.messageTs,
    });
  } catch (error) {
    logException(error, "slack.user_input.close.failed", {
      "app.slack.channel_id": args.open.channelId,
      "app.slack.message_ts": args.open.messageTs,
    });
  }
}

/**
 * Save a message to Junior that can answer the open request of its Slack
 * thread instead of the controls. The reply claims the request before Junior
 * saves it, the same order as a click, so only the first of them is the
 * answer. When the reply wins, its controls change to a note. When Junior did
 * not save the reply, the claim is released so a click or a Slack retry can
 * answer.
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
  const note = slackUserInputAnswerNote({
    request: open.request,
    userId: args.author.userId,
  });
  try {
    await args.persist();
  } catch (error) {
    if (args.isSaved(error)) {
      await closeSlackUserInput({ note, open });
    } else {
      await releaseSlackUserInput(args.state, open);
    }
    throw error;
  }
  await closeSlackUserInput({ note, open });
}
