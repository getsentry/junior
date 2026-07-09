/**
 * One-time Redis→SQL conversation import (bulk + lazy), deletion-scoped.
 *
 * A single per-conversation import unit shared by `junior upgrade` (bulk,
 * bounded newest-first) and the lazy first-read straggler path. It converts the
 * legacy session log into `junior_agent_steps`, imports the advisor session blob
 * as a child conversation, and copies the `thread-state` visible messages into
 * `junior_conversation_messages`. Import is idempotent per conversation (skip
 * when step rows already exist) and never fabricates import-time timestamps.
 *
 * This module and its lazy hook are removed wholesale after the legacy Redis TTL
 * horizon passes; keeping it separate keeps that deletion mechanical.
 */
import type { ConversationMessage as ThreadConversationMessage } from "@/chat/state/conversation";
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
import type { JuniorSqlDatabase } from "@/chat/sql/db";
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
  /** Conversation metadata record, used only for fallback `created_at`. */
  conversationRecord?: Conversation;
}

/** Read the legacy visible-message list from `thread-state:<id>`. */
async function loadThreadStateMessages(
  conversationId: string,
): Promise<ThreadConversationMessage[]> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const raw = await stateAdapter.get<Record<string, unknown>>(
    `thread-state:${conversationId}`,
  );
  if (!raw) {
    return [];
  }
  return parseLegacyVisibleMessages(raw);
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

/** Earliest intrinsic timestamp across log + messages, used when no record exists. */
function earliestIntrinsicMs(
  entries: SessionLogEntry[],
  visible: ThreadConversationMessage[],
): number | undefined {
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
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
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
  const visible = deps.loadVisibleMessages
    ? await deps.loadVisibleMessages(conversationId)
    : await loadThreadStateMessages(conversationId);

  if (entries.length === 0 && visible.length === 0) {
    return { imported: false };
  }

  const fallbackCreatedAtMs =
    deps.conversationRecord?.createdAtMs ??
    earliestIntrinsicMs(entries, visible) ??
    0;

  const converted = convertLegacySessionLog({
    conversationId,
    entries,
    fallbackCreatedAtMs,
  });

  let child:
    | {
        conversationId: string;
        steps: ReturnType<typeof convertAdvisorMessages>;
      }
    | undefined;
  if (converted.advisorChildConversationId) {
    const advisorStore =
      deps.advisorSessionStore ?? createStateAdvisorSessionStore();
    const advisorMessages = await advisorStore.load(conversationId);
    child = {
      conversationId: converted.advisorChildConversationId,
      steps: convertAdvisorMessages(advisorMessages, fallbackCreatedAtMs),
    };
  }

  // Ordering invariant: visible messages are written BEFORE the step rows,
  // because the step rows are this import's commit point — the idempotence gate
  // above keys off `loadCurrentEpoch(...).length > 0`. If steps landed first and
  // the message write then failed, every later retry would trip the gate and the
  // visible transcript would be lost forever. Recording messages first is safe on
  // retry: `record()` is idempotent via the store's natural key (`ON CONFLICT`
  // meta-merge) and `markReplied` is idempotent, so a mid-message failure simply
  // re-runs the whole sequence until the step write commits. Rows go through the
  // shared `toStoredConversationMessage` projection so imported messages carry
  // `meta.author` exactly like runtime-recorded rows; `meta.replied` becomes the
  // durable `replied_at` delivery mark.
  if (visible.length > 0) {
    await deps.messageStore.record(
      conversationId,
      visible.map(toStoredConversationMessage),
    );
    for (const message of visible) {
      if (message.meta?.replied) {
        await deps.messageStore.markReplied(
          conversationId,
          message.id,
          message.createdAtMs,
        );
      }
    }
  }

  // Commit point: writing the step rows is what makes this import idempotent, so
  // it must run last, only after every preceding write has succeeded.
  if (converted.steps.length > 0) {
    await writeLegacyImport(deps.executor, {
      conversationId,
      fallbackCreatedAtMs,
      steps: converted.steps,
      ...(child ? { child } : {}),
    });
  }

  return { imported: true };
}

/**
 * Lazy first-read import for a straggler the old deployment touched during
 * promotion. Runs under the conversation lease the worker already holds before
 * any turn/resume projection read; idempotent skip-if-rows-exist makes re-entry
 * safe. A missing or unreadable legacy source is treated as "nothing to import"
 * so a genuinely new conversation reads as empty exactly as before.
 */
export async function ensureLegacyConversationImport(args: {
  conversationId: string;
}): Promise<void> {
  const stepStore = getAgentStepStore();
  if ((await stepStore.loadCurrentEpoch(args.conversationId)).length > 0) {
    return;
  }
  // Guard only the legacy Redis reads: the source is being decommissioned, so
  // an absent or unreadable log/thread-state is normal and means "nothing to
  // import". SQL writes below stay unguarded and fail loudly per the storage
  // contract.
  let entries: SessionLogEntry[];
  let visible: ThreadConversationMessage[];
  try {
    entries = await readSessionLogEntries({
      conversationId: args.conversationId,
    });
    visible = await loadThreadStateMessages(args.conversationId);
  } catch {
    return;
  }
  if (entries.length === 0 && visible.length === 0) {
    return;
  }
  await importConversationFromLegacy(args.conversationId, {
    executor: getSqlExecutor(),
    stepStore,
    messageStore: getConversationMessageStore(),
    sessionLogStore: { read: async () => entries, append: async () => {} },
    loadVisibleMessages: async () => visible,
  });
}
