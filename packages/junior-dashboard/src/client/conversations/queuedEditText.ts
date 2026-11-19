import * as z from "zod";

// An edit moves queued text into the draft before its cancel lands. When the
// cancel fails, the message stays queued and its text stays in the draft. A
// retry must not add the text again, also after the reply box remounts, so
// the ids live in local storage next to the saved draft.
const STORAGE_PREFIX = "junior:dashboard:queued-edit-text:";

const idsSchema = z.array(z.string());

function storageKey(conversationId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(conversationId)}`;
}

function readIds(conversationId: string): Set<string> {
  try {
    const parsed = idsSchema.safeParse(
      JSON.parse(
        window.localStorage.getItem(storageKey(conversationId)) ?? "[]",
      ),
    );
    return new Set(parsed.success ? parsed.data : []);
  } catch {
    // Without the store, a retry can add the text again.
    return new Set();
  }
}

/** True when the text of this queued message is already in the draft. */
export function queuedTextInDraft(
  conversationId: string,
  inboundMessageId: string,
): boolean {
  return readIds(conversationId).has(inboundMessageId);
}

/** Record whether the text of a queued message is in the draft. */
export function setQueuedTextInDraft(
  conversationId: string,
  inboundMessageId: string,
  inDraft: boolean,
): void {
  const ids = readIds(conversationId);
  if (inDraft) ids.add(inboundMessageId);
  else ids.delete(inboundMessageId);
  try {
    if (ids.size) {
      window.localStorage.setItem(
        storageKey(conversationId),
        JSON.stringify([...ids]),
      );
    } else {
      window.localStorage.removeItem(storageKey(conversationId));
    }
  } catch {
    // Without the store, a retry can add the text again.
  }
}
