import type { StateAdapter } from "chat";
import type { SlackInboundEvent } from "./slack-payload";
import { textMentionsBot } from "./bot-mention";
import { renderBlockText } from "@/chat/slack/message/blocks";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";

/**
 * Track new one-on-one threads under the ingress lock. Store the root author
 * or false; replies and duplicate root events can never reopen a blocked thread.
 * Unverified authors can only block tracking, not enable it or start a Turn.
 */
export async function trackOneOnOneThread(args: {
  botUserId: string;
  event: Pick<
    SlackInboundEvent,
    "ts" | "thread_ts" | "user" | "text" | "subtype"
  > & { blocks?: unknown };
  member: boolean;
  state: StateAdapter;
  threadId: string;
}): Promise<boolean> {
  const { botUserId, event, member, state, threadId } = args;
  const isRoot = !event.thread_ts || event.thread_ts === event.ts;
  const text = [event.text ?? "", renderBlockText(event.blocks)].join("\n");
  const rootMention = isRoot && textMentionsBot(text, botUserId);
  if (isRoot && !rootMention && event.subtype !== "message_changed")
    return false;

  // Expire at a fixed age, not after the last event. An old root redelivery
  // must not recreate tracking after the state expires.
  const ttlMs =
    Number(event.thread_ts ?? event.ts) * 1_000 +
    JUNIOR_THREAD_STATE_TTL_MS -
    Date.now();
  if (ttlMs <= 0) return false;
  const key = `slack:one-on-one:${threadId}`;
  const current = await state.get<string | false>(key);
  if (current === false) return false;

  const owner =
    typeof current === "string"
      ? current
      : rootMention &&
          member &&
          event.user !== botUserId &&
          event.subtype !== "message_changed"
        ? event.user
        : undefined;
  const allowedUsers = new Set([botUserId, owner]);
  const mentionsOthers =
    [...text.matchAll(/<@([^>|]+)(?:\|[^>]+)?>/g)].some(
      ([, userId]) =>
        !allowedUsers.has(userId) && textMentionsBot(text, userId!),
    ) || /<!(?:subteam\^|here[>|]|channel[>|]|everyone[>|])/.test(text);
  const eligible = Boolean(
    owner && event.user && allowedUsers.has(event.user) && !mentionsOthers,
  );

  // An untracked reply blocks a late root event. Edits can revoke eligibility,
  // but cannot enable it. No history lookup is needed to make either decision.
  if (current === null || current === undefined || !eligible) {
    await state.set(key, eligible ? owner! : false, ttlMs);
  }
  return (
    eligible &&
    !isRoot &&
    event.subtype !== "message_changed" &&
    event.user === owner
  );
}
