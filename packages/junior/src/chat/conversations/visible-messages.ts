/**
 * Visible-transcript sync between the in-memory turn working set and SQL.
 *
 * The durable authority for the visible conversation transcript is the
 * `ConversationMessageStore`; `ThreadConversationState.messages` is only the
 * in-memory working set for the current turn. These helpers hydrate that
 * working set from SQL at load boundaries and write new/updated messages back
 * through the store, so no transcript data is persisted to `thread-state`.
 */
import type {
  ConversationMessage as StoredConversationMessage,
  ConversationMessageStore,
  NewConversationMessage,
} from "@/chat/conversations/messages";
import { getConversationMessageStore } from "@/chat/db";
import { updateConversationStats } from "@/chat/services/conversation-memory";
import type {
  ConversationAuthor,
  ConversationMessage,
  ConversationMessageMeta,
  ThreadConversationState,
} from "@/chat/state/conversation";

function resolveStore(
  store: ConversationMessageStore | undefined,
): ConversationMessageStore {
  return store ?? getConversationMessageStore();
}

/**
 * Project the in-memory message onto the store insert shape. This is the single
 * serialization point for visible messages, so both live turn persistence and
 * the one-time legacy import produce identical rows: author display facts and
 * bounded source meta ride in the `meta` JSON so the working set rehydrates with
 * identical rendering, and `replied === true` is not stored in meta because
 * `replied_at` is its authority.
 */
export function toStoredConversationMessage(
  message: ConversationMessage,
): NewConversationMessage {
  const meta: Record<string, unknown> = {};
  if (message.author) {
    meta.author = message.author;
  }
  const { replied, ...restMeta } = message.meta ?? {};
  Object.assign(meta, restMeta);
  if (replied === false) {
    meta.replied = false;
  }
  return {
    messageId: message.id,
    role: message.role,
    text: message.text,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    createdAtMs: message.createdAtMs,
  };
}

/** Rebuild the in-memory message from a stored row, deriving `replied` from `replied_at`. */
function fromStoredMessage(
  row: StoredConversationMessage,
): ConversationMessage {
  const rawMeta: Record<string, unknown> = { ...(row.meta ?? {}) };
  const author = rawMeta.author as ConversationAuthor | undefined;
  delete rawMeta.author;
  const meta = { ...rawMeta } as ConversationMessageMeta;
  if (row.repliedAtMs !== undefined) {
    meta.replied = true;
  }
  return {
    id: row.messageId,
    role: row.role,
    text: row.text,
    createdAtMs: row.createdAtMs,
    ...(author ? { author } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

/**
 * Replace the in-memory working set with the durable transcript from SQL,
 * excluding messages already folded into a thread-state compaction summary.
 */
export async function hydrateConversationMessages(args: {
  conversation: ThreadConversationState;
  conversationId: string | undefined;
  messageStore?: ConversationMessageStore;
}): Promise<void> {
  if (!args.conversationId) {
    args.conversation.messages = [];
    return;
  }
  const store = resolveStore(args.messageStore);
  const rows = await store.list(args.conversationId);
  const coveredIds = new Set(
    args.conversation.compactions.flatMap(
      (compaction) => compaction.coveredMessageIds,
    ),
  );
  args.conversation.messages = rows
    .filter((row) => !coveredIds.has(row.messageId))
    .map(fromStoredMessage);
  updateConversationStats(args.conversation);
}

/**
 * Write the working set back to SQL: record every message idempotently and set
 * the `replied_at` mark for messages the turn has answered. Content columns are
 * insert-only and `meta` merges key-wise on conflict, so repeated calls across
 * a turn's persist points are safe.
 */
export async function persistConversationMessages(args: {
  conversation: ThreadConversationState;
  conversationId: string | undefined;
  messageStore?: ConversationMessageStore;
  repliedAtMs?: number;
}): Promise<void> {
  if (!args.conversationId || args.conversation.messages.length === 0) {
    return;
  }
  const store = resolveStore(args.messageStore);
  await store.record(
    args.conversationId,
    args.conversation.messages.map(toStoredConversationMessage),
  );
  const repliedAtMs = args.repliedAtMs ?? Date.now();
  for (const message of args.conversation.messages) {
    if (message.meta?.replied === true) {
      await store.markReplied(args.conversationId, message.id, repliedAtMs);
    }
  }
}
