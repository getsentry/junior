/**
 * Legacy Redis Pi session-log reader for the operator SQL backfill.
 *
 * SQL conversation events are the sole durable history authority. This module
 * exists only to decode and read pre-cutover Redis entries during the bounded
 * Redis-to-SQL import window.
 */
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import { z } from "zod";
import { getChatConfig } from "@/chat/config";
import { piMessageSchema } from "@/chat/pi/messages";
import { storedSlackActorSchema, type StoredSlackActor } from "@/chat/actor";
import {
  getConnectedStateContext,
  getStateAdapter,
} from "@/chat/state/adapter";
import {
  contextProvenance,
  conversationMessageProvenanceSchema,
  instructionProvenanceFor,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";

const AGENT_SESSION_LOG_PREFIX = "junior:agent-session-log";
const AGENT_SESSION_LOG_SCHEMA_VERSION = 2;
const INITIAL_SESSION_ID = "session_0";

// Decode both deployed v2 (per-entry provenance) and legacy v1 (latest-wins
// actor) session-log shapes from before SQL conversation events became primary.
const schemaVersionSchema = z.union([z.literal(1), z.literal(2)]);

/**
 * Recover per-message provenance from a legacy v1 pi_message. A stored Slack
 * actor on the entry meant that user message was the turn instruction, so it
 * decodes to an authored instruction when the identity is intact; anything
 * missing or malformed fails closed to unauthored context.
 */
export function legacyActorProvenance(
  actor: StoredSlackActor,
): ConversationMessageProvenance {
  if (actor.teamId && actor.slackUserId && actor.platform) {
    return instructionProvenanceFor({
      platform: "slack",
      teamId: actor.teamId,
      userId: actor.slackUserId,
      ...(actor.slackUserName ? { userName: actor.slackUserName } : {}),
      ...(actor.fullName ? { fullName: actor.fullName } : {}),
      ...(actor.email ? { email: actor.email } : {}),
    });
  }
  return contextProvenance;
}

const piMessageEntrySchema = z.object({
  schemaVersion: schemaVersionSchema,
  type: z.literal("pi_message"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  message: piMessageSchema,
  provenance: conversationMessageProvenanceSchema.optional(),
  // Legacy v1 latest-wins actor, decoded into provenance on read.
  actor: storedSlackActorSchema.optional(),
});

const projectionResetEntrySchema = z.object({
  schemaVersion: schemaVersionSchema,
  type: z.literal("projection_reset"),
  sessionId: z.string().min(1).default(INITIAL_SESSION_ID),
  messages: z.array(piMessageSchema),
  provenance: z.array(conversationMessageProvenanceSchema).optional(),
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
  modelId: z.string().min(1).optional(),
  reasoningLevel: z.string().min(1).optional(),
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

/** One decoded pre-cutover Redis entry accepted by the SQL history importer. */
export type SessionLogEntry = z.infer<typeof sessionLogEntrySchema>;

interface Scope {
  conversationId: string;
}

/** Read-only port for the bounded legacy Redis-to-SQL import. */
export interface SessionLogStore {
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

/** Normalize deployed requester-era fields before legacy schema validation. */
function migrateStoredEntry(value: unknown): unknown {
  const record = storedRecord(value);
  if (!record) {
    return value;
  }

  const migrated = { ...record };
  // TODO(v0.104.0): Remove legacy requester session-log entry migration.
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

/** Decode an enveloped legacy entry, falling back to a raw Pi message shape. */
function decode(value: unknown): SessionLogEntry {
  if (typeof value === "string") {
    return decode(JSON.parse(value) as unknown);
  }

  const parsed = sessionLogEntrySchema.safeParse(migrateStoredEntry(value));
  if (parsed.success) {
    return parsed.data;
  }

  return {
    schemaVersion: AGENT_SESSION_LOG_SCHEMA_VERSION,
    type: "pi_message",
    sessionId: INITIAL_SESSION_ID,
    message: piMessageSchema.parse(value),
  };
}

function redisStore(redisStateAdapter: RedisStateAdapter): SessionLogStore {
  const client = redisStateAdapter.getClient();

  return {
    async read(scope) {
      const values = await client.lRange(key(scope), 0, -1);
      return values.map(decode);
    },
  };
}

function stateStore(): SessionLogStore {
  const stateAdapter = getStateAdapter();

  return {
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
