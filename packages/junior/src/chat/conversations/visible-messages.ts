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
  NewConversationMessage,
} from "@/chat/conversations/messages";
import { getConversationMessageStore } from "@/chat/db";
import { hydrateConversationCompactions } from "./visible-compactions";
import { updateConversationStats } from "@/chat/services/conversation-memory";
import type {
  ConversationAuthor,
  ConversationMessage,
  ConversationMessageMeta,
  ThreadConversationState,
} from "@/chat/state/conversation";

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
 *
 * Hydrate is a first-read boundary, so it must trigger the once-only Redis→SQL
 * lazy import before reading SQL: consumers that hydrate before any step
 * projection read (turn-dedupe, delivered-message redelivery guards,
 * channel-context assembly) would otherwise make correctness decisions on an
 * empty transcript for promotion-window stragglers whose history is still only
 * in legacy Redis. The import is idempotent (skips when SQL step rows exist)
 * and no-ops cheaply when there is nothing legacy to read.
 */
export async function hydrateConversationMessages(args: {
  conversation: ThreadConversationState;
  conversationId: string | undefined;
}): Promise<void> {
  if (!args.conversationId) {
    args.conversation.messages = [];
    return;
  }
  // Lazy Redis→SQL import for promotion-window stragglers, run before the SQL
  // read so hydrate never observes an empty transcript for a conversation whose
  // history is still only in legacy Redis. The dynamic import is deliberate:
  // legacy-import.ts statically imports `toStoredConversationMessage` from this
  // module, so a static import back would create a cycle; a function-level
  // dynamic import keeps this seam trivially deletable when the legacy-import
  // module is removed wholesale after the legacy Redis TTL horizon.
  const { ensureLegacyConversationImport } =
    await import("@/chat/conversations/legacy-import");
  await ensureLegacyConversationImport({ conversationId: args.conversationId });
  await hydrateConversationCompactions({
    conversation: args.conversation,
    conversationId: args.conversationId,
  });
  const store = getConversationMessageStore();
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
  repliedAtMs?: number;
}): Promise<void> {
  if (!args.conversationId || args.conversation.messages.length === 0) {
    return;
  }
  const store = getConversationMessageStore();
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
