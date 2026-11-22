/**
 * Which committed messages belong to a Turn.
 *
 * A message belongs to the Turn when its event seq is above the seq of the
 * Turn's `turn_started` event. Seqs only grow in a Conversation, and a history
 * replacement keeps the source seq of each entry, so the messages of earlier
 * Turns stay below the line through any compaction. A fork child commits the
 * history that it inherits before its first `turn_started`, so that history
 * is below the line too.
 */
import type { TurnStart } from "@/chat/conversations/turn-lifecycle";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { PiMessage } from "@/chat/pi/messages";

/** True when the committed message at `seq` belongs to the Turn. */
export function isTurnMessage(
  start: TurnStart,
  seq: number,
  message: PiMessage,
): boolean {
  // System messages are host state, such as the sections message, not Turn
  // content.
  return seq > start.seq && message.role !== "system";
}

/**
 * The messages of a saved Turn with their provenance. Without a
 * `turn_started` event, nothing tells this Turn from earlier history, so it
 * has no messages.
 */
export function savedTurnMessages(
  record: {
    piMessageProvenance: ConversationMessageProvenance[];
    piMessageSeqs: number[];
    piMessages: PiMessage[];
  },
  start: TurnStart | undefined,
): Array<{ message: PiMessage; provenance: ConversationMessageProvenance }> {
  if (!start) {
    return [];
  }
  return record.piMessages.flatMap((message, index) => {
    const seq = record.piMessageSeqs[index];
    return seq !== undefined && isTurnMessage(start, seq, message)
      ? [
          {
            message,
            provenance: record.piMessageProvenance[index] ?? {
              authority: "context",
            },
          },
        ]
      : [];
  });
}
