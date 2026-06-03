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
import type { PiMessage } from "@/chat/pi/messages";
import {
  getConnectedStateContext,
  getStateAdapter,
} from "@/chat/state/adapter";

const AGENT_SESSION_LOG_PREFIX = "junior:agent-session-log";
const AGENT_SESSION_LOG_SCHEMA_VERSION = 1;
const INITIAL_SESSION_ID = "session_0";
const SESSION_ID_PREFIX = "session_";

const piMessageSchema = z
  .object({
    role: z.string(),
  })
  .passthrough()
  .transform((value) => value as unknown as PiMessage);

const piMessageEntrySchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_LOG_SCHEMA_VERSION),
  type: z.literal("pi_message"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  message: piMessageSchema,
});

const projectionResetEntrySchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_LOG_SCHEMA_VERSION),
  type: z.literal("projection_reset"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  messages: z.array(piMessageSchema),
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
  requesterId: z.string().min(1),
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
  requesterId: z.string().min(1),
  authorizationId: z.string().min(1),
});

const sessionLogEntrySchema = z.discriminatedUnion("type", [
  piMessageEntrySchema,
  projectionResetEntrySchema,
  mcpProviderConnectedEntrySchema,
  authorizationRequestedEntrySchema,
  authorizationCompletedEntrySchema,
]);

export type SessionLogEntry = z.infer<typeof sessionLogEntrySchema>;
export type AuthorizationKind = z.infer<typeof authorizationKindSchema>;

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

function piEntry(message: PiMessage, sessionId: string): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "pi_message",
    sessionId,
    message,
  };
}

function resetEntry(messages: PiMessage[], sessionId: string): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "projection_reset",
    sessionId,
    messages,
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
  requesterId: string;
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
    requesterId: args.requesterId,
    authorizationId: args.authorizationId,
    delivery: args.delivery,
  };
}

function authorizationCompletedEntry(args: {
  createdAtMs: number;
  kind: AuthorizationKind;
  sessionId: string;
  provider: string;
  requesterId: string;
  authorizationId: string;
}): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "authorization_completed",
    sessionId: args.sessionId,
    createdAtMs: args.createdAtMs,
    kind: args.kind,
    provider: args.provider,
    requesterId: args.requesterId,
    authorizationId: args.authorizationId,
  };
}

function decode(value: unknown): SessionLogEntry {
  if (typeof value === "string") {
    return decode(JSON.parse(value) as unknown);
  }

  const parsed = sessionLogEntrySchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  return piEntry(piMessageSchema.parse(value), INITIAL_SESSION_ID);
}

/** Materialize Pi messages from log entries for the selected projection. */
function project(entries: SessionLogEntry[], sessionId?: string): PiMessage[] {
  let messages: PiMessage[] = [];
  for (const entry of projectionEntries(entries, sessionId)) {
    if (entry.type === "pi_message") {
      messages.push(entry.message);
      continue;
    }
    if (entry.type === "authorization_completed") {
      messages.push(authorizationObservationMessage(entry));
      continue;
    }
    if (
      entry.type === "mcp_provider_connected" ||
      entry.type === "authorization_requested"
    ) {
      continue;
    }
    messages = [...entry.messages];
  }
  return messages;
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
): SessionLogEntry[] {
  const matchingPrefix = countMatchingPrefix(existingMessages, nextMessages);
  if (matchingPrefix === existingMessages.length) {
    return nextMessages
      .slice(matchingPrefix)
      .map((message) => piEntry(message, sessionId));
  }
  return [resetEntry(nextMessages, nextSessionId(entries))];
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
      for (const entry of entries) {
        await stateAdapter.appendToList(listKey, entry, {
          ttlMs: Math.max(1, ttlMs),
        });
      }
    },
    async read(scope) {
      const values = await stateAdapter.getList(rawKey(scope));
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

async function loadEntries(
  args: Scope & {
    store?: SessionLogStore;
  },
): Promise<SessionLogEntry[]> {
  const store = args.store ?? (await defaultStore());
  return await store.read(args);
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

  const store = args.store ?? (await defaultStore());
  const messages = project(await store.read(args), args.sessionId);
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
  const store = args.store ?? (await defaultStore());
  return project(await store.read(args), args.sessionId);
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
    requesterId: string;
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
        requesterId: args.requesterId,
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
    requesterId: string;
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
        requesterId: args.requesterId,
        authorizationId: args.authorizationId,
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
  },
): Promise<{ sessionId: string }> {
  const store = args.store ?? (await defaultStore());
  const entries = await store.read(args);
  const existingMessages = project(entries);
  const currentId = currentSessionId(entries);
  const nextEntries = commitEntries(
    existingMessages,
    args.messages,
    currentId,
    entries,
  );
  await store.append({
    scope: args,
    entries: nextEntries,
    ttlMs: args.ttlMs,
  });
  return {
    sessionId:
      nextEntries.find((entry) => entry.type === "projection_reset")
        ?.sessionId ?? currentId,
  };
}
