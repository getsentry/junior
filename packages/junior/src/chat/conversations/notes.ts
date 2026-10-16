/**
 * Conversation notes: short facts that core attaches to a Conversation without
 * starting a Turn. The next Turn that starts after a note shows it to the
 * model in its runtime turn context. See "Conversation Notes" in README.md.
 */
import { getConversationEventStore } from "@/chat/db";
import {
  conversationNoteEvent,
  JUNIOR_NATIVE_EVENT_NAMESPACE,
  MAX_CONVERSATION_NOTE_CHARS,
} from "./structured-events";

/** Most notes that one Turn shows. Older notes are counted, not shown. */
export const MAX_CONVERSATION_NOTES_PER_TURN = 20;

/** One Conversation note as the model sees it. */
export interface ConversationNote {
  createdAtMs: number;
  text: string;
}

/** The notes that one Turn shows, newest last. */
export interface TurnConversationNotes {
  notes: ConversationNote[];
  /** Older notes for the same Turn that were not shown. */
  omittedCount: number;
}

/**
 * Attach a core-written note to a Conversation. It does not start a Turn,
 * wake the Conversation, or change its activity. The key makes a retry add
 * nothing. Never pass model-written or user-written text as an instruction:
 * the model reads the note as a fact, not as authority.
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
 * Load the notes for one Turn: the notes added after the previous Turn
 * started and before this Turn started. A note added while this Turn runs
 * waits for the next Turn. Each Turn reads the same window on every retry,
 * so each note is shown to exactly one Turn. When this Turn is not the newest
 * started Turn, it gets no notes, because a newer Turn owns them.
 */
export async function loadTurnConversationNotes(input: {
  conversationId: string;
  turnId: string;
}): Promise<TurnConversationNotes> {
  const newestFirst: ConversationNote[] = [];
  let foundTurn = false;
  let beforeSeq: number | undefined;
  selection: while (true) {
    const page = await getConversationEventStore().query(input.conversationId, {
      beforeSeq,
      limit: 100,
      types: ["turn_started", "structured_event"],
    });
    for (const event of [...page.events].reverse()) {
      const data = event.data;
      if (data.type === "turn_started") {
        if (foundTurn) break selection;
        if (data.turnId !== input.turnId) {
          return { notes: [], omittedCount: 0 };
        }
        foundTurn = true;
        continue;
      }
      if (
        !foundTurn ||
        data.type !== "structured_event" ||
        data.namespace !== JUNIOR_NATIVE_EVENT_NAMESPACE ||
        data.name !== conversationNoteEvent.eventName ||
        data.version !== conversationNoteEvent.version
      ) {
        continue;
      }
      const { text } = conversationNoteEvent.parse(data.content);
      if (typeof text === "string") {
        newestFirst.push({ createdAtMs: event.createdAtMs, text });
      }
    }
    if (!page.hasOlder || page.events.length === 0) break;
    beforeSeq = page.events[0]!.seq;
  }
  return {
    notes: newestFirst.slice(0, MAX_CONVERSATION_NOTES_PER_TURN).reverse(),
    omittedCount: Math.max(
      0,
      newestFirst.length - MAX_CONVERSATION_NOTES_PER_TURN,
    ),
  };
}
