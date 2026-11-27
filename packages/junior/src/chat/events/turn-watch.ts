/**
 * Read the Watch that started a Turn (`follows-instruction`).
 */
import { sameActorIdentity } from "@/chat/conversations/provenance";
import { isEventMailboxMetadata } from "@/chat/events/mailbox-metadata";
import { readEventTaskFacts } from "@/chat/events/notification";
import {
  watchCreatorSchema,
  type TurnWatch,
  type WatchCreator,
} from "@/chat/events/watch-creator";
import type { InboundMessage } from "@/chat/task-execution/store";

function sameCreator(left: WatchCreator, right: WatchCreator): boolean {
  return left.actor || right.actor
    ? sameActorIdentity(left.actor, right.actor)
    : left.plugin === right.plugin;
}

/**
 * Read the Watch of a Turn that Watch Events started, from the creator that
 * delivery copied from each Watch and the saved task facts. Returns nothing
 * when an input has no creator or no saved facts, or when the Watches have
 * different creators: such a Turn keeps every Event as context.
 */
export function readTurnWatch(
  messages: readonly InboundMessage[],
): TurnWatch | undefined {
  let creator: WatchCreator | undefined;
  const events: TurnWatch["events"] = [];
  for (const message of messages) {
    const metadata = message.input.metadata;
    if (!isEventMailboxMetadata(metadata)) return undefined;
    const parsed = watchCreatorSchema.safeParse(metadata.watchCreator);
    const task = readEventTaskFacts(message)?.facts;
    if (!parsed.success || !task) return undefined;
    if (creator && !sameCreator(creator, parsed.data)) return undefined;
    creator = parsed.data;
    events.push(task);
  }
  return creator ? { creator, events } : undefined;
}
