/**
 * One-time Redis→SQL conversation import for the operator upgrade command.
 *
 * A single per-conversation import unit used by `junior upgrade` (bulk,
 * bounded newest-first). It converts the
 * legacy session log into `junior_conversation_events`, imports the advisor
 * session blob as a child conversation, and converts `thread-state` messages
 * into canonical events.
 * Import is idempotent per conversation: canonical event rows seal completed
 * imports. It never fabricates import-time timestamps.
 *
 * This module is intentionally outside the runtime conversation graph. Remove
 * it after the legacy Redis operator-migration horizon passes.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { type ConversationMessage as ThreadConversationMessage } from "@/chat/state/conversation";
import { getStateAdapter } from "@/chat/state/adapter";
import type { PiMessage } from "@/chat/pi/messages";
import {
  readSessionLogEntries,
  type SessionLogEntry,
  type SessionLogStore,
} from "./session-log";
import {
  createLegacyAdvisorSessionReader,
  type LegacyAdvisorSessionReader,
} from "./advisor-session";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";
import type { Conversation } from "@/chat/conversations/store";
import {
  convertAdvisorMessages,
  convertLegacySessionLog,
  writeLegacyImport,
} from "./legacy-history-import";

const legacyVisibleMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  createdAtMs: z.number().finite(),
  author: z.object({}).passthrough().optional(),
  meta: z.object({}).passthrough().optional(),
}) satisfies z.ZodType<ThreadConversationMessage>;

const legacyCompactionSchema = z.object({
  coveredMessageIds: z.array(z.string()),
  createdAtMs: z.number().finite(),
  id: z.string(),
  summary: z.string(),
});

type LegacyConversationCompaction = z.output<typeof legacyCompactionSchema>;

function toImportedMessage(message: ThreadConversationMessage): {
  messageId: string;
  role: "user" | "assistant" | "system";
  text: string;
  meta?: Record<string, unknown>;
  createdAtMs: number;
} {
  const meta: Record<string, unknown> = {};
  if (message.author) meta.author = message.author;
  const { replied: _replied, ...restMeta } = message.meta ?? {};
  Object.assign(meta, restMeta);
  return {
    messageId: message.id,
    role: message.role,
    text: message.text,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    createdAtMs: message.createdAtMs,
  };
}

const legacyThreadStateSnapshotSchema = z.object({
  conversation: z
    .object({
      compactions: z.array(legacyCompactionSchema).optional(),
      messages: z.array(legacyVisibleMessageSchema).optional(),
      stats: z
        .object({
          compactedMessageCount: z.number().finite().optional(),
          updatedAtMs: z.number().finite().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

/** Legacy source seams used by the one-time migration. */
export interface LegacyImportDeps {
  executor: JuniorSqlDatabase;
  /** Standard model binding written onto imported context checkpoints. */
  modelId: string;
  sessionLogStore?: SessionLogStore;
  advisorSessionStore?: LegacyAdvisorSessionReader;
  loadVisibleMessages?: (
    conversationId: string,
  ) => Promise<ThreadConversationMessage[]>;
  legacyCompactions?: LegacyConversationCompaction[];
  /** Conversation metadata used for imported creation and activity clocks. */
  conversationRecord?: Conversation;
  /** Latest activity recovered from the legacy thread-state payload. */
  legacyLastActivityAtMs?: number;
}

/** Read legacy transcript data from `thread-state:<id>`. */
async function loadThreadStateSnapshot(conversationId: string): Promise<{
  compactions: LegacyConversationCompaction[];
  compactedMessageCount?: number;
  messages: ThreadConversationMessage[];
  lastActivityAtMs?: number;
}> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const raw = await stateAdapter.get<unknown>(`thread-state:${conversationId}`);
  if (!raw) {
    return { compactions: [], messages: [] };
  }
  const conversation = legacyThreadStateSnapshotSchema.parse(raw).conversation;
  return {
    compactions: conversation?.compactions ?? [],
    messages: conversation?.messages ?? [],
    ...(conversation?.stats?.compactedMessageCount !== undefined
      ? { compactedMessageCount: conversation.stats.compactedMessageCount }
      : {}),
    ...(conversation?.stats?.updatedAtMs !== undefined
      ? { lastActivityAtMs: conversation.stats.updatedAtMs }
      : {}),
  };
}

function intrinsicTimestamps(
  entries: SessionLogEntry[],
  visible: ThreadConversationMessage[],
  compactions: LegacyConversationCompaction[],
): number[] {
  const candidates: number[] = [];
  const pushMessageTs = (message: PiMessage): void => {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "number") {
      candidates.push(timestamp);
    }
  };
  for (const entry of entries) {
    if (entry.type === "pi_message") {
      pushMessageTs(entry.message);
    } else if (entry.type === "projection_reset") {
      entry.messages.forEach(pushMessageTs);
    } else if ("createdAtMs" in entry) {
      candidates.push(entry.createdAtMs);
    }
  }
  for (const message of visible) {
    candidates.push(message.createdAtMs);
  }
  for (const compaction of compactions) {
    candidates.push(compaction.createdAtMs);
  }
  return candidates;
}

/**
 * Import one conversation's legacy Redis history into SQL, idempotently.
 *
 * Returns whether an import ran (false when event rows already exist or there is
 * nothing legacy to import).
 */
export async function importConversationFromLegacy(
  conversationId: string,
  deps: LegacyImportDeps,
): Promise<{ imported: boolean }> {
  const existing = await deps.executor
    .db()
    .select({ seq: juniorConversationEvents.seq })
    .from(juniorConversationEvents)
    .where(eq(juniorConversationEvents.conversationId, conversationId))
    .limit(1);
  if (existing.length > 0) {
    return { imported: false };
  }

  const entries = deps.sessionLogStore
    ? await deps.sessionLogStore.read({ conversationId })
    : await readSessionLogEntries({ conversationId });
  const snapshot = deps.loadVisibleMessages
    ? {
        compactions: deps.legacyCompactions ?? [],
        messages: await deps.loadVisibleMessages(conversationId),
      }
    : await loadThreadStateSnapshot(conversationId);
  const { compactedMessageCount, compactions, messages: visible } = snapshot;

  if (
    entries.length === 0 &&
    visible.length === 0 &&
    compactions.length === 0
  ) {
    return { imported: false };
  }

  const hasAdvisor = entries.some((entry) => entry.type === "subagent_started");
  const advisorMessages = hasAdvisor
    ? await (
        deps.advisorSessionStore ?? createLegacyAdvisorSessionReader()
      ).load(conversationId)
    : [];
  const intrinsic = intrinsicTimestamps(entries, visible, compactions);
  for (const message of advisorMessages) {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "number") {
      intrinsic.push(timestamp);
    }
  }
  const fallbackCreatedAtMs =
    deps.conversationRecord?.createdAtMs ??
    (intrinsic.length > 0 ? Math.min(...intrinsic) : undefined) ??
    0;
  const lastActivityAtMs = Math.max(
    fallbackCreatedAtMs,
    deps.conversationRecord?.lastActivityAtMs ?? 0,
    deps.legacyLastActivityAtMs ?? 0,
    intrinsic.length > 0 ? Math.max(...intrinsic) : 0,
  );

  const converted = convertLegacySessionLog({
    conversationId,
    entries,
    fallbackCreatedAtMs,
    modelId: deps.modelId,
  });
  if (compactions.length > 0) {
    const storedCount = compactions.reduce(
      (count, compaction) => count + compaction.coveredMessageIds.length,
      0,
    );
    const statsCount =
      typeof compactedMessageCount === "number" &&
      Number.isFinite(compactedMessageCount) &&
      compactedMessageCount > 0
        ? Math.floor(compactedMessageCount)
        : 0;
    const totalCount = Math.max(storedCount, statsCount);
    const compacted = compactions.map((compaction, index) => ({
      id: compaction.id,
      summary: compaction.summary,
      createdAtMs: compaction.createdAtMs,
      coveredMessageCount:
        compaction.coveredMessageIds.length +
        (index === 0 ? totalCount - storedCount : 0),
    }));
    converted.events.push({
      seq: converted.events.length,
      historyVersion: converted.events.at(-1)?.historyVersion ?? 0,
      data: {
        type: "messages_summarized",
        historyFromSeq: 0,
        compactions: compacted,
      },
      createdAtMs: compactions.at(-1)?.createdAtMs ?? fallbackCreatedAtMs,
    });
  }

  let child:
    | {
        conversationId: string;
        events: ReturnType<typeof convertAdvisorMessages>;
      }
    | undefined;
  if (converted.advisorChildConversationId) {
    child = {
      conversationId: converted.advisorChildConversationId,
      events: convertAdvisorMessages(advisorMessages, fallbackCreatedAtMs),
    };
  }

  const messages = visible.map((message) => ({
    ...toImportedMessage(message),
    ...(message.meta?.replied ? { repliedAtMs: message.createdAtMs } : {}),
  }));

  // The import uses one locked SQL transaction so retention cannot purge
  // between the legacy-source check and the canonical event write.
  const imported = await writeLegacyImport(deps.executor, {
    conversationId,
    fallbackCreatedAtMs,
    lastActivityAtMs,
    ...(messages.length > 0 ? { messages } : {}),
    events: converted.events,
    ...(child ? { child } : {}),
  });

  return { imported };
}
