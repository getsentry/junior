import type { StateAdapter } from "chat";
import type { SlackInboundEvent } from "./slack-payload";
import { textMentionsBot } from "./bot-mention";
import { getSlackClient } from "@/chat/slack/client";
import { parseSlackThreadId } from "@/chat/slack/context";
import { renderBlockText } from "@/chat/slack/message/blocks";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";

/**
 * Accept a follow-up only when the full Slack thread contains Junior and its
 * author. Read from the root, not retained agent context, which can omit people.
 * The caller holds the ingress lock and has checked the thread subscription.
 */
export async function isOneOnOneThreadReply(args: {
  botUserId: string;
  event: SlackInboundEvent;
  state: StateAdapter;
  threadId: string;
}): Promise<boolean> {
  const { botUserId, event, state, threadId } = args;
  const coordinates = parseSlackThreadId(threadId);
  if (!coordinates || !event.user || !event.thread_ts) return false;

  const blockedKey = `slack:one-on-one-blocked:${threadId}`;
  if (await state.get(blockedKey)) return false;

  const allowedUsers = new Set([botUserId, event.user]);
  const involvesOthers = (message: {
    user?: string;
    text?: string;
    blocks?: unknown;
  }): boolean => {
    if (message.user && !allowedUsers.has(message.user)) return true;
    const text = [message.text ?? "", renderBlockText(message.blocks)].join(
      "\n",
    );
    // Use the activation parser so code examples do not count as invitations.
    for (const match of text.matchAll(/<@([^>|]+)(?:\|[^>]+)?>/g)) {
      if (!allowedUsers.has(match[1]!) && textMentionsBot(text, match[1]!)) {
        return true;
      }
    }
    // A group or channel notification also invites people into the thread.
    return /<!(?:subteam\^|here[>|]|channel[>|]|everyone[>|])/.test(text);
  };
  const block = async (): Promise<false> => {
    // Keep the decision if a participant later deletes their message. After
    // state expiry, a fresh full-history read must prove the thread is eligible.
    await state.set(blockedKey, true, JUNIOR_THREAD_STATE_TTL_MS);
    return false;
  };

  if (involvesOthers(event)) return await block();

  let cursor: string | undefined;
  let sawRoot = false;
  let sawBot = false;
  const client = getSlackClient();
  // Bound webhook work. A long or incomplete thread stays mention-only.
  for (let page = 0; page < 10; page += 1) {
    const response = await client.conversations.replies({
      channel: coordinates.channelId,
      ts: coordinates.threadTs,
      limit: 100,
      cursor,
    });
    if (!response.messages?.length) return false;
    for (const message of response.messages) {
      if (involvesOthers(message)) return await block();
      if (!message.user) return false;
      sawRoot ||= message.ts === coordinates.threadTs;
      sawBot ||= message.user === botUserId;
    }
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) return !response.has_more && sawRoot && sawBot;
  }
  return false;
}
