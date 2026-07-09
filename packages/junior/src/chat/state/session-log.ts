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
import { actorSchema, type Actor } from "@sentry/junior-plugin-api";
import { getChatConfig } from "@/chat/config";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";
import { storedSlackActorSchema, type StoredSlackActor } from "@/chat/actor";
import {
  getConnectedStateContext,
  getStateAdapter,
} from "@/chat/state/adapter";

const AGENT_SESSION_LOG_PREFIX = "junior:agent-session-log";
const AGENT_SESSION_LOG_SCHEMA_VERSION = 2;
const INITIAL_SESSION_ID = "session_0";
const SESSION_ID_PREFIX = "session_";
const STATE_STORE_LOCK_TTL_MS = 5_000;

// Decode both the current (v2, per-entry provenance) and legacy (v1,
// latest-wins actor) session-log shapes; new writes always emit v2.
const schemaVersionSchema = z.union([z.literal(1), z.literal(2)]);

const piMessageAuthoritySchema = z.union([
  z.literal("instruction"),
  z.literal("context"),
]);

/** Per-message provenance payload reused by the SQL agent-step envelope. */
export const piMessageProvenanceSchema = z
  .object({
    authority: piMessageAuthoritySchema,
    actor: actorSchema.optional(),
  })
  .strict();

/** Whether a user-role Pi message is a durable instruction or ambient context. */
export type PiMessageAuthority = z.output<typeof piMessageAuthoritySchema>;
/** Per-message record of the actor a Pi message came from and its authority weight. */
export type PiMessageProvenance = z.output<typeof piMessageProvenanceSchema>;

const unattributedContextProvenance: PiMessageProvenance = {
  authority: "context",
};

function instructionProvenance(actor?: Actor): PiMessageProvenance {
  return actor
    ? { authority: "instruction", actor }
    : { authority: "instruction" };
}

/** A provenance entry carries no signal when it is unattributed ambient context. */
function isDefaultContextProvenance(provenance: PiMessageProvenance): boolean {
  return provenance.authority === "context" && !provenance.actor;
}

/**
 * Recover per-message provenance from a legacy v1 pi_message. A stored Slack
 * actor on the entry meant that user message was the turn instruction, so it
 * decodes to an authored instruction when the identity is intact; anything
 * missing or malformed fails closed to unauthored context.
 */
export function legacyActorProvenance(
  actor: StoredSlackActor,
): PiMessageProvenance {
  if (actor.teamId && actor.slackUserId && actor.platform) {
    return instructionProvenance({
      platform: "slack",
      teamId: actor.teamId,
      userId: actor.slackUserId,
      ...(actor.slackUserName ? { userName: actor.slackUserName } : {}),
      ...(actor.fullName ? { fullName: actor.fullName } : {}),
      ...(actor.email ? { email: actor.email } : {}),
    });
  }
  return unattributedContextProvenance;
}

const piMessageEntrySchema = z.object({
  schemaVersion: schemaVersionSchema,
  type: z.literal("pi_message"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  message: piMessageSchema,
  provenance: piMessageProvenanceSchema.optional(),
  // Legacy v1 latest-wins actor, decoded into provenance on read.
  actor: storedSlackActorSchema.optional(),
});

const projectionResetEntrySchema = z.object({
  schemaVersion: schemaVersionSchema,
  type: z.literal("projection_reset"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  messages: z.array(piMessageSchema),
  provenance: z.array(piMessageProvenanceSchema).optional(),
  // Legacy v1 latest-wins actor; v1 resets carry no per-message provenance.
  actor: storedSlackActorSchema.optional(),
});

// Legacy v1 latest-wins actor event, decoded but not projected: attribution
// that cannot be aligned to a specific message fails closed to context.
const actorRecordedEntrySchema = z.object({
  schemaVersion: schemaVersionSchema,
  type: z.literal("actor_recorded"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  actor: storedSlackActorSchema,
});

const mcpProviderConnectedEntrySchema = z.object({
  schemaVersion: schemaVersionSchema,
  type: z.literal("mcp_provider_connected"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  provider: z.string().min(1),
});

const authorizationKindSchema = z.union([
  z.literal("plugin"),
  z.literal("mcp"),
]);

const authorizationRequestedEntrySchema = z.object({
  schemaVersion: schemaVersionSchema,
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
  schemaVersion: schemaVersionSchema,
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
  schemaVersion: schemaVersionSchema,
  type: z.literal("tool_execution_started"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  createdAtMs: z.number().int().nonnegative(),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.unknown().optional(),
});

const subagentStartedEntrySchema = z.object({
  schemaVersion: schemaVersionSchema,
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
  schemaVersion: schemaVersionSchema,
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

function piEntry(
  message: PiMessage,
  sessionId: string,
  provenance?: PiMessageProvenance,
): SessionLogEntry {
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "pi_message",
    sessionId,
    message,
    // Ambient context is the decode default, so only attributed/instruction
    // provenance needs to be persisted on the entry.
    ...(provenance && !isDefaultContextProvenance(provenance)
      ? { provenance }
      : {}),
  };
}

function resetEntry(
  messages: PiMessage[],
  sessionId: string,
  provenance: PiMessageProvenance[],
): SessionLogEntry {
  if (provenance.length !== messages.length) {
    throw new Error(
      "projection_reset provenance must align one-to-one with messages",
    );
  }
  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "projection_reset",
    sessionId,
    messages,
    provenance,
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

/** Aligned Pi-message projection: `provenance[i]` describes `messages[i]`. */
export interface SessionProjection {
  messages: PiMessage[];
  provenance: PiMessageProvenance[];
}

/** Decode the provenance a projected pi_message carries, tolerating v1 shapes. */
function piEntryProvenance(
  entry: Extract<SessionLogEntry, { type: "pi_message" }>,
): PiMessageProvenance {
  if (entry.provenance) {
    return entry.provenance;
  }
  if (entry.actor) {
    return legacyActorProvenance(entry.actor);
  }
  return unattributedContextProvenance;
}

/**
 * Materialize Pi messages and per-message provenance from log entries.
 *
 * Each projected message carries its own provenance instead of a single
 * latest-wins actor; legacy entries without provenance decode as
 * unauthored context, and misaligned reset provenance fails closed.
 */
function project(
  entries: SessionLogEntry[],
  sessionId?: string,
): SessionProjection {
  let messages: PiMessage[] = [];
  let provenance: PiMessageProvenance[] = [];
  for (const entry of projectionEntries(entries, sessionId)) {
    if (entry.type === "pi_message") {
      messages.push(entry.message);
      provenance.push(piEntryProvenance(entry));
      continue;
    }
    if (entry.type === "authorization_completed") {
      messages.push(authorizationObservationMessage(entry));
      provenance.push(unattributedContextProvenance);
      continue;
    }
    if (entry.type === "projection_reset") {
      const resetProvenance =
        entry.provenance ??
        entry.messages.map(() => unattributedContextProvenance);
      if (resetProvenance.length !== entry.messages.length) {
        throw new Error(
          "projection_reset provenance must align one-to-one with messages",
        );
      }
      messages = [...entry.messages];
      provenance = [...resetProvenance];
      continue;
    }
  }
  return { messages, provenance };
}

function projectMessages(
  entries: SessionLogEntry[],
  sessionId?: string,
): PiMessage[] {
  return project(entries, sessionId).messages;
}

/** Find the newest instruction actor, used for latest-actor compatibility. */
function latestInstructionActor(
  provenance: PiMessageProvenance[],
): Actor | undefined {
  for (let index = provenance.length - 1; index >= 0; index -= 1) {
    const entry = provenance[index]!;
    if (entry.authority === "instruction" && entry.actor) {
      return entry.actor;
    }
  }
  return undefined;
}

/**
 * Stable identity key for an actor: platform + name for system actors,
 * platform + team + user for Slack, platform + user otherwise. Never uses
 * display fields, so the same human under two profiles collapses to one
 * identity.
 */
function actorIdentityKey(actor: Actor): string {
  if (actor.platform === "system") {
    return `system ${actor.name}`;
  }
  return actor.platform === "slack"
    ? `slack ${actor.teamId} ${actor.userId}`
    : `${actor.platform} ${actor.userId}`;
}

/**
 * All distinct actors annotated on instruction-authority messages, in
 * first-seen order — the run's actors. This is attribution, never
 * authority: it exists so provenance consumers know which actors
 * contributed instructions to a run. It must never feed credential
 * issuance, credential-subject selection, or scope ownership.
 * Unattributable instructions (no resolvable actor) never join;
 * distinctness is by identity ids only, never display fields.
 */
export function instructionActors(provenance: PiMessageProvenance[]): Actor[] {
  const seen = new Set<string>();
  const actors: Actor[] = [];
  for (const entry of provenance) {
    if (entry.authority !== "instruction" || !entry.actor) {
      continue;
    }
    const identity = actorIdentityKey(entry.actor);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    actors.push(entry.actor);
  }
  return actors;
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

function isUserMessage(message: PiMessage): boolean {
  return (message as { role?: unknown }).role === "user";
}

/**
 * Resolve the aligned provenance to persist for `nextMessages`.
 *
 * Explicit per-message provenance always wins; otherwise the unchanged prefix
 * reuses its committed provenance, new messages default to unauthored context,
 * and any new-user-message default (the turn author's instruction) is attached
 * to the last new user message — the current turn's input.
 */
function resolveCommitProvenance(args: {
  existing: SessionProjection;
  nextMessages: PiMessage[];
  explicitProvenance?: PiMessageProvenance[];
  trailingMessageProvenance?: PiMessageProvenance[];
  newMessageProvenance?: PiMessageProvenance;
}): PiMessageProvenance[] {
  if (args.explicitProvenance) {
    if (args.explicitProvenance.length !== args.nextMessages.length) {
      throw new Error("commit provenance must align one-to-one with messages");
    }
    return args.explicitProvenance;
  }
  const matchingPrefix = countMatchingPrefix(
    args.existing.messages,
    args.nextMessages,
  );
  const provenance = args.nextMessages.map((_, index) =>
    index < matchingPrefix
      ? (args.existing.provenance[index] ?? unattributedContextProvenance)
      : unattributedContextProvenance,
  );
  if (args.newMessageProvenance) {
    for (
      let index = args.nextMessages.length - 1;
      index >= matchingPrefix;
      index -= 1
    ) {
      if (isUserMessage(args.nextMessages[index]!)) {
        provenance[index] = args.newMessageProvenance;
        break;
      }
    }
  }
  if (args.trailingMessageProvenance) {
    if (args.trailingMessageProvenance.length > provenance.length) {
      throw new Error(
        "trailing commit provenance cannot exceed committed messages",
      );
    }
    const newMessageCount = args.nextMessages.length - matchingPrefix;
    if (args.trailingMessageProvenance.length > newMessageCount) {
      throw new Error(
        "trailing commit provenance must align to newly committed messages",
      );
    }
    const start = provenance.length - args.trailingMessageProvenance.length;
    args.trailingMessageProvenance.forEach((entry, offset) => {
      provenance[start + offset] = entry;
    });
  }
  return provenance;
}

/**
 * Commit by appending when history advanced normally, or by writing an explicit
 * projection reset when the runtime intentionally replaces visible history.
 */
function commitEntries(
  existing: SessionProjection,
  nextMessages: PiMessage[],
  nextProvenance: PiMessageProvenance[],
  sessionId: string,
  entries: SessionLogEntry[],
): { entries: SessionLogEntry[]; sessionId: string } {
  const matchingPrefix = countMatchingPrefix(existing.messages, nextMessages);
  if (matchingPrefix === existing.messages.length) {
    const newMessages = nextMessages.slice(matchingPrefix);
    const newProvenance = nextProvenance.slice(matchingPrefix);
    return {
      entries: newMessages.map((message, index) =>
        piEntry(message, sessionId, newProvenance[index]),
      ),
      sessionId,
    };
  }
  const resetSessionId = nextSessionId(entries);
  return {
    entries: [resetEntry(nextMessages, resetSessionId, nextProvenance)],
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

/**
 * Read the raw decoded legacy session-log entries for one conversation.
 *
 * The single read source for the one-time Redis→SQL history import; it returns
 * every entry in list order (no projection collapsing) so the importer can
 * translate `sessionId` markers into context epochs.
 */
export async function readSessionLogEntries(
  args: Scope & {
    store?: SessionLogStore;
  },
): Promise<SessionLogEntry[]> {
  return loadEntries(args);
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

/** Load the committed Pi-message projection with aligned per-message provenance. */
export async function loadMessagesWithProvenance(
  args: Scope & {
    store?: SessionLogStore;
    messageCount: number;
    sessionId?: string;
  },
): Promise<SessionProjection | undefined> {
  const messageCount = normalizeMessageCount(args.messageCount);
  if (messageCount === 0) {
    return { messages: [], provenance: [] };
  }

  const projection = project(await loadEntries(args), args.sessionId);
  return projection.messages.length >= messageCount
    ? {
        messages: projection.messages.slice(0, messageCount),
        provenance: projection.provenance.slice(0, messageCount),
      }
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
 * Load the Pi-message projection with aligned per-message provenance in one
 * read. Used at continuation boundaries to avoid a second log scan.
 */
export async function loadProjectionWithProvenance(
  args: Scope & {
    store?: SessionLogStore;
    sessionId?: string;
  },
): Promise<SessionProjection> {
  return project(await loadEntries(args), args.sessionId);
}

/**
 * Load the projection with the latest instruction actor as a stored Slack
 * actor. Retained for callers that still key on a single latest actor; it
 * derives the actor from per-message provenance rather than a latest-wins
 * field.
 */
export async function loadProjectionWithActor(
  args: Scope & {
    store?: SessionLogStore;
    sessionId?: string;
  },
): Promise<{ messages: PiMessage[]; actor?: StoredSlackActor }> {
  const projection = project(await loadEntries(args), args.sessionId);
  const actor = latestInstructionActor(projection.provenance);
  if (actor?.platform === "slack") {
    return {
      messages: projection.messages,
      actor: {
        platform: "slack",
        slackUserId: actor.userId,
        teamId: actor.teamId,
        ...(actor.userName ? { slackUserName: actor.userName } : {}),
        ...(actor.fullName ? { fullName: actor.fullName } : {}),
        ...(actor.email ? { email: actor.email } : {}),
      },
    };
  }
  return { messages: projection.messages };
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
    /** Explicit per-message provenance aligned one-to-one with `messages`. */
    provenance?: PiMessageProvenance[];
    /** Explicit provenance for the trailing newly committed messages. */
    trailingMessageProvenance?: PiMessageProvenance[];
    /** Default applied to the last new user message when no explicit array. */
    newMessageProvenance?: PiMessageProvenance;
  },
): Promise<{ sessionId: string; provenance: PiMessageProvenance[] }> {
  const store = args.store ?? (await defaultStore());
  const entries = await store.read(args);
  const existingProjection = project(entries);
  const currentId = currentSessionId(entries);
  const nextProvenance = resolveCommitProvenance({
    existing: existingProjection,
    nextMessages: args.messages,
    ...(args.provenance ? { explicitProvenance: args.provenance } : {}),
    ...(args.trailingMessageProvenance
      ? { trailingMessageProvenance: args.trailingMessageProvenance }
      : {}),
    ...(args.newMessageProvenance
      ? { newMessageProvenance: args.newMessageProvenance }
      : {}),
  });
  const commit = commitEntries(
    existingProjection,
    args.messages,
    nextProvenance,
    currentId,
    entries,
  );
  await store.append({
    scope: args,
    entries: commit.entries,
    ttlMs: args.ttlMs,
  });
  return {
    sessionId: commit.sessionId,
    provenance: nextProvenance,
  };
}

/** Build an instruction-provenance record for the given actor. */
export function instructionProvenanceFor(
  actor: Actor | undefined,
): PiMessageProvenance {
  return instructionProvenance(actor);
}

/** Unattributed ambient-context provenance for non-instruction Pi messages. */
export const contextProvenance: PiMessageProvenance =
  unattributedContextProvenance;

/**
 * Parse durably-stored message provenance, failing closed on misalignment.
 *
 * A missing field is a legacy record: it materializes as unauthored context of
 * the expected length. A present-but-malformed or wrong-length value returns
 * undefined so callers reject the record rather than zip a mismatched array.
 */
export function parseStoredMessageProvenance(
  value: unknown,
  expectedLength: number,
): PiMessageProvenance[] | undefined {
  if (value === undefined) {
    return Array.from(
      { length: expectedLength },
      () => unattributedContextProvenance,
    );
  }
  const parsed = z.array(piMessageProvenanceSchema).safeParse(value);
  if (!parsed.success || parsed.data.length !== expectedLength) {
    return undefined;
  }
  return parsed.data;
}
