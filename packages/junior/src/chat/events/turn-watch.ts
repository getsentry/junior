/**
 * Read the Watch that started a Turn (`follows-instruction`).
 */
import { sameActorIdentity } from "@/chat/conversations/provenance";
import { isEventMailboxMetadata } from "@/chat/events/mailbox-metadata";
import { getWatch } from "@/chat/events/store";
import type { TurnWatch, WatchCreator } from "@/chat/events/watch-creator";
import type { InboundMessage } from "@/chat/task-execution/store";

function sameCreator(left: WatchCreator, right: WatchCreator): boolean {
  return left.actor || right.actor
    ? sameActorIdentity(left.actor, right.actor)
    : true;
}

/**
 * Read the Watch of a Turn that Watch Events started. Returns nothing when
 * an input did not come from a Watch of this Conversation, or when the
 * Watches have no creator or different creators.
 */
export async function readTurnWatch(
  conversationId: string,
  messages: readonly InboundMessage[],
): Promise<TurnWatch | undefined> {
  let creator: WatchCreator | undefined;
  const intents: string[] = [];
  for (const message of messages) {
    const metadata = message.input.metadata;
    const watchId = isEventMailboxMetadata(metadata)
      ? metadata.event.subscriptionId
      : undefined;
    if (!watchId) return undefined;
    // oxlint-disable-next-line no-await-in-loop -- A Turn has few Watches.
    const watch = await getWatch({ id: watchId });
    if (!watch?.creator || watch.conversationId !== conversationId) {
      return undefined;
    }
    if (creator && !sameCreator(creator, watch.creator)) return undefined;
    creator = watch.creator;
    if (!intents.includes(watch.intent)) intents.push(watch.intent);
  }
  return creator ? { creator, intents } : undefined;
}
