import type { Destination } from "@sentry/junior-plugin-api";
import type {
  MigrationDatabaseAdapter,
  MigrationStateV1,
} from "@sentry/junior-migrations";
import type { StateAdapter } from "chat";
import {
  isRecord as runtimeIsRecord,
  toOptionalNumber as runtimeToOptionalNumber,
  toOptionalString as runtimeToOptionalString,
} from "@/chat/coerce";
import { getChatConfig } from "@/chat/config";
import { agentStepEntrySchema } from "@/chat/conversations/history";
import { createLegacyAdvisorSessionReader } from "@/chat/conversations/legacy-advisor-session";
import { createSqlAgentStepStore } from "@/chat/conversations/sql/history";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import { createStateConversationStore } from "@/chat/conversations/state";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { toStoredConversationMessage } from "@/chat/conversations/visible-messages";
import {
  parseDestination as runtimeParseDestination,
  sameDestination as runtimeSameDestination,
} from "@/chat/destination";
import { coerceThreadConversationState as runtimeCoerceThreadConversationState } from "@/chat/state/conversation";
import { listAgentTurnSessionSummariesForConversations } from "@/chat/state/turn-session";
import {
  contextProvenance,
  decodeSessionLogEntry,
  legacyActorProvenance,
  piMessageProvenanceSchema,
} from "@/chat/state/session-log";
import {
  getConversation,
  requestConversationWork,
} from "@/chat/task-execution/state";
import { addAgentTurnUsage as runtimeAddAgentTurnUsage } from "@/chat/usage";
import { unescapeXml } from "@/chat/xml";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorAgentSteps,
  juniorConversationMessages,
  juniorConversations,
} from "@/db/schema";

export const JUNIOR_THREAD_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const migrationAgentStepEntrySchema: unknown = agentStepEntrySchema;
export const migrationContextProvenance: unknown = contextProvenance;
export const migrationJuniorAgentSteps: unknown = juniorAgentSteps;
export const migrationJuniorConversationMessages: unknown =
  juniorConversationMessages;
export const migrationJuniorConversations: unknown = juniorConversations;
export const migrationPiMessageProvenanceSchema: unknown =
  piMessageProvenanceSchema;

export type MigrationSourceV1 =
  | "api"
  | "internal"
  | "local"
  | "plugin"
  | "resource_event"
  | "scheduler"
  | "slack";

export type MigrationExecutionStatusV1 =
  | "awaiting_resume"
  | "failed"
  | "idle"
  | "pending"
  | "running";

export interface MigrationInboundMessageV1 {
  attemptCount?: number;
  conversationId: string;
  createdAtMs: number;
  destination: Destination;
  inboundMessageId: string;
  injectedAtMs?: number;
  input: {
    attachments?: unknown[];
    authorId?: string;
    metadata?: Record<string, unknown>;
    text: string;
  };
  receivedAtMs: number;
  source: MigrationSourceV1;
}

export interface MigrationLeaseV1 {
  acquiredAtMs: number;
  expiresAtMs: number;
  lastCheckInAtMs: number;
  token: string;
}

export interface MigrationConversationV1 {
  actor?: unknown;
  channelName?: string;
  conversationId: string;
  createdAtMs: number;
  destination?: Destination;
  execution: {
    inboundMessageIds?: string[];
    lastCheckpointAtMs?: number;
    lastEnqueuedAtMs?: number;
    lease?: MigrationLeaseV1;
    pendingCount?: number;
    pendingMessages?: MigrationInboundMessageV1[];
    runId?: string;
    status: MigrationExecutionStatusV1;
    updatedAtMs?: number;
  };
  lastActivityAtMs: number;
  schemaVersion: 1;
  source?: MigrationSourceV1;
  title?: string;
  updatedAtMs: number;
}

export interface MigrationRetainedConversationV1 extends MigrationConversationV1 {
  execution: MigrationConversationV1["execution"] & {
    inboundMessageIds: string[];
    pendingCount: number;
    pendingMessages: MigrationInboundMessageV1[];
  };
}

export interface MigrationThreadConversationStateV1 {
  processing: { activeTurnId?: string };
}

export interface MigrationTurnSessionSummaryV1 {
  cumulativeDurationMs: number;
  cumulativeUsage?: Record<string, unknown>;
  sessionId: string;
}

export interface MigrationStateConversationStoreV1 {
  listByActivity(args: { limit: number }): Promise<MigrationConversationV1[]>;
}

export interface MigrationSqlConversationStoreV1 {
  backfillConversation(
    conversation: MigrationConversationV1,
    metrics?: {
      durationMs: number;
      executionDurationMs: number;
      executionUsage?: Record<string, unknown>;
      usage?: Record<string, unknown>;
    },
  ): Promise<void>;
  listByActivity(args: { limit: number }): Promise<MigrationConversationV1[]>;
}

/** Return whether a value is a non-null object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return runtimeIsRecord(value);
}

/** Return a finite number or undefined. */
export function toOptionalNumber(value: unknown): number | undefined {
  return runtimeToOptionalNumber(value);
}

/** Return a non-empty string or undefined. */
export function toOptionalString(value: unknown): string | undefined {
  return runtimeToOptionalString(value);
}

/** Parse one persisted destination through the stable destination schema. */
export function parseDestination(value: unknown): Destination | undefined {
  return runtimeParseDestination(value);
}

/** Compare two persisted destinations by routing identity. */
export function sameDestination(
  left: Destination,
  right: Destination,
): boolean {
  return runtimeSameDestination(left, right);
}

/** Coerce one legacy thread-state value into the retained conversation shape. */
export function coerceThreadConversationState(
  value: unknown,
): MigrationThreadConversationStateV1 {
  return runtimeCoerceThreadConversationState(
    value,
  ) as unknown as MigrationThreadConversationStateV1;
}

/** Merge retained turn usage records. */
export function addAgentTurnUsage(
  ...values: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  return runtimeAddAgentTurnUsage(...values) as
    | Record<string, unknown>
    | undefined;
}

/** Resolve a logical state key to the configured physical Redis key. */
export function migrationRedisKey(key: string): string {
  const prefix = getChatConfig().state.keyPrefix;
  return [...(prefix ? [prefix] : []), key].join(":");
}

/** Create the retained state-backed conversation store for a v1 migration. */
export function createMigrationStateConversationStore(
  state: MigrationStateV1,
): MigrationStateConversationStoreV1 {
  return createStateConversationStore(
    state as StateAdapter,
  ) as unknown as MigrationStateConversationStoreV1;
}

/** Create the SQL conversation store for a v1 migration database adapter. */
export function createMigrationSqlStore(
  database: MigrationDatabaseAdapter,
): MigrationSqlConversationStoreV1 {
  return createSqlStore(
    database as unknown as JuniorSqlDatabase,
  ) as unknown as MigrationSqlConversationStoreV1;
}

/** Create the SQL agent-step store used by legacy history migrations. */
export function createMigrationSqlAgentStepStore(
  database: MigrationDatabaseAdapter,
): unknown {
  return createSqlAgentStepStore(database as unknown as JuniorSqlDatabase);
}

/** Create the SQL message store used by legacy history migrations. */
export function createMigrationSqlConversationMessageStore(
  database: MigrationDatabaseAdapter,
): unknown {
  return createSqlConversationMessageStore(
    database as unknown as JuniorSqlDatabase,
  );
}

/** Create the legacy advisor reader used by history migrations. */
export function createMigrationLegacyAdvisorSessionReader(): unknown {
  return createLegacyAdvisorSessionReader();
}

/** Decode one retained session-log value. */
export function decodeMigrationSessionLogEntry(value: unknown): unknown {
  return decodeSessionLogEntry(value);
}

/** Recover provenance from one legacy actor value. */
export function migrationLegacyActorProvenance(value: unknown): unknown {
  return legacyActorProvenance(value as never);
}

/** Convert one legacy visible message into its SQL projection. */
export function toMigrationStoredConversationMessage(value: unknown): unknown {
  return toStoredConversationMessage(value as never);
}

/** Unescape one legacy XML text fragment. */
export function migrationUnescapeXml(value: string): string {
  return unescapeXml(value);
}

/** Read one retained conversation through the v1 migration state adapter. */
export async function getMigrationConversation(args: {
  conversationId: string;
  state: MigrationStateV1;
}): Promise<MigrationRetainedConversationV1 | undefined> {
  return (await getConversation({
    conversationId: args.conversationId,
    state: args.state as StateAdapter,
  })) as unknown as MigrationRetainedConversationV1 | undefined;
}

/** Mark one retained conversation runnable through the v1 migration state adapter. */
export async function requestMigrationConversationWork(args: {
  conversationId: string;
  destination: Destination;
  nowMs?: number;
  state: MigrationStateV1;
}): Promise<void> {
  await requestConversationWork({
    conversationId: args.conversationId,
    destination: args.destination,
    ...(args.nowMs === undefined ? {} : { nowMs: args.nowMs }),
    state: args.state as StateAdapter,
  });
}

/** Read retained turn summaries through the v1 migration state adapter. */
export async function listMigrationTurnSessionSummaries(
  state: MigrationStateV1,
  conversationIds: string[],
): Promise<Map<string, MigrationTurnSessionSummaryV1[]>> {
  return (await listAgentTurnSessionSummariesForConversations(
    state as StateAdapter,
    conversationIds,
  )) as Map<string, MigrationTurnSessionSummaryV1[]>;
}
