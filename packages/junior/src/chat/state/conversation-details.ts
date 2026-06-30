/**
 * Conversation-level display and context state.
 *
 * Intentionally separate from:
 * - turn-session records (per-turn execution/resume/telemetry state)
 * - thread state (runtime blob that includes full message history)
 *
 * Two independent keys, each written by a single owner:
 *
 *   junior:conversation:{id}:context   — written once at turn start via
 *     setIfNotExists; owns channelName, originSurface, originRequester,
 *     startedAtMs. Subsequent turns refresh the TTL without changing the
 *     original context.
 *
 *   junior:conversation:{id}:title     — written when title generation
 *     completes and refreshed from existing title artifacts; owns displayTitle
 *     and titleSourceMessageId.
 *
 * Because each key has exactly one writer and writes are atomic ops, no lock
 * is needed.
 */
import { THREAD_STATE_TTL_MS } from "chat";
import { isRecord, toOptionalNumber } from "@/chat/coerce";
import {
  parseStoredSlackRequester,
  type StoredSlackRequester,
} from "@/chat/requester";
import { getStateAdapter } from "./adapter";
import type { AgentTurnSurface } from "./turn-session";

const CONVERSATION_PREFIX = "junior:conversation";
const CONVERSATION_DETAILS_TTL_MS = THREAD_STATE_TTL_MS;

function conversationContextKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}:${conversationId}:context`;
}

function conversationTitleKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}:${conversationId}:title`;
}

// ---------------------------------------------------------------------------
// Public record type (assembled view from both keys)
// ---------------------------------------------------------------------------

export interface ConversationDetailsRecord {
  conversationId: string;
  /** Generated display title from the LLM. Absent until title has been produced. */
  displayTitle?: string;
  /** The message id used as input when generating the title. */
  titleSourceMessageId?: string;
  /** Slack channel name or equivalent location label. */
  channelName?: string;
  /** Surface on which the conversation was started. */
  originSurface?: AgentTurnSurface;
  /** Requester who initiated the conversation (first turn). */
  originRequester?: StoredSlackRequester;
  /** Timestamp of the first turn in the conversation. */
  startedAtMs?: number;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseOriginRequester(
  value: unknown,
): StoredSlackRequester | undefined {
  return parseStoredSlackRequester(value);
}

function parseOriginSurface(value: unknown): AgentTurnSurface | undefined {
  if (
    value === "slack" ||
    value === "api" ||
    value === "scheduler" ||
    value === "internal"
  ) {
    return value;
  }
  return undefined;
}

interface StoredContext {
  channelName?: string;
  originSurface?: AgentTurnSurface;
  originRequester?: StoredSlackRequester;
  startedAtMs: number;
}

function storedContextFromInput(context: {
  channelName?: string;
  originSurface?: AgentTurnSurface;
  originRequester?: StoredSlackRequester;
  startedAtMs: number;
}): StoredContext {
  return {
    ...(context.channelName ? { channelName: context.channelName } : {}),
    ...(context.originSurface ? { originSurface: context.originSurface } : {}),
    ...(context.originRequester
      ? { originRequester: context.originRequester }
      : {}),
    startedAtMs: context.startedAtMs,
  };
}

function parseContext(value: unknown): StoredContext | undefined {
  if (!isRecord(value)) return undefined;
  const startedAtMs = toOptionalNumber(value.startedAtMs);
  if (startedAtMs === undefined) return undefined;
  return {
    ...(typeof value.channelName === "string" && value.channelName.trim()
      ? { channelName: value.channelName.trim() }
      : {}),
    ...(parseOriginSurface(value.originSurface)
      ? { originSurface: parseOriginSurface(value.originSurface) }
      : {}),
    ...(parseOriginRequester(value.originRequester)
      ? { originRequester: parseOriginRequester(value.originRequester) }
      : {}),
    startedAtMs,
  };
}

interface StoredTitle {
  displayTitle: string;
  titleSourceMessageId?: string;
}

function parseTitle(value: unknown): StoredTitle | undefined {
  if (!isRecord(value)) return undefined;
  const displayTitle =
    typeof value.displayTitle === "string" && value.displayTitle.trim()
      ? value.displayTitle.trim()
      : undefined;
  if (!displayTitle) return undefined;
  return {
    displayTitle,
    ...(typeof value.titleSourceMessageId === "string"
      ? { titleSourceMessageId: value.titleSourceMessageId }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Record the origin context for a conversation the first time it is seen and
 * refresh the context TTL on later turns without changing the stored origin.
 */
export async function initConversationContext(
  conversationId: string,
  context: {
    channelName?: string;
    originSurface?: AgentTurnSurface;
    originRequester?: StoredSlackRequester;
    startedAtMs: number;
  },
): Promise<void> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const key = conversationContextKey(conversationId);
  const inserted = await stateAdapter.setIfNotExists(
    key,
    storedContextFromInput(context),
    CONVERSATION_DETAILS_TTL_MS,
  );
  if (inserted) return;

  const existing = parseContext(await stateAdapter.get<unknown>(key));
  if (!existing) {
    // Do not invent origin context from a later turn if the original record is
    // malformed. Let the bad record expire with the transcript TTL.
    return;
  }
  await stateAdapter.set(key, existing, CONVERSATION_DETAILS_TTL_MS);
}

/**
 * Persist or refresh the LLM-generated title for a conversation.
 *
 * Plain set — no read, no lock.
 */
export async function setConversationTitle(
  conversationId: string,
  title: { displayTitle: string; titleSourceMessageId?: string },
): Promise<void> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  await stateAdapter.set(
    conversationTitleKey(conversationId),
    {
      displayTitle: title.displayTitle,
      ...(title.titleSourceMessageId
        ? { titleSourceMessageId: title.titleSourceMessageId }
        : {}),
    },
    CONVERSATION_DETAILS_TTL_MS,
  );
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/**
 * Read conversation details for a single conversation.
 * Assembles the context and title records in parallel.
 * Returns undefined only when neither context nor title details exist yet.
 */
export async function getConversationDetails(
  conversationId: string,
): Promise<ConversationDetailsRecord | undefined> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const [rawContext, rawTitle] = await Promise.all([
    stateAdapter.get<unknown>(conversationContextKey(conversationId)),
    stateAdapter.get<unknown>(conversationTitleKey(conversationId)),
  ]);
  const context = parseContext(rawContext);
  const title = parseTitle(rawTitle);
  if (!context && !title) return undefined;
  return {
    conversationId,
    ...(title?.displayTitle ? { displayTitle: title.displayTitle } : {}),
    ...(title?.titleSourceMessageId
      ? { titleSourceMessageId: title.titleSourceMessageId }
      : {}),
    ...(context?.channelName ? { channelName: context.channelName } : {}),
    ...(context?.originSurface ? { originSurface: context.originSurface } : {}),
    ...(context?.originRequester
      ? { originRequester: context.originRequester }
      : {}),
    ...(context?.startedAtMs !== undefined
      ? { startedAtMs: context.startedAtMs }
      : {}),
  };
}

/**
 * Bulk-fetch conversation details for a set of conversation ids in parallel.
 * Returns a map from conversationId → record (omits ids with no details).
 */
export async function getConversationDetailsForIds(
  conversationIds: Iterable<string>,
): Promise<Map<string, ConversationDetailsRecord>> {
  const uniqueIds = [...new Set(conversationIds)].filter(Boolean);
  const entries = await Promise.all(
    uniqueIds.map(async (id) => {
      const details = await getConversationDetails(id);
      return details ? ([id, details] as const) : undefined;
    }),
  );
  const result = new Map<string, ConversationDetailsRecord>();
  for (const entry of entries) {
    if (entry) result.set(entry[0], entry[1]);
  }
  return result;
}
