import {
  commitMessages,
  loadConversationProjection,
} from "@/chat/conversations/projection";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { PiMessage } from "@/chat/pi/messages";
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";

/**
 * Return a stable key for one parked user input. Resolved attachments may
 * change when the queue retries, so only the message time and text form the
 * key.
 */
export function parkedInputKey(message: PiMessage): string | undefined {
  if (message.role !== "user") {
    return undefined;
  }
  const first = Array.isArray(message.content) ? message.content[0] : undefined;
  const text =
    first && typeof first === "object" && "text" in first
      ? String((first as { text?: unknown }).text ?? "")
      : "";
  return `${message.timestamp}:${text}`;
}

/**
 * Save each parked input once while holding the same lock as a resumed Slack
 * Turn. Return false when the resumed Run owns the lock.
 */
export async function saveParkedInput(args: {
  conversationId: string;
  entries: Array<{
    message: PiMessage;
    provenance: ConversationMessageProvenance;
  }>;
}): Promise<boolean> {
  if (args.entries.length === 0) {
    return true;
  }
  const state = getStateAdapter();
  await state.connect();
  const lock = await acquireActiveLock(state, args.conversationId);
  if (!lock) {
    return false;
  }
  try {
    const projection = await loadConversationProjection({
      conversationId: args.conversationId,
    });
    // A queue retry can contain a mix of saved and unsaved input.
    const savedKeys = new Set(
      projection.messages
        .map(parkedInputKey)
        .filter((key): key is string => key !== undefined),
    );
    const missing = args.entries.filter((entry) => {
      const key = parkedInputKey(entry.message);
      return key === undefined || !savedKeys.has(key);
    });
    if (missing.length === 0) {
      return true;
    }
    await commitMessages({
      conversationId: args.conversationId,
      messages: [
        ...projection.messages,
        ...missing.map((entry) => entry.message),
      ],
      provenance: [
        ...projection.provenance,
        ...missing.map((entry) => entry.provenance),
      ],
    });
    return true;
  } finally {
    await state.releaseLock(lock);
  }
}
