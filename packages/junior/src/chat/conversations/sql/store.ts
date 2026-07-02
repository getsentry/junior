import { randomUUID } from "node:crypto";
import type { Destination } from "@sentry/junior-plugin-api";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { parseDestination, sameDestination } from "@/chat/destination";
import { upsertIdentity } from "@/chat/identities/sql";
import type { IdentityUpsert } from "@/chat/identities/identity";
import {
  parseStoredSlackRequester,
  type StoredSlackRequester,
} from "@/chat/requester";
import { migrateSchema } from "./migrations";
import type {
  JuniorSqlDatabase,
  JuniorSqlMigrationExecutor,
} from "@/chat/sql/db";
import type {
  Conversation,
  ConversationExecution,
  ConversationSource,
  ConversationStatus,
  ConversationStore,
} from "../store";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "./schema";
import type {
  JuniorDestinationKind,
  JuniorDestinationVisibility,
} from "./schema/destinations";

type ConversationRow = typeof juniorConversations.$inferSelect;
type IdentityRow = typeof juniorIdentities.$inferSelect;

interface ConversationReadRow {
  conversation: ConversationRow;
  destinationVisibility: JuniorDestinationVisibility | null;
  requesterIdentity: IdentityRow | null;
}

interface DestinationUpsert {
  displayName?: string;
  kind: JuniorDestinationKind;
  metadata?: Record<string, unknown>;
  provider: string;
  providerDestinationId: string;
  providerTenantId?: string;
  refreshVisibility: boolean;
  visibility: JuniorDestinationVisibility;
}

const CONVERSATION_MUTATION_LOCK_PREFIX = "junior_conversation";

function now(): number {
  return Date.now();
}

function dateFromMs(ms: number): Date {
  return new Date(ms);
}

function msFromDate(
  value: Date | string | null | undefined,
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return date.getTime();
}

function requiredMsFromDate(value: Date | string): number {
  const ms = msFromDate(value);
  if (typeof ms !== "number" || Number.isNaN(ms)) {
    throw new Error("Conversation record timestamp is invalid");
  }
  return ms;
}

function tenantId(value: string | undefined): string {
  return value ?? "";
}

function sourceFromValue(value: unknown): ConversationSource | undefined {
  if (
    value === "api" ||
    value === "internal" ||
    value === "local" ||
    value === "plugin" ||
    value === "resource_event" ||
    value === "scheduler" ||
    value === "slack"
  ) {
    return value;
  }
  return undefined;
}

function identityFromRequester(
  requester: StoredSlackRequester | undefined,
): IdentityUpsert | undefined {
  if (!requester?.slackUserId) {
    return undefined;
  }
  return {
    kind: "user",
    provider: "slack",
    providerTenantId: requester.teamId,
    providerSubjectId: requester.slackUserId,
    ...(requester.fullName ? { displayName: requester.fullName } : {}),
    ...(requester.slackUserName ? { handle: requester.slackUserName } : {}),
    ...(requester.email ? { email: requester.email, emailVerified: true } : {}),
    metadata: { platform: "slack" },
  };
}

function systemIdentityFromSource(
  source: ConversationSource | undefined,
): IdentityUpsert | undefined {
  if (source === "scheduler") {
    return {
      kind: "system",
      provider: "junior",
      providerSubjectId: "scheduler",
      displayName: "Junior Scheduler",
    };
  }
  if (source === "local") {
    return {
      kind: "system",
      provider: "junior",
      providerSubjectId: "local-cli",
      displayName: "Local CLI",
    };
  }
  if (source === "resource_event") {
    return {
      kind: "system",
      provider: "junior",
      providerSubjectId: "resource-event",
      displayName: "Resource Event",
    };
  }
  return undefined;
}

function actorIdentityForConversation(
  conversation: Conversation,
): IdentityUpsert | undefined {
  return (
    identityFromRequester(conversation.requester) ??
    systemIdentityFromSource(conversation.source)
  );
}

function originTypeFromSource(
  source: ConversationSource | undefined,
): string | undefined {
  return source;
}

function localWorkspaceFromConversationId(
  conversationId: string,
): string | undefined {
  const match = /^local:([^:]+):/.exec(conversationId);
  return match?.[1];
}

function destinationUpsertFromDestination(args: {
  channelName?: string;
  conversationId?: string;
  destination: Destination | undefined;
  /** Source-confirmed visibility from the current event's signal only. */
  visibility?: ConversationPrivacy;
}): DestinationUpsert | undefined {
  const { destination } = args;
  if (!destination) {
    return undefined;
  }
  if (destination.platform === "slack") {
    const channelId = destination.channelId;
    const channelKind = channelId.startsWith("D")
      ? "dm"
      : channelId.startsWith("G")
        ? "group"
        : "channel";
    return {
      kind: channelKind,
      provider: "slack",
      providerTenantId: destination.teamId,
      providerDestinationId: channelId,
      refreshVisibility: args.visibility !== undefined,
      visibility: args.visibility ?? "private",
      ...(args.channelName ? { displayName: args.channelName } : {}),
      metadata: { platform: "slack" },
    };
  }
  return {
    kind: "local_conversation",
    provider: "local",
    providerTenantId:
      localWorkspaceFromConversationId(destination.conversationId) ??
      localWorkspaceFromConversationId(args.conversationId ?? ""),
    providerDestinationId: destination.conversationId,
    refreshVisibility: true,
    visibility: "direct",
    metadata: { platform: "local" },
  };
}

function executionStatusFromValue(value: unknown): ConversationStatus {
  if (
    value === "awaiting_resume" ||
    value === "failed" ||
    value === "idle" ||
    value === "pending" ||
    value === "running"
  ) {
    return value;
  }
  throw new Error("Conversation record execution status is invalid");
}

function privacyFromRow(
  row: ConversationReadRow,
): ConversationPrivacy | undefined {
  if (row.destinationVisibility === null) {
    return undefined;
  }
  return row.destinationVisibility === "public" ? "public" : "private";
}

function requesterFromIdentityRow(
  identity: IdentityRow | null,
  fallback: StoredSlackRequester | undefined,
): StoredSlackRequester | undefined {
  if (!identity || identity.provider !== "slack") {
    return fallback;
  }
  return {
    ...(fallback ?? {}),
    ...(identity.emailNormalized
      ? { email: identity.emailNormalized }
      : identity.email
        ? { email: identity.email }
        : {}),
    ...(identity.displayName ? { fullName: identity.displayName } : {}),
    platform: "slack",
    slackUserId: identity.providerSubjectId,
    ...(identity.handle ? { slackUserName: identity.handle } : {}),
    ...(identity.providerTenantId || fallback?.teamId
      ? { teamId: identity.providerTenantId || fallback?.teamId }
      : {}),
  };
}

/** Decode one SQL row and reject invalid durable conversation records. */
function conversationFromRow(readRow: ConversationReadRow): Conversation {
  const row = readRow.conversation;
  const visibility = privacyFromRow(readRow);
  if (row.schemaVersion !== 1) {
    throw new Error("Conversation record schema version is invalid");
  }
  const destination =
    row.destination === undefined || row.destination === null
      ? undefined
      : parseDestination(row.destination);
  const requester = requesterFromIdentityRow(
    readRow.requesterIdentity,
    parseStoredSlackRequester(row.requester),
  );
  if (
    row.destination !== undefined &&
    row.destination !== null &&
    !destination
  ) {
    throw new Error("Conversation record destination is invalid");
  }
  if (row.requester !== undefined && row.requester !== null && !requester) {
    throw new Error("Conversation record requester is invalid");
  }
  const source =
    row.source === undefined || row.source === null
      ? undefined
      : sourceFromValue(row.source);
  if (row.source !== undefined && row.source !== null && !source) {
    throw new Error("Conversation record source is invalid");
  }
  const execution: ConversationExecution = {
    status: executionStatusFromValue(row.executionStatus),
    lastCheckpointAtMs: msFromDate(row.lastCheckpointAt),
    lastEnqueuedAtMs: msFromDate(row.lastEnqueuedAt),
    ...(row.runId ? { runId: row.runId } : {}),
    updatedAtMs:
      msFromDate(row.executionUpdatedAt) ?? requiredMsFromDate(row.updatedAt),
  };

  return {
    schemaVersion: 1,
    conversationId: row.conversationId,
    createdAtMs: requiredMsFromDate(row.createdAt),
    lastActivityAtMs: requiredMsFromDate(row.lastActivityAt),
    updatedAtMs: requiredMsFromDate(row.updatedAt),
    execution,
    ...(destination ? { destination } : {}),
    ...(requester ? { requester } : {}),
    ...(row.channelName ? { channelName: row.channelName } : {}),
    ...(source ? { source } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(visibility ? { visibility } : {}),
  };
}

function emptyConversation(args: {
  conversationId: string;
  destination?: Destination;
  nowMs: number;
  source?: ConversationSource;
}): Conversation {
  return {
    schemaVersion: 1,
    conversationId: args.conversationId,
    createdAtMs: args.nowMs,
    lastActivityAtMs: args.nowMs,
    updatedAtMs: args.nowMs,
    ...(args.destination ? { destination: args.destination } : {}),
    ...(args.source ? { source: args.source } : {}),
    execution: {
      status: "idle",
      updatedAtMs: args.nowMs,
    },
  };
}

function assertSameConversationDestination(args: {
  conversationId: string;
  current: Destination | undefined;
  next: Destination;
}): void {
  if (!args.current || sameDestination(args.current, args.next)) {
    return;
  }
  throw new Error(
    `Conversation destination changed for ${args.conversationId}`,
  );
}

function mergeRequester(
  current: StoredSlackRequester | undefined,
  next: StoredSlackRequester | undefined,
): StoredSlackRequester | undefined {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  if (
    current.slackUserId &&
    next.slackUserId &&
    current.slackUserId !== next.slackUserId
  ) {
    return current;
  }
  return {
    ...current,
    ...((current.email ?? next.email)
      ? { email: current.email ?? next.email }
      : {}),
    ...((current.fullName ?? next.fullName)
      ? { fullName: current.fullName ?? next.fullName }
      : {}),
    ...((current.platform ?? next.platform)
      ? { platform: current.platform ?? next.platform }
      : {}),
    ...((current.slackUserId ?? next.slackUserId)
      ? { slackUserId: current.slackUserId ?? next.slackUserId }
      : {}),
    ...((current.slackUserName ?? next.slackUserName)
      ? { slackUserName: current.slackUserName ?? next.slackUserName }
      : {}),
    ...((current.teamId ?? next.teamId)
      ? { teamId: current.teamId ?? next.teamId }
      : {}),
  };
}

export class SqlStore implements ConversationStore {
  private schemaReady: Promise<void> | undefined;

  constructor(
    private readonly executor: JuniorSqlDatabase,
    private readonly migrationExecutor: JuniorSqlMigrationExecutor,
  ) {}

  /** Apply SQL schema migrations before runtime uses this store. */
  async migrate(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = migrateSchema(this.migrationExecutor);
    }
    const schemaReady = this.schemaReady;
    try {
      await schemaReady;
    } catch (error) {
      if (this.schemaReady === schemaReady) {
        this.schemaReady = undefined;
      }
      throw error;
    }
  }

  async get(args: {
    conversationId: string;
  }): Promise<Conversation | undefined> {
    const row = await this.readConversationRow(args.conversationId);
    if (!row) {
      return undefined;
    }
    return conversationFromRow(row);
  }

  async recordActivity(args: {
    activityAtMs?: number;
    channelName?: string;
    conversationId: string;
    destination?: Destination;
    nowMs?: number;
    requester?: StoredSlackRequester;
    source?: ConversationSource;
    title?: string;
    visibility?: ConversationPrivacy;
  }): Promise<void> {
    const nowMs = args.nowMs ?? now();
    const activityAtMs = args.activityAtMs ?? nowMs;
    await this.withConversationMutation(args.conversationId, async () => {
      const existing = await this.get({
        conversationId: args.conversationId,
      });
      if (existing && args.destination) {
        assertSameConversationDestination({
          conversationId: args.conversationId,
          current: existing.destination,
          next: args.destination,
        });
      }
      const current =
        existing ??
        emptyConversation({
          conversationId: args.conversationId,
          destination: args.destination,
          nowMs,
          source: args.source,
        });
      // Persist visibility only from the current event's live signal; the
      // previously stored confirmation must not be replayed as a new signal.
      const { visibility: _persisted, ...currentWithoutVisibility } = current;
      await this.upsertConversation({
        conversation: {
          ...currentWithoutVisibility,
          destination: current.destination ?? args.destination,
          source: current.source ?? args.source,
          channelName: current.channelName ?? args.channelName,
          requester: mergeRequester(current.requester, args.requester),
          title: current.title ?? args.title,
          lastActivityAtMs: Math.max(current.lastActivityAtMs, activityAtMs),
          updatedAtMs: nowMs,
          execution: {
            ...current.execution,
            updatedAtMs: current.execution.updatedAtMs ?? nowMs,
          },
          ...(args.visibility ? { visibility: args.visibility } : {}),
        },
      });
    });
  }

  async recordExecution(args: {
    channelName?: string;
    conversationId: string;
    createdAtMs: number;
    destination?: Destination;
    execution: ConversationExecution;
    lastActivityAtMs: number;
    requester?: StoredSlackRequester;
    source?: ConversationSource;
    title?: string;
    updatedAtMs: number;
    visibility?: ConversationPrivacy;
  }): Promise<void> {
    await this.withConversationMutation(args.conversationId, async () => {
      await this.upsertConversation({
        conversation: {
          schemaVersion: 1,
          conversationId: args.conversationId,
          createdAtMs: args.createdAtMs,
          lastActivityAtMs: args.lastActivityAtMs,
          updatedAtMs: args.updatedAtMs,
          ...(args.channelName ? { channelName: args.channelName } : {}),
          ...(args.destination ? { destination: args.destination } : {}),
          ...(args.requester ? { requester: args.requester } : {}),
          ...(args.source ? { source: args.source } : {}),
          ...(args.title ? { title: args.title } : {}),
          ...(args.visibility ? { visibility: args.visibility } : {}),
          execution: args.execution,
        },
      });
    });
  }

  /** Copy one conversation record into SQL during backfill. */
  async backfillConversation(sourceConversation: Conversation): Promise<void> {
    // Backfilled records are not live source signals: never let them confirm
    // destination visibility.
    const { visibility: _visibility, ...conversation } = sourceConversation;
    await this.withConversationMutation(
      conversation.conversationId,
      async () => {
        const existing = await this.get({
          conversationId: conversation.conversationId,
        });
        const sourceExecutionAtMs =
          conversation.execution.updatedAtMs ?? conversation.updatedAtMs;
        const existingExecutionAtMs =
          existing === undefined
            ? undefined
            : (existing.execution.updatedAtMs ?? existing.updatedAtMs);
        const refreshExecutionFromSource =
          existingExecutionAtMs === undefined ||
          sourceExecutionAtMs >= existingExecutionAtMs;
        const mergedConversation = existing
          ? {
              ...conversation,
              channelName: existing.channelName ?? conversation.channelName,
              createdAtMs: Math.min(
                existing.createdAtMs,
                conversation.createdAtMs,
              ),
              destination: existing.destination ?? conversation.destination,
              lastActivityAtMs: Math.max(
                existing.lastActivityAtMs,
                conversation.lastActivityAtMs,
              ),
              requester: existing.requester ?? conversation.requester,
              source: existing.source ?? conversation.source,
              title: existing.title ?? conversation.title,
              updatedAtMs: Math.max(
                existing.updatedAtMs,
                conversation.updatedAtMs,
              ),
              execution: refreshExecutionFromSource
                ? conversation.execution
                : existing.execution,
            }
          : conversation;
        await this.upsertConversation({ conversation: mergedConversation });
      },
    );
  }

  async listByActivity(
    args: {
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Conversation[]> {
    const rows = await this.executor
      .db()
      .select({
        conversation: juniorConversations,
        destinationVisibility: juniorDestinations.visibility,
        requesterIdentity: juniorIdentities,
      })
      .from(juniorConversations)
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .leftJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.requesterIdentityId),
      )
      .orderBy(
        desc(juniorConversations.lastActivityAt),
        asc(juniorConversations.conversationId),
      )
      .limit(Math.max(0, args.limit ?? 10_000))
      .offset(Math.max(0, args.offset ?? 0));
    const conversations: Conversation[] = [];
    for (const row of rows) {
      conversations.push(conversationFromRow(row));
    }
    return conversations;
  }

  async getDestinationVisibility(args: {
    provider: string;
    providerDestinationId: string;
    providerTenantId?: string;
  }): Promise<ConversationPrivacy | undefined> {
    const rows = await this.executor
      .db()
      .select({
        visibility: juniorDestinations.visibility,
      })
      .from(juniorDestinations)
      .where(
        and(
          eq(juniorDestinations.provider, args.provider),
          eq(
            juniorDestinations.providerTenantId,
            tenantId(args.providerTenantId),
          ),
          eq(
            juniorDestinations.providerDestinationId,
            args.providerDestinationId,
          ),
        ),
      );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return row.visibility === "public" ? "public" : "private";
  }

  /** Serialize all durable mutations for one conversation inside a SQL transaction. */
  private async withConversationMutation<T>(
    conversationId: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    return await this.executor.withLock(
      `${CONVERSATION_MUTATION_LOCK_PREFIX}:${conversationId}`,
      async () => await this.executor.transaction(callback),
    );
  }

  private async readConversationRow(
    conversationId: string,
  ): Promise<ConversationReadRow | undefined> {
    const rows = await this.executor
      .db()
      .select({
        conversation: juniorConversations,
        destinationVisibility: juniorDestinations.visibility,
        requesterIdentity: juniorIdentities,
      })
      .from(juniorConversations)
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .leftJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.requesterIdentityId),
      )
      .where(eq(juniorConversations.conversationId, conversationId));
    return rows[0];
  }

  /** Upsert the conversation row while preserving previously discovered nullable metadata fields. */
  private async upsertConversation(args: {
    conversation: Conversation;
  }): Promise<void> {
    const { conversation } = args;
    const incomingExecutionVersion = sql`coalesce(excluded.execution_updated_at, excluded.updated_at)`;
    const currentExecutionVersion = sql`coalesce(${juniorConversations.executionUpdatedAt}, ${juniorConversations.updatedAt})`;
    const incomingExecutionIsFresh = sql`${incomingExecutionVersion} >= ${currentExecutionVersion}`;
    const destinationId = await this.upsertDestination(
      destinationUpsertFromDestination({
        channelName: conversation.channelName,
        conversationId: conversation.conversationId,
        destination: conversation.destination,
        ...(conversation.visibility
          ? { visibility: conversation.visibility }
          : {}),
      }),
      conversation.updatedAtMs,
    );
    const requesterIdentityObservation = identityFromRequester(
      conversation.requester,
    );
    const requesterIdentity = requesterIdentityObservation
      ? await upsertIdentity(
          this.executor,
          requesterIdentityObservation,
          conversation.updatedAtMs,
        )
      : undefined;
    const actorIdentityObservation = actorIdentityForConversation(conversation);
    const actorIdentity = actorIdentityObservation
      ? await upsertIdentity(
          this.executor,
          actorIdentityObservation,
          conversation.updatedAtMs,
        )
      : undefined;
    await this.executor
      .db()
      .insert(juniorConversations)
      .values({
        conversationId: conversation.conversationId,
        schemaVersion: 1,
        source: conversation.source ?? null,
        originType: originTypeFromSource(conversation.source) ?? null,
        originId: null,
        originRunId: null,
        destinationId: destinationId ?? null,
        destination: conversation.destination ?? null,
        actorIdentityId: actorIdentity?.id ?? null,
        requesterIdentityId: requesterIdentity?.id ?? null,
        creatorIdentityId: null,
        credentialSubjectIdentityId: null,
        requester: conversation.requester ?? null,
        channelName: conversation.channelName ?? null,
        title: conversation.title ?? null,
        createdAt: dateFromMs(conversation.createdAtMs),
        lastActivityAt: dateFromMs(conversation.lastActivityAtMs),
        updatedAt: dateFromMs(conversation.updatedAtMs),
        executionUpdatedAt:
          conversation.execution.updatedAtMs === undefined
            ? null
            : dateFromMs(conversation.execution.updatedAtMs),
        executionStatus: conversation.execution.status,
        runId: conversation.execution.runId ?? null,
        lastCheckpointAt:
          conversation.execution.lastCheckpointAtMs === undefined
            ? null
            : dateFromMs(conversation.execution.lastCheckpointAtMs),
        lastEnqueuedAt:
          conversation.execution.lastEnqueuedAtMs === undefined
            ? null
            : dateFromMs(conversation.execution.lastEnqueuedAtMs),
      })
      .onConflictDoUpdate({
        target: juniorConversations.conversationId,
        set: {
          source: sql`coalesce(excluded.source, ${juniorConversations.source})`,
          originType: sql`coalesce(excluded.origin_type, ${juniorConversations.originType})`,
          originId: sql`coalesce(excluded.origin_id, ${juniorConversations.originId})`,
          originRunId: sql`coalesce(excluded.origin_run_id, ${juniorConversations.originRunId})`,
          destinationId: sql`coalesce(excluded.destination_id, ${juniorConversations.destinationId})`,
          destination: sql`coalesce(excluded.destination_json, ${juniorConversations.destination})`,
          actorIdentityId: sql`coalesce(excluded.actor_identity_id, ${juniorConversations.actorIdentityId})`,
          requesterIdentityId: sql`coalesce(excluded.requester_identity_id, ${juniorConversations.requesterIdentityId})`,
          creatorIdentityId: sql`coalesce(excluded.creator_identity_id, ${juniorConversations.creatorIdentityId})`,
          credentialSubjectIdentityId: sql`coalesce(excluded.credential_subject_identity_id, ${juniorConversations.credentialSubjectIdentityId})`,
          requester: sql`coalesce(excluded.requester_json, ${juniorConversations.requester})`,
          channelName: sql`coalesce(excluded.channel_name, ${juniorConversations.channelName})`,
          title: sql`coalesce(excluded.title, ${juniorConversations.title})`,
          createdAt: sql`least(${juniorConversations.createdAt}, excluded.created_at)`,
          lastActivityAt: sql`greatest(${juniorConversations.lastActivityAt}, excluded.last_activity_at)`,
          updatedAt: sql`greatest(${juniorConversations.updatedAt}, excluded.updated_at)`,
          executionUpdatedAt: sql`case when ${incomingExecutionIsFresh} then excluded.execution_updated_at else ${juniorConversations.executionUpdatedAt} end`,
          executionStatus: sql`case when ${incomingExecutionIsFresh} then excluded.execution_status else ${juniorConversations.executionStatus} end`,
          runId: sql`case when ${incomingExecutionIsFresh} then excluded.run_id else ${juniorConversations.runId} end`,
          lastCheckpointAt: sql`case when ${incomingExecutionIsFresh} then coalesce(excluded.last_checkpoint_at, ${juniorConversations.lastCheckpointAt}) else ${juniorConversations.lastCheckpointAt} end`,
          lastEnqueuedAt: sql`case when ${incomingExecutionIsFresh} then coalesce(excluded.last_enqueued_at, ${juniorConversations.lastEnqueuedAt}) else ${juniorConversations.lastEnqueuedAt} end`,
        },
      });
  }

  private async upsertDestination(
    destination: DestinationUpsert | undefined,
    nowMs: number,
  ): Promise<string | undefined> {
    if (!destination) {
      return undefined;
    }
    const visibilityUpdate = destination.refreshVisibility
      ? sql`excluded.visibility`
      : juniorDestinations.visibility;
    const rows = await this.executor
      .db()
      .insert(juniorDestinations)
      .values({
        id: randomUUID(),
        provider: destination.provider,
        providerTenantId: tenantId(destination.providerTenantId),
        providerDestinationId: destination.providerDestinationId,
        kind: destination.kind,
        parentDestinationId: null,
        displayName: destination.displayName ?? null,
        visibility: destination.visibility,
        metadata: destination.metadata ?? null,
        createdAt: dateFromMs(nowMs),
        updatedAt: dateFromMs(nowMs),
      })
      .onConflictDoUpdate({
        target: [
          juniorDestinations.provider,
          juniorDestinations.providerTenantId,
          juniorDestinations.providerDestinationId,
        ],
        set: {
          kind: sql`excluded.kind`,
          displayName: sql`coalesce(excluded.display_name, ${juniorDestinations.displayName})`,
          // Signal-less writes insert as private but must not clobber an
          // existing public/private value. Live source signals refresh this
          // field so converted channels converge on the next message.
          visibility: visibilityUpdate,
          metadata: sql`coalesce(excluded.metadata_json, ${juniorDestinations.metadata})`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ id: juniorDestinations.id });
    return rows[0]?.id;
  }
}

/** Create a SQL-backed conversation store. */
export function createSqlStore(executor: JuniorSqlMigrationExecutor): SqlStore {
  return new SqlStore(executor, executor);
}
