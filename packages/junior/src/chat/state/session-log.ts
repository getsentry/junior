/**
 * Conversation-scoped Pi session log.
 *
 * This append-only log is the durable source for reusable Pi history across
 * turns. Projection resets mark internal session boundaries after compaction;
 * readers normally load the current projection so older sessions do not make
 * active context grow without bound.
 */
import { isDeepStrictEqual } from "node:util";
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import { z } from "zod";
import { getChatConfig } from "@/chat/config";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";
import { storedSlackActorSchema, type StoredSlackActor } from "@/chat/actor";
import {
  getConnectedStateContext,
  getStateAdapter,
} from "@/chat/state/adapter";

const AGENT_SESSION_LOG_PREFIX = "junior:agent-session-log";
const AGENT_SESSION_LOG_SCHEMA_VERSION = 1;
const INITIAL_SESSION_ID = "session_0";
const SESSION_ID_PREFIX = "session_";
const STATE_STORE_LOCK_TTL_MS = 5_000;

const piMessageEntrySchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_LOG_SCHEMA_VERSION),
  type: z.literal("pi_message"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  message: piMessageSchema,
  actor: storedSlackActorSchema.optional(),
});

const projectionResetEntrySchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_LOG_SCHEMA_VERSION),
  type: z.literal("projection_reset"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  messages: z.array(piMessageSchema),
  actor: storedSlackActorSchema.optional(),
});

const actorRecordedEntrySchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_LOG_SCHEMA_VERSION),
  type: z.literal("actor_recorded"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  actor: storedSlackActorSchema,
});

const mcpProviderConnectedEntrySchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_LOG_SCHEMA_VERSION),
  type: z.literal("mcp_provider_connected"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  provider: z.string().min(1),
});

const authorizationKindSchema = z.union([
  z.literal("plugin"),
  z.literal("mcp"),
]);

const authorizationRequestedEntrySchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_LOG_SCHEMA_VERSION),
  type: z.literal("authorization_requested"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  createdAtMs: z.number().int().nonnegative(),
  kind: authorizationKindSchema,
  provider: z.string().min(1),
  actorId: z.string().min(1),
  authorizationId: z.string().min(1),
  delivery: z.union([
    z.literal("private_link_sent"),
    z.literal("private_link_reused"),
  ]),
});

const authorizationCompletedEntrySchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_LOG_SCHEMA_VERSION),
  type: z.literal("authorization_completed"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  createdAtMs: z.number().int().nonnegative(),
  kind: authorizationKindSchema,
  provider: z.string().min(1),
  actorId: z.string().min(1),
  authorizationId: z.string().min(1),
});

const transcriptRefSchema = z.object({
  type: z.literal("advisor_session"),
  parentConversationId: z.string().min(1),
  key: z.string().min(1),
});

const toolExecutionStartedEntrySchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_LOG_SCHEMA_VERSION),
  type: z.literal("tool_execution_started"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  createdAtMs: z.number().int().nonnegative(),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.unknown().optional(),
});

const subagentStartedEntrySchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_LOG_SCHEMA_VERSION),
  type: z.literal("subagent_started"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  subagentInvocationId: z.string().min(1),
  subagentKind: z.string().min(1),
  parentToolCallId: z.string().min(1).optional(),
  parentConversationId: z.string().min(1),
  parentSessionId: z.string().min(1).optional(),
  transcriptRef: transcriptRefSchema,
  historyMode: z.literal("shared"),
  createdAtMs: z.number().int().nonnegative(),
});

const subagentEndedEntrySchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_LOG_SCHEMA_VERSION),
  type: z.literal("subagent_ended"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  subagentInvocationId: z.string().min(1),
  outcome: z.union([
    z.literal("success"),
    z.literal("error"),
    z.literal("aborted"),
  ]),
  errorCode: z.string().min(1).optional(),
  transcriptEndMessageIndex: z.number().int().nonnegative().optional(),
  transcriptStartMessageIndex: z.number().int().nonnegative().optional(),
  createdAtMs: z.number().int().nonnegative(),
});

const sessionLogEntrySchema = z.discriminatedUnion("type", [
  piMessageEntrySchema,
  projectionResetEntrySchema,
  actorRecordedEntrySchema,
  mcpProviderConnectedEntrySchema,
  authorizationRequestedEntrySchema,
  authorizationCompletedEntrySchema,
  toolExecutionStartedEntrySchema,
  subagentStartedEntrySchema,
  subagentEndedEntrySchema,
]);

/** Actor identity stored with turn-start messages for durable continuation. */
export type SessionLogEntry = z.infer<typeof sessionLogEntrySchema>;
export type AuthorizationKind = z.infer<typeof authorizationKindSchema>;
export type TranscriptRef = z.infer<typeof transcriptRefSchema>;
export type SessionActivityEntry =
  | Extract<SessionLogEntry, { type: "tool_execution_started" }>
  | Extract<SessionLogEntry, { type: "subagent_started" }>
  | Extract<SessionLogEntry, { type: "subagent_ended" }>;

interface Scope {
  conversationId: string;
}

interface AppendArgs {
  entries: SessionLogEntry[];
  scope: Scope;
  ttlMs: number;
}

export interface SessionLogStore {
  append(args: AppendArgs): Promise<void>;
  read(scope: Scope): Promise<SessionLogEntry[]>;
}

function key(scope: Scope): string {
  const prefix = getChatConfig().state.keyPrefix;
  return [
    ...(prefix ? [prefix] : []),
    AGENT_SESSION_LOG_PREFIX,
    scope.conversationId,
  ].join(":");
}

function rawKey(scope: Scope): string {
  return [AGENT_SESSION_LOG_PREFIX, scope.conversationId].join(":");
}

function storedRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function migrateStoredEntry(value: unknown): unknown {
  const record = storedRecord(value);
  if (!record) {
    return value;
  }

  const migrated = { ...record };
  // TODO(v0.91.0): Remove legacy requester session-log entry migration.
  if ("requester" in migrated && !("actor" in migrated)) {
    migrated.actor = migrated.requester;
  }
  delete migrated.requester;

  if (migrated.type === "requester_recorded") {
    migrated.type = "actor_recorded";
  }
  if ("requesterId" in migrated && !("actorId" in migrated)) {
    migrated.actorId = migrated.requesterId;
  }
  delete migrated.requesterId;

  return migrated;
}

function normalizeMessageCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function countMatchingPrefix(left: PiMessage[], right: PiMessage[]): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (!isDeepStrictEqual(left[index], right[index])) {
      return index;
    }
  }
  return limit;
}

function entrySessionId(entry: SessionLogEntry): string {
  return entry.sessionId ?? INITIAL_SESSION_ID;
}

function isActivityEntry(
  entry: SessionLogEntry,
): entry is SessionActivityEntry {
  return (
    entry.type === "tool_execution_started" ||
    entry.type === "subagent_started" ||
    entry.type === "subagent_ended"
  );
}

function latestProjectionResetIndex(entries: SessionLogEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "projection_reset") {
      return index;
    }
  }
  return -1;
}

/** Return the active projection session that new entries should join. */
function currentSessionId(entries: SessionLogEntry[]): string {
  const resetIndex = latestProjectionResetIndex(entries);
  if (resetIndex < 0) {
    return INITIAL_SESSION_ID;
  }
  return entrySessionId(entries[resetIndex]!);
}

/** Allocate the next projection session after a reset changes visible history. */
function nextSessionId(entries: SessionLogEntry[]): string {
  const resetCount = entries.filter(
    (entry) => entry.type === "projection_reset",
  ).length;
  return `${SESSION_ID_PREFIX}${resetCount + 1}`;
}

/**
 * Select the visible log segment for a session. Without an explicit session,
 * readers see only the latest projection reset and entries after it.
 */
function projectionEntries(
  entries: SessionLogEntry[],
  sessionId?: string,
): SessionLogEntry[] {
  if (sessionId) {
    const sessionEntries: SessionLogEntry[] = [];
    let started = false;
    for (const entry of entries) {
      const entryId = entrySessionId(entry);
      if (!started) {
        if (entryId !== sessionId) {
          continue;
        }
        started = true;
      } else if (entry.type === "projection_reset" && entryId !== sessionId) {
        break;
      }
      if (entryId === sessionId) {
        sessionEntries.push(entry);
      }
    }
    return sessionEntries;
  }

  const resetIndex = latestProjectionResetIndex(entries);
  const startIndex = resetIndex < 0 ? 0 : resetIndex;
  const currentId =
    resetIndex < 0 ? INITIAL_SESSION_ID : entrySessionId(entries[resetIndex]!);

  return entries
    .slice(startIndex)
    .filter((entry) => entrySessionId(entry) === currentId);
}

function findLastIndex<T>(
  values: T[],
  predicate: (value: T) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index;
  }
  return -1;
}

function piEntry(
  message: PiMessage,
  sessionId: string,
  actor?: StoredSlackActor,
): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "pi_message",
    sessionId,
    message,
    ...(actor ? { actor } : {}),
  };
}

function resetEntry(
  messages: PiMessage[],
  sessionId: string,
  actor?: StoredSlackActor,
): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "projection_reset",
    sessionId,
    messages,
    ...(actor ? { actor } : {}),
  };
}

function actorRecordedEntry(
  actor: StoredSlackActor,
  sessionId: string,
): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "actor_recorded",
    sessionId,
    actor,
  };
}

function mcpProviderConnectedEntry(
  provider: string,
  sessionId: string,
): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "mcp_provider_connected",
    sessionId,
    provider,
  };
}

function authorizationObservationMessage(entry: {
  createdAtMs: number;
  kind: AuthorizationKind;
  provider: string;
}): PiMessage {
  const label = entry.kind === "mcp" ? "MCP authorization" : "Authorization";
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${label} completed for provider "${entry.provider}". Continue the blocked request and retry the provider operation if needed.`,
      },
    ],
    timestamp: entry.createdAtMs,
  } as PiMessage;
}

function authorizationRequestedEntry(args: {
  createdAtMs: number;
  kind: AuthorizationKind;
  sessionId: string;
  provider: string;
  actorId: string;
  authorizationId: string;
  delivery: "private_link_sent" | "private_link_reused";
}): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "authorization_requested",
    sessionId: args.sessionId,
    createdAtMs: args.createdAtMs,
    kind: args.kind,
    provider: args.provider,
    actorId: args.actorId,
    authorizationId: args.authorizationId,
    delivery: args.delivery,
  };
}

function authorizationCompletedEntry(args: {
  createdAtMs: number;
  kind: AuthorizationKind;
  sessionId: string;
  provider: string;
  actorId: string;
  authorizationId: string;
}): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "authorization_completed",
    sessionId: args.sessionId,
    createdAtMs: args.createdAtMs,
    kind: args.kind,
    provider: args.provider,
    actorId: args.actorId,
    authorizationId: args.authorizationId,
  };
}

function toolExecutionStartedEntry(args: {
  args?: unknown;
  createdAtMs: number;
  sessionId: string;
  toolCallId: string;
  toolName: string;
}): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "tool_execution_started",
    sessionId: args.sessionId,
    createdAtMs: args.createdAtMs,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    ...(args.args !== undefined ? { args: args.args } : {}),
  };
}

function subagentStartedEntry(args: {
  createdAtMs: number;
  historyMode: "shared";
  parentConversationId: string;
  parentSessionId?: string;
  parentToolCallId?: string;
  sessionId: string;
  subagentInvocationId: string;
  subagentKind: string;
  transcriptRef: TranscriptRef;
}): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "subagent_started",
    sessionId: args.sessionId,
    subagentInvocationId: args.subagentInvocationId,
    subagentKind: args.subagentKind,
    ...(args.parentToolCallId
      ? { parentToolCallId: args.parentToolCallId }
      : {}),
    parentConversationId: args.parentConversationId,
    ...(args.parentSessionId ? { parentSessionId: args.parentSessionId } : {}),
    transcriptRef: args.transcriptRef,
    historyMode: args.historyMode,
    createdAtMs: args.createdAtMs,
  };
}

function subagentEndedEntry(args: {
  createdAtMs: number;
  errorCode?: string;
  outcome: "success" | "error" | "aborted";
  sessionId: string;
  subagentInvocationId: string;
  transcriptEndMessageIndex?: number;
  transcriptStartMessageIndex?: number;
}): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "subagent_ended",
    sessionId: args.sessionId,
    subagentInvocationId: args.subagentInvocationId,
    outcome: args.outcome,
    ...(args.errorCode ? { errorCode: args.errorCode } : {}),
    ...(args.transcriptEndMessageIndex !== undefined
      ? { transcriptEndMessageIndex: args.transcriptEndMessageIndex }
      : {}),
    ...(args.transcriptStartMessageIndex !== undefined
      ? { transcriptStartMessageIndex: args.transcriptStartMessageIndex }
      : {}),
    createdAtMs: args.createdAtMs,
  };
}

function decode(value: unknown): SessionLogEntry {
  if (typeof value === "string") {
    return decode(JSON.parse(value) as unknown);
  }

  const parsed = sessionLogEntrySchema.safeParse(migrateStoredEntry(value));
  if (parsed.success) {
    return parsed.data;
  }

  return piEntry(piMessageSchema.parse(value), INITIAL_SESSION_ID);
}

export interface SessionProjection {
  messages: PiMessage[];
  actor?: StoredSlackActor;
}

/**
 * Materialize Pi messages and actor identity from log entries.
 *
 * Actor is taken from the latest actor-bearing user pi_message,
 * actor_recorded event, or projection_reset event.
 */
function project(
  entries: SessionLogEntry[],
  sessionId?: string,
): SessionProjection {
  let messages: PiMessage[] = [];
  let actor: StoredSlackActor | undefined;
  for (const entry of projectionEntries(entries, sessionId)) {
    if (entry.type === "pi_message") {
      messages.push(entry.message);
      if (entry.message.role === "user" && entry.actor) {
        actor = entry.actor;
      }
      continue;
    }
    if (entry.type === "actor_recorded") {
      actor = entry.actor;
      continue;
    }
    if (entry.type === "authorization_completed") {
      messages.push(authorizationObservationMessage(entry));
      continue;
    }
    if (entry.type === "projection_reset") {
      messages = [...entry.messages];
      if (entry.actor) {
        actor = entry.actor;
      }
      continue;
    }
  }
  return { messages, actor };
}

function projectMessages(
  entries: SessionLogEntry[],
  sessionId?: string,
): PiMessage[] {
  return project(entries, sessionId).messages;
}

function connectedMcpProviders(
  entries: SessionLogEntry[],
  sessionId?: string,
): string[] {
  const providers = new Set<string>();
  for (const entry of projectionEntries(entries, sessionId)) {
    if (entry.type === "mcp_provider_connected") {
      providers.add(entry.provider);
    }
  }
  return [...providers].sort((left, right) => left.localeCompare(right));
}

/**
 * Commit by appending when history advanced normally, or by writing an explicit
 * projection reset when the runtime intentionally replaces visible history.
 */
function commitEntries(
  existingMessages: PiMessage[],
  nextMessages: PiMessage[],
  sessionId: string,
  entries: SessionLogEntry[],
  existingActor?: StoredSlackActor,
  actor?: StoredSlackActor,
): { entries: SessionLogEntry[]; sessionId: string } {
  const matchingPrefix = countMatchingPrefix(existingMessages, nextMessages);
  if (matchingPrefix === existingMessages.length) {
    const newMessages = nextMessages.slice(matchingPrefix);
    if (
      newMessages.length === 0 &&
      actor &&
      !isDeepStrictEqual(existingActor, actor)
    ) {
      return {
        entries: [actorRecordedEntry(actor, sessionId)],
        sessionId,
      };
    }
    // Attach actor to the last new user message — the current turn's
    // input. Using last rather than first avoids tagging older context
    // messages that may be included at the head of a fresh commit.
    const actorIndex = actor
      ? findLastIndex(newMessages, (m) => m.role === "user")
      : -1;
    return {
      entries: newMessages.map((message, index) =>
        piEntry(message, sessionId, index === actorIndex ? actor : undefined),
      ),
      sessionId,
    };
  }
  const resetSessionId = nextSessionId(entries);
  return {
    entries: [resetEntry(nextMessages, resetSessionId, actor ?? existingActor)],
    sessionId: resetSessionId,
  };
}

function redisStore(redisStateAdapter: RedisStateAdapter): SessionLogStore {
  const client = redisStateAdapter.getClient();

  return {
    async append({ entries, scope, ttlMs }) {
      const listKey = key(scope);
      if (entries.length > 0) {
        await client.rPush(
          listKey,
          entries.map((entry) => JSON.stringify(entry)),
        );
      }
      await client.pExpire(listKey, Math.max(1, ttlMs));
    },
    async read(scope) {
      const values = await client.lRange(key(scope), 0, -1);
      return values.map(decode);
    },
  };
}

function stateStore(): SessionLogStore {
  const stateAdapter = getStateAdapter();

  return {
    async append({ entries, scope, ttlMs }) {
      const listKey = rawKey(scope);
      const lock = await stateAdapter.acquireLock(
        `${listKey}:commit`,
        STATE_STORE_LOCK_TTL_MS,
      );
      if (!lock) {
        throw new Error("Could not acquire session log commit lock");
      }
      try {
        const existingValue = await stateAdapter.get(listKey);
        const existingEntries = Array.isArray(existingValue)
          ? existingValue.map(decode)
          : (await stateAdapter.getList(listKey)).map(decode);
        await stateAdapter.set(
          listKey,
          [...existingEntries, ...entries],
          Math.max(1, ttlMs),
        );
      } finally {
        await stateAdapter.releaseLock(lock);
      }
    },
    async read(scope) {
      const listKey = rawKey(scope);
      const value = await stateAdapter.get(listKey);
      if (Array.isArray(value)) {
        return value.map(decode);
      }
      const values = await stateAdapter.getList(listKey);
      return values.map(decode);
    },
  };
}

async function defaultStore(): Promise<SessionLogStore> {
  const { redisStateAdapter, stateAdapter } = await getConnectedStateContext();
  if (redisStateAdapter) {
    return redisStore(redisStateAdapter);
  }
  await stateAdapter.connect();
  return stateStore();
}

/** Read entries through the decode boundary before materializing projections. */
async function loadEntries(
  args: Scope & {
    store?: SessionLogStore;
  },
): Promise<SessionLogEntry[]> {
  const store = args.store ?? (await defaultStore());
  return (await store.read(args)).map(decode);
}

/** Load chronological host-only runtime activity entries for reporting. */
export async function loadActivityEntries(
  args: Scope & {
    store?: SessionLogStore;
    sessionId?: string;
  },
): Promise<SessionActivityEntry[]> {
  const entries = await loadEntries(args);
  return projectionEntries(entries, args.sessionId).filter(isActivityEntry);
}

/** Load the committed Pi-message projection for a conversation. */
export async function loadMessages(
  args: Scope & {
    store?: SessionLogStore;
    messageCount: number;
    sessionId?: string;
  },
): Promise<PiMessage[] | undefined> {
  const messageCount = normalizeMessageCount(args.messageCount);
  if (messageCount === 0) {
    return [];
  }

  const messages = projectMessages(await loadEntries(args), args.sessionId);
  return messages.length >= messageCount
    ? messages.slice(0, messageCount)
    : undefined;
}

/** Load the full current Pi-message projection for a conversation. */
export async function loadProjection(
  args: Scope & {
    store?: SessionLogStore;
    sessionId?: string;
  },
): Promise<PiMessage[]> {
  return project(await loadEntries(args), args.sessionId).messages;
}

/**
 * Load the Pi-message projection and derived actor identity in one read.
 * Used at continuation boundaries to avoid a second log scan.
 */
export async function loadProjectionWithActor(
  args: Scope & {
    store?: SessionLogStore;
    sessionId?: string;
  },
): Promise<SessionProjection> {
  return project(await loadEntries(args), args.sessionId);
}

/** Load MCP providers that were durably connected in this conversation. */
export async function loadConnectedMcpProviders(
  args: Scope & {
    store?: SessionLogStore;
  },
): Promise<string[]> {
  return connectedMcpProviders(await loadEntries(args));
}

/** Record a successful MCP provider connection without duplicating the fact. */
export async function recordMcpProviderConnected(
  args: Scope & {
    store?: SessionLogStore;
    provider: string;
    ttlMs: number;
  },
): Promise<void> {
  const store = args.store ?? (await defaultStore());
  const entries = await store.read(args);
  const sessionId = currentSessionId(entries);
  if (connectedMcpProviders(entries).includes(args.provider)) {
    return;
  }
  await store.append({
    scope: args,
    entries: [mcpProviderConnectedEntry(args.provider, sessionId)],
    ttlMs: args.ttlMs,
  });
}

/** Record that an OAuth/MCP authorization link was delivered or reused. */
export async function recordAuthorizationRequested(
  args: Scope & {
    store?: SessionLogStore;
    kind: AuthorizationKind;
    provider: string;
    actorId: string;
    authorizationId: string;
    delivery: "private_link_sent" | "private_link_reused";
    ttlMs: number;
  },
): Promise<void> {
  const store = args.store ?? (await defaultStore());
  const entries = await store.read(args);
  const sessionId = currentSessionId(entries);
  if (
    projectionEntries(entries).some(
      (entry) =>
        entry.type === "authorization_requested" &&
        entry.authorizationId === args.authorizationId,
    )
  ) {
    return;
  }
  await store.append({
    scope: args,
    entries: [
      authorizationRequestedEntry({
        createdAtMs: Date.now(),
        kind: args.kind,
        sessionId,
        provider: args.provider,
        actorId: args.actorId,
        authorizationId: args.authorizationId,
        delivery: args.delivery,
      }),
    ],
    ttlMs: args.ttlMs,
  });
}

/** Record completed authorization as a chronological host observation for Pi. */
export async function recordAuthorizationCompleted(
  args: Scope & {
    store?: SessionLogStore;
    kind: AuthorizationKind;
    provider: string;
    actorId: string;
    authorizationId: string;
    ttlMs: number;
  },
): Promise<void> {
  const store = args.store ?? (await defaultStore());
  const entries = await store.read(args);
  const sessionId = currentSessionId(entries);
  if (
    projectionEntries(entries).some(
      (entry) =>
        entry.type === "authorization_completed" &&
        entry.authorizationId === args.authorizationId,
    )
  ) {
    return;
  }
  await store.append({
    scope: args,
    entries: [
      authorizationCompletedEntry({
        createdAtMs: Date.now(),
        kind: args.kind,
        sessionId,
        provider: args.provider,
        actorId: args.actorId,
        authorizationId: args.authorizationId,
      }),
    ],
    ttlMs: args.ttlMs,
  });
}

/** Record a host-observed parent tool start without adding it to Pi replay. */
export async function recordToolExecutionStarted(
  args: Scope & {
    args?: unknown;
    createdAtMs?: number;
    sessionId?: string;
    store?: SessionLogStore;
    toolCallId: string;
    toolName: string;
    ttlMs: number;
  },
): Promise<void> {
  const store = args.store ?? (await defaultStore());
  const entries = await store.read(args);
  const sessionId = args.sessionId ?? currentSessionId(entries);
  await store.append({
    scope: args,
    entries: [
      toolExecutionStartedEntry({
        args: args.args,
        createdAtMs: args.createdAtMs ?? Date.now(),
        sessionId,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
      }),
    ],
    ttlMs: args.ttlMs,
  });
}

/** Record that a child agent execution became visible from this parent run. */
export async function recordSubagentStarted(
  args: Scope & {
    createdAtMs?: number;
    historyMode: "shared";
    parentConversationId: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    sessionId?: string;
    store?: SessionLogStore;
    subagentInvocationId: string;
    subagentKind: string;
    transcriptRef: TranscriptRef;
    ttlMs: number;
  },
): Promise<void> {
  const store = args.store ?? (await defaultStore());
  const entries = await store.read(args);
  const sessionId = args.sessionId ?? currentSessionId(entries);
  await store.append({
    scope: args,
    entries: [
      subagentStartedEntry({
        createdAtMs: args.createdAtMs ?? Date.now(),
        historyMode: args.historyMode,
        parentConversationId: args.parentConversationId,
        parentSessionId: args.parentSessionId,
        parentToolCallId: args.parentToolCallId,
        sessionId,
        subagentInvocationId: args.subagentInvocationId,
        subagentKind: args.subagentKind,
        transcriptRef: args.transcriptRef,
      }),
    ],
    ttlMs: args.ttlMs,
  });
}

/** Record the terminal state for a previously-started child agent execution. */
export async function recordSubagentEnded(
  args: Scope & {
    createdAtMs?: number;
    errorCode?: string;
    outcome: "success" | "error" | "aborted";
    sessionId?: string;
    store?: SessionLogStore;
    subagentInvocationId: string;
    transcriptEndMessageIndex?: number;
    transcriptStartMessageIndex?: number;
    ttlMs: number;
  },
): Promise<void> {
  const store = args.store ?? (await defaultStore());
  const entries = await store.read(args);
  const sessionId = args.sessionId ?? currentSessionId(entries);
  await store.append({
    scope: args,
    entries: [
      subagentEndedEntry({
        createdAtMs: args.createdAtMs ?? Date.now(),
        errorCode: args.errorCode,
        outcome: args.outcome,
        sessionId,
        subagentInvocationId: args.subagentInvocationId,
        transcriptEndMessageIndex: args.transcriptEndMessageIndex,
        transcriptStartMessageIndex: args.transcriptStartMessageIndex,
      }),
    ],
    ttlMs: args.ttlMs,
  });
}

/**
 * Append conversation-log entries and advance the current Pi projection.
 *
 * Normal commits append new Pi messages. If the runtime rolls back to an
 * earlier safe boundary, the log records that projection reset as an explicit
 * event instead of rewriting prior history.
 */
export async function commitMessages(
  args: Scope & {
    store?: SessionLogStore;
    messages: PiMessage[];
    ttlMs: number;
    actor?: StoredSlackActor;
  },
): Promise<{ sessionId: string }> {
  const store = args.store ?? (await defaultStore());
  const entries = await store.read(args);
  const existingProjection = project(entries);
  const currentId = currentSessionId(entries);
  const commit = commitEntries(
    existingProjection.messages,
    args.messages,
    currentId,
    entries,
    existingProjection.actor,
    args.actor,
  );
  await store.append({
    scope: args,
    entries: commit.entries,
    ttlMs: args.ttlMs,
  });
  return {
    sessionId: commit.sessionId,
  };
}
