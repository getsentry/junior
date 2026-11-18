/**
 * Which committed messages belong to a Turn.
 *
 * A message belongs to the Turn when its event seq is above the seq of the
 * Turn's `turn_started` event. Seqs only grow in a Conversation, and a history
 * replacement keeps the source seq of each entry, so the messages of earlier
 * Turns stay below the line through any compaction.
 */
import type { TurnStart } from "@/chat/conversations/turn-lifecycle";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { PiMessage } from "@/chat/pi/messages";

/** True when the committed message at `seq` belongs to the Turn. */
export function isTurnMessage(
  start: TurnStart,
  seq: number,
  message: PiMessage,
  provenance: ConversationMessageProvenance | undefined,
): boolean {
  // System messages are host state, such as the sections message, not Turn
  // content.
  if (seq <= start.seq || message.role === "system") {
    return false;
  }
  // A fork child commits the history it inherited in its first Turn, with
  // the parent's timestamps, so it is older than the Turn. Steering keeps
  // the time its message was sent, which can be a bit before the Turn start,
  // so instructions stay in the Turn.
  return (
    provenance?.authority === "instruction" ||
    !("timestamp" in message) ||
    typeof message.timestamp !== "number" ||
    message.timestamp >= start.createdAtMs
  );
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
    const provenance = record.piMessageProvenance[index];
    return seq !== undefined && isTurnMessage(start, seq, message, provenance)
      ? [{ message, provenance: provenance ?? { authority: "context" } }]
      : [];
  });
}
