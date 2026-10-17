/**
 * Conversation notes: short facts that core attaches to a Conversation without
 * starting a Turn. The next Turn shows them to the model in its runtime turn
 * context. See "Conversation Notes" in README.md.
 */
import { getConversationEventStore } from "@/chat/db";
import {
  conversationNoteEvent,
  JUNIOR_NATIVE_EVENT_NAMESPACE,
  MAX_CONVERSATION_NOTE_CHARS,
} from "./structured-events";

/** Most notes that one Turn shows. Older notes in the window are dropped. */
const MAX_CONVERSATION_NOTES_PER_TURN = 20;

/**
 * Attach a core-written note to a Conversation. It does not start a Turn or
 * change Conversation activity. The key makes a retry add nothing. Long text
 * is cut at the end.
 */
export async function addConversationNote(input: {
  conversationId: string;
  createdAtMs: number;
  key: string;
  text: string;
}): Promise<void> {
  // One line per note keeps the rendered list unambiguous.
  const line = input.text.replace(/\s+/g, " ").trim();
  const text =
    line.length > MAX_CONVERSATION_NOTE_CHARS
      ? `${line.slice(0, MAX_CONVERSATION_NOTE_CHARS - 1)}…`
      : line;
  await getConversationEventStore().append(
    input.conversationId,
    [
      {
        createdAtMs: input.createdAtMs,
        idempotencyKey: `native:${JUNIOR_NATIVE_EVENT_NAMESPACE}:conversation_note:${input.key}`,
        data: {
          type: "structured_event",
          namespace: JUNIOR_NATIVE_EVENT_NAMESPACE,
          name: conversationNoteEvent.eventName,
          version: conversationNoteEvent.version,
          content: conversationNoteEvent.parse({ text }),
        },
      },
    ],
    { activity: "preserve" },
  );
}

/**
 * Load the note texts for one Turn, oldest first: the notes added after the
 * previous Turn started and before this Turn started. A retry of the Turn
 * reads the same window, so each note is shown to one Turn. A Turn that is
 * not the newest started Turn gets no notes.
 */
export async function loadTurnConversationNotes(input: {
  conversationId: string;
  turnId: string;
}): Promise<string[]> {
  const newestFirst: string[] = [];
  let foundTurn = false;
  let beforeSeq: number | undefined;
  scan: while (true) {
    const page = await getConversationEventStore().query(input.conversationId, {
      beforeSeq,
      limit: 100,
      types: ["turn_started", "structured_event"],
    });
    for (const { data } of [...page.events].reverse()) {
      if (data.type === "turn_started") {
        if (foundTurn) break scan;
        if (data.turnId !== input.turnId) return [];
        foundTurn = true;
      } else if (
        foundTurn &&
        data.type === "structured_event" &&
        data.namespace === JUNIOR_NATIVE_EVENT_NAMESPACE &&
        data.name === conversationNoteEvent.eventName &&
        data.version === conversationNoteEvent.version
      ) {
        // The schema makes `text` a string.
        newestFirst.push(
          conversationNoteEvent.parse(data.content).text as string,
        );
        if (newestFirst.length === MAX_CONVERSATION_NOTES_PER_TURN) break scan;
      }
    }
    if (!page.hasOlder || page.events.length === 0) break;
    beforeSeq = page.events[0]!.seq;
  }
  return newestFirst.reverse();
}
