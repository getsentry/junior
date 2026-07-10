/**
 * One-time Redis→SQL conversation import (bulk + lazy), deletion-scoped.
 *
 * A single per-conversation import unit shared by `junior upgrade` (bulk,
 * bounded newest-first) and the lazy first-read straggler path. It converts the
 * legacy session log into `junior_agent_steps`, imports the advisor session blob
 * as a child conversation, and copies the `thread-state` visible messages into
 * `junior_conversation_messages`. Import is idempotent per conversation: step
 * rows seal normal imports, while message-only imports verify their complete
 * SQL projection before skipping. It never fabricates import-time timestamps.
 *
 * This module and its lazy hook are removed wholesale after the legacy Redis TTL
 * horizon passes; keeping it separate keeps that deletion mechanical.
 */
import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import {
  coerceThreadConversationState,
  type ConversationCompaction,
  type ConversationMessage as ThreadConversationMessage,
} from "@/chat/state/conversation";
import { toStoredConversationMessage } from "@/chat/conversations/visible-messages";
import { getStateAdapter } from "@/chat/state/adapter";
import type { PiMessage } from "@/chat/pi/messages";
import {
  readSessionLogEntries,
  type SessionLogEntry,
  type SessionLogStore,
} from "@/chat/state/session-log";
import {
  createStateAdvisorSessionStore,
  type AdvisorSessionStore,
} from "@/chat/tools/advisor/session-store";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import {
  getAgentStepStore,
  getConversationMessageStore,
  getSqlExecutor,
} from "@/chat/db";
import type { AgentStepStore } from "./history";
import type { ConversationMessageStore } from "./messages";
import type { Conversation } from "./store";
import {
  convertAdvisorMessages,
  convertLegacySessionLog,
  writeLegacyImport,
} from "./sql/legacy-history-import";

/** Injectable seams; production defaults resolve the process singletons. */
export interface LegacyImportDeps {
  executor: JuniorSqlDatabase;
  stepStore: AgentStepStore;
  messageStore: ConversationMessageStore;
  sessionLogStore?: SessionLogStore;
  advisorSessionStore?: AdvisorSessionStore;
  loadVisibleMessages?: (
    conversationId: string,
  ) => Promise<ThreadConversationMessage[]>;
  legacyCompactions?: ConversationCompaction[];
  /** Conversation metadata used for imported creation and activity clocks. */
  conversationRecord?: Conversation;
  /** Latest activity recovered from the legacy thread-state payload. */
  legacyLastActivityAtMs?: number;
}

/** Read legacy transcript data from `thread-state:<id>`. */
async function loadThreadStateSnapshot(conversationId: string): Promise<{
  compactions: ConversationCompaction[];
  messages: ThreadConversationMessage[];
  lastActivityAtMs?: number;
}> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const raw = await stateAdapter.get<Record<string, unknown>>(
    `thread-state:${conversationId}`,
  );
  if (!raw) {
    return { compactions: [], messages: [] };
  }
  const conversation = raw.conversation;
  const stats =
    conversation && typeof conversation === "object"
      ? (conversation as { stats?: unknown }).stats
      : undefined;
  const updatedAtMs =
    stats && typeof stats === "object"
      ? (stats as { updatedAtMs?: unknown }).updatedAtMs
      : undefined;
  return {
    compactions: coerceThreadConversationState(raw).compactions,
    messages: parseLegacyVisibleMessages(raw),
    ...(typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs)
      ? { lastActivityAtMs: updatedAtMs }
      : {}),
  };
}

const LEGACY_MESSAGE_ROLES = new Set(["user", "assistant", "system"]);

/**
 * Parse the legacy persisted visible-message list. The live thread-state
 * contract no longer reads or writes `conversation.messages`
 * (`coerceThreadConversationState` ignores it), so only pre-cutover Redis
 * payloads carry it; this parser exists solely for the one-time import.
 */
function parseLegacyVisibleMessages(
  raw: Record<string, unknown>,
): ThreadConversationMessage[] {
  const conversation = raw.conversation;
  if (!conversation || typeof conversation !== "object") {
    return [];
  }
  const list = (conversation as { messages?: unknown }).messages;
  if (!Array.isArray(list)) {
    return [];
  }
  const messages: ThreadConversationMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.text !== "string" ||
      typeof candidate.role !== "string" ||
      !LEGACY_MESSAGE_ROLES.has(candidate.role) ||
      typeof candidate.createdAtMs !== "number" ||
      !Number.isFinite(candidate.createdAtMs)
    ) {
      continue;
    }
    messages.push({
      id: candidate.id,
      role: candidate.role as ThreadConversationMessage["role"],
      text: candidate.text,
      createdAtMs: candidate.createdAtMs,
      ...(candidate.author && typeof candidate.author === "object"
        ? { author: candidate.author as ThreadConversationMessage["author"] }
        : {}),
      ...(candidate.meta && typeof candidate.meta === "object"
        ? { meta: candidate.meta as ThreadConversationMessage["meta"] }
        : {}),
    });
  }
  return messages;
}

function intrinsicTimestamps(
  entries: SessionLogEntry[],
  visible: ThreadConversationMessage[],
  compactions: ConversationCompaction[],
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
 * Returns whether an import ran (false when step rows already exist or there is
 * nothing legacy to import).
 */
export async function importConversationFromLegacy(
  conversationId: string,
  deps: LegacyImportDeps,
): Promise<{ imported: boolean }> {
  const existing = await deps.stepStore.loadCurrentEpoch(conversationId);
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
  const { compactions, messages: visible } = snapshot;

  if (
    entries.length === 0 &&
    visible.length === 0 &&
    compactions.length === 0
  ) {
    return { imported: false };
  }

  const hasAdvisor = entries.some((entry) => entry.type === "subagent_started");
  const advisorMessages = hasAdvisor
    ? await (deps.advisorSessionStore ?? createStateAdvisorSessionStore()).load(
        conversationId,
      )
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
  });
  if (compactions.length > 0) {
    converted.steps.push({
      seq: converted.steps.length,
      contextEpoch: converted.steps.at(-1)?.contextEpoch ?? 0,
      entry: { type: "visible_context_compacted", compactions },
      createdAtMs: compactions.at(-1)?.createdAtMs ?? fallbackCreatedAtMs,
    });
  }

  if (converted.steps.length === 0 && visible.length > 0) {
    const existingMessages = new Map(
      (await deps.messageStore.list(conversationId)).map((message) => [
        message.messageId,
        message,
      ]),
    );
    const fullyImported = visible.every((message) => {
      const existingMessage = existingMessages.get(message.id);
      const projected = toStoredConversationMessage(message);
      return (
        existingMessage !== undefined &&
        Object.entries(projected.meta ?? {}).every(([key, value]) =>
          isDeepStrictEqual(existingMessage.meta?.[key], value),
        ) &&
        (message.meta?.replied !== true ||
          existingMessage.repliedAtMs !== undefined)
      );
    });
    if (fullyImported) {
      await writeLegacyImport(deps.executor, {
        conversationId,
        fallbackCreatedAtMs,
        lastActivityAtMs,
        steps: [],
      });
      return { imported: false };
    }
  }

  let child:
    | {
        conversationId: string;
        steps: ReturnType<typeof convertAdvisorMessages>;
      }
    | undefined;
  if (converted.advisorChildConversationId) {
    child = {
      conversationId: converted.advisorChildConversationId,
      steps: convertAdvisorMessages(advisorMessages, fallbackCreatedAtMs),
    };
  }

  const messages = visible.map((message) => ({
    ...toStoredConversationMessage(message),
    ...(message.meta?.replied ? { repliedAtMs: message.createdAtMs } : {}),
  }));

  // Messages and steps share one locked SQL transaction so retention can never
  // purge between the legacy-source check and the import commit.
  const imported = await writeLegacyImport(deps.executor, {
    conversationId,
    fallbackCreatedAtMs,
    lastActivityAtMs,
    ...(messages.length > 0 ? { messages } : {}),
    steps: converted.steps,
    ...(child ? { child } : {}),
  });

  return { imported };
}

/**
 * Lazy first-read import for a straggler the old deployment touched during
 * promotion. Runs under the conversation lease the worker already holds before
 * any turn/resume projection read; idempotent skip-if-rows-exist makes re-entry
 * safe. Missing legacy keys produce empty reads for genuinely new conversations;
 * actual Redis read failures surface through normal worker recovery.
 */
export async function ensureLegacyConversationImport(args: {
  conversationId: string;
}): Promise<void> {
  const stepStore = getAgentStepStore();
  if ((await stepStore.loadCurrentEpoch(args.conversationId)).length > 0) {
    return;
  }
  const entries = await readSessionLogEntries({
    conversationId: args.conversationId,
  });
  const snapshot = await loadThreadStateSnapshot(args.conversationId);
  const visible = snapshot.messages;
  if (
    entries.length === 0 &&
    visible.length === 0 &&
    snapshot.compactions.length === 0
  ) {
    return;
  }
  const executor = getSqlExecutor();
  const purged = await executor
    .db()
    .select({ transcriptPurgedAt: juniorConversations.transcriptPurgedAt })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, args.conversationId));
  if (purged[0]?.transcriptPurgedAt) {
    return;
  }
  await importConversationFromLegacy(args.conversationId, {
    executor,
    stepStore,
    messageStore: getConversationMessageStore(),
    sessionLogStore: { read: async () => entries, append: async () => {} },
    loadVisibleMessages: async () => visible,
    legacyCompactions: snapshot.compactions,
    ...(snapshot.lastActivityAtMs === undefined
      ? {}
      : { legacyLastActivityAtMs: snapshot.lastActivityAtMs }),
  });
}
