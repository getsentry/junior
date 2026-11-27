import type { Destination, Source } from "@sentry/junior-plugin-api";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { topLevelConversation } from "./listed";
import { rootSpaceIdSql } from "@/chat/spaces/tree-space";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { sameDestination } from "@/chat/destination";
import { recordConversationParticipant } from "./participants";
import {
  readConversationRunMetrics,
  replaceConversationMetrics,
} from "../metrics";
import type { StoredSlackActor } from "@/chat/actor";
import {
  normalizeSessionSource,
  parseSessionSource,
  type SessionSource,
} from "@/chat/source";
import type { JuniorSqlDatabase } from "@/db/db";
import type {
  Conversation,
  ConversationExecution,
  ConversationRunMetrics,
  ChildConversationKind,
  ConversationSource,
  ConversationStore,
  TopLevelConversationKind,
} from "../store";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import {
  destinationUpsertFromDestination,
  upsertDestination,
} from "./destination-upsert";
import {
  bindProviderConversation,
  claimProviderConversationOwner,
  getConversationIdByProviderConversation,
  type ProviderConversationBinding,
  type ProviderConversationReference,
} from "./bindings";
import {
  actorFromIdentityRow,
  resolveConversationActorIdentityId,
  mergeActor,
} from "./actor-identity";
import { locationForWrite, locationFromRow } from "./location";
import {
  conversationKindFromRow,
  ensureConversationRow,
} from "./conversation-row";
import { nextDetailVersion } from "./detail-version";
import {
  destinationFromRow,
  executionStatusFromValue,
  msFromDate,
  requiredMsFromDate,
  sourceFromValue,
} from "./row-decode";
import {
  copiesRootVisibility,
  isTopLevel,
  keepsStoredParent,
  kindAllowsParent,
  storesSpace,
} from "@/chat/conversations/kind-behavior";
import {
  fillMissingTreeVisibility,
  resolveRootVisibility,
} from "@/chat/conversations/sql/privacy";
type ConversationRow = typeof juniorConversations.$inferSelect;
type DestinationRow = typeof juniorDestinations.$inferSelect;
type IdentityRow = typeof juniorIdentities.$inferSelect;
interface ConversationReadRow {
  conversation: ConversationRow;
  destination: DestinationRow | null;
  actorIdentity: IdentityRow | null;
  actorUserDisplayName: string | null;
  /** The Space of the tree root. Only a Lead stores one. */
  treeSpaceId: string | null;
}

/** The Space of the row's tree, for `conversationFromRow`. */
const treeSpaceIdColumn = rootSpaceIdSql(juniorConversations);

const CONVERSATION_MUTATION_LOCK_PREFIX = "junior_conversation";

/** Serialize one conversation's durable mutations inside a SQL transaction. */
export async function withConversationMutationLock<T>(
  executor: JuniorSqlDatabase,
  conversationId: string,
  callback: () => Promise<T>,
): Promise<T> {
  return await executor.withLock(
    `${CONVERSATION_MUTATION_LOCK_PREFIX}:${conversationId}`,
    async () => await executor.transaction(callback),
  );
}

function now(): number {
  return Date.now();
}
function dateFromMs(ms: number): Date {
  return new Date(ms);
}
function tenantId(value: string | undefined): string {
  return value ?? "";
}

/** Decode one SQL row and reject invalid durable conversation records. */
function conversationFromRow(readRow: ConversationReadRow): Conversation {
  const row = readRow.conversation;
  const visibility = row.visibility ?? undefined;
  if (row.schemaVersion !== 1) {
    throw new Error("Conversation record schema version is invalid");
  }
  if (row.destination !== null && readRow.destination === null) {
    throw new Error("Conversation legacy destination is not migrated");
  }
  if (row.actor !== null && readRow.actorIdentity === null) {
    throw new Error("Conversation legacy actor is not migrated");
  }
  const destination = destinationFromRow(readRow.destination);
  const actor = actorFromIdentityRow(
    readRow.actorIdentity,
    readRow.actorUserDisplayName,
  );
  if (readRow.destination !== null && !destination) {
    throw new Error("Conversation record destination is invalid");
  }
  const source =
    row.source === undefined || row.source === null
      ? undefined
      : sourceFromValue(row.source);
  if (row.source !== undefined && row.source !== null && !source) {
    throw new Error("Conversation record source is invalid");
  }
  const sessionSource =
    row.sessionSource === undefined || row.sessionSource === null
      ? undefined
      : parseSessionSource(row.sessionSource);
  if (
    row.sessionSource !== undefined &&
    row.sessionSource !== null &&
    !sessionSource
  ) {
    throw new Error("Conversation record session source is invalid");
  }
  const execution: ConversationExecution = {
    status: executionStatusFromValue(row.executionStatus),
    lastCheckpointAtMs: msFromDate(row.lastCheckpointAt),
    lastEnqueuedAtMs: msFromDate(row.lastEnqueuedAt),
    ...(row.runId ? { runId: row.runId } : undefined),
    updatedAtMs:
      msFromDate(row.executionUpdatedAt) ?? requiredMsFromDate(row.updatedAt),
  };
  const location = locationFromRow(
    row.location,
    readRow.destination,
    sessionSource,
  );
  // A Conversation is in the Space of its tree. Only a Lead stores it.
  const spaceId = row.spaceId ?? readRow.treeSpaceId;

  return {
    schemaVersion: 1,
    conversationId: row.conversationId,
    createdAtMs: requiredMsFromDate(row.createdAt),
    lastActivityAtMs: requiredMsFromDate(row.lastActivityAt),
    updatedAtMs: requiredMsFromDate(row.updatedAt),
    execution,
    executionMetrics: {
      durationMs: row.executionDurationMs,
      ...(row.metricRunId ? { runId: row.metricRunId } : undefined),
      ...(row.executionUsage ? { usage: row.executionUsage } : undefined),
    },
    kind: conversationKindFromRow(row),
    ...(row.parentConversationId
      ? { parentConversationId: row.parentConversationId }
      : undefined),
    ...(row.rootConversationId
      ? { rootConversationId: row.rootConversationId }
      : undefined),
    ...(spaceId ? { spaceId } : undefined),
    ...(row.archivedAt
      ? { archivedAtMs: row.archivedAt.getTime() }
      : undefined),
    ...(destination ? { destination } : undefined),
    ...(location ? { location } : undefined),
    ...(actor ? { actor } : undefined),
    ...(row.channelName ? { channelName: row.channelName } : undefined),
    ...(source ? { source } : undefined),
    ...(sessionSource ? { sessionSource } : undefined),
    ...(row.title ? { title: row.title } : undefined),
    ...(row.summary ? { summary: row.summary } : undefined),
    ...(msFromDate(row.transcriptPurgedAt) !== undefined
      ? { transcriptPurgedAtMs: msFromDate(row.transcriptPurgedAt) }
      : undefined),
    ...(msFromDate(row.stoppedAt) !== undefined
      ? { stoppedAtMs: msFromDate(row.stoppedAt) }
      : undefined),
    ...(msFromDate(row.deliveryPausedAt) !== undefined
      ? { deliveryPausedAtMs: msFromDate(row.deliveryPausedAt) }
      : undefined),
    ...(visibility ? { visibility } : undefined),
  };
}

function emptyConversation(args: {
  conversationId: string;
  destination?: Destination | undefined;
  kind?: TopLevelConversationKind | undefined;
  nowMs: number;
  source?: ConversationSource | undefined;
  sessionSource?: SessionSource;
}): Conversation {
  return {
    schemaVersion: 1,
    conversationId: args.conversationId,
    createdAtMs: args.nowMs,
    kind: args.kind ?? "thread",
    lastActivityAtMs: args.nowMs,
    updatedAtMs: args.nowMs,
    ...(args.destination ? { destination: args.destination } : undefined),
    ...(args.source ? { source: args.source } : undefined),
    ...(args.sessionSource ? { sessionSource: args.sessionSource } : undefined),
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

/**
 * Return whether a write keeps the stored Destination, whatever Destination
 * it names. A child stores its parent's. A local one is final: Slack input
 * in a thread that moved into a Space, or left one, does not reconnect it.
 */
function keepsStoredDestination(existing: Conversation | undefined): boolean {
  return (
    existing !== undefined &&
    (!isTopLevel(existing) || existing.destination?.platform === "local")
  );
}

export class SqlStore implements ConversationStore {
  private readonly executor: JuniorSqlDatabase;

  constructor(executor: JuniorSqlDatabase) {
    this.executor = executor;
  }

  async getConversationIdByProviderConversation(
    args: ProviderConversationReference,
  ): Promise<string | undefined> {
    return await getConversationIdByProviderConversation(this.executor, args);
  }

  async bindProviderConversation(
    args: ProviderConversationBinding,
  ): Promise<void> {
    await bindProviderConversation(this.executor, args);
  }

  async claimProviderConversation(
    args: ProviderConversationBinding & { atMs: number },
  ): Promise<string> {
    const { atMs, ...binding } = args;
    return await this.executor.transaction(async () => {
      await ensureConversationRow(this.executor, binding.conversationId, atMs, {
        activity: "preserve",
      });
      return await claimProviderConversationOwner(this.executor, binding);
    });
  }

  async createChild(args: {
    childConversationId: string;
    kind: ChildConversationKind;
    parentConversationId: string;
    nowMs?: number;
    source?: ConversationSource;
    title?: string;
  }): Promise<void> {
    const nowMs = args.nowMs ?? now();
    await this.withConversationMutation(args.parentConversationId, async () => {
      await this.withConversationMutation(
        args.childConversationId,
        async () => {
          const existing = await this.get({
            conversationId: args.childConversationId,
          });
          if (existing) {
            if (existing.parentConversationId !== args.parentConversationId) {
              throw new Error(
                `Conversation parent changed for ${args.childConversationId}`,
              );
            }
            if (existing.kind !== args.kind) {
              throw new Error(
                `Conversation kind changed for ${args.childConversationId}`,
              );
            }
            return;
          }
          const parentRow = await this.readConversationRow(
            args.parentConversationId,
          );
          if (!parentRow) {
            throw new Error(
              `Conversation parent is missing for ${args.childConversationId}`,
            );
          }
          // A child stores its parent's Destination row and Location, so it
          // reads its Location from its own row, the same as a root.
          const { location } = conversationFromRow(parentRow);
          const child: Conversation = {
            ...emptyConversation({
              conversationId: args.childConversationId,
              nowMs,
              source: args.source,
            }),
            kind: args.kind,
            parentConversationId: args.parentConversationId,
            ...(location ? { location } : undefined),
            ...(args.title ? { title: args.title } : undefined),
          };
          await this.upsertConversation({
            conversation: child,
            destinationId: parentRow.conversation.destinationId ?? undefined,
          });
        },
      );
    });
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

  async getRunMetrics(args: {
    conversationId: string;
    runId: string;
  }): Promise<ConversationRunMetrics | undefined> {
    return await readConversationRunMetrics(this.executor, args);
  }

  async recordActivity(args: {
    activityAtMs?: number;
    channelName?: string;
    conversationId: string;
    destination?: Destination | undefined;
    nowMs?: number;
    actor?: StoredSlackActor;
    source?: ConversationSource;
    sessionSource?: Source;
    title?: string;
    visibility?: ConversationPrivacy;
    kind?: TopLevelConversationKind;
    spaceId?: string | undefined;
  }): Promise<void> {
    const nowMs = args.nowMs ?? now();
    const activityAtMs = args.activityAtMs ?? nowMs;
    const sessionSource = normalizeSessionSource(args.sessionSource);
    await this.withConversationMutation(args.conversationId, async () => {
      const existing = await this.get({
        conversationId: args.conversationId,
      });
      if (existing && args.destination && !keepsStoredDestination(existing)) {
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
          kind: args.kind,
          nowMs,
          source: args.source,
          ...(sessionSource ? { sessionSource } : undefined),
        });
      // Persist visibility only from the current event's live signal; the
      // previously stored confirmation must not be replayed as a new signal.
      // The stored Space is not resent, so a move that commits between the
      // read above and this write is kept.
      const {
        sessionSource: _persistedSessionSource,
        spaceId: _persistedSpaceId,
        visibility: _persistedVisibility,
        ...currentWithoutPersistedSignals
      } = current;
      await this.upsertConversation({
        conversation: {
          ...currentWithoutPersistedSignals,
          destination: current.destination ?? args.destination,
          source: current.source ?? args.source,
          ...(sessionSource ? { sessionSource } : undefined),
          channelName: current.channelName ?? args.channelName,
          actor: mergeActor(current.actor, args.actor),
          title: current.title ?? args.title,
          lastActivityAtMs: Math.max(current.lastActivityAtMs, activityAtMs),
          updatedAtMs: nowMs,
          execution: {
            ...current.execution,
            updatedAtMs: current.execution.updatedAtMs ?? nowMs,
          },
          ...(args.visibility ? { visibility: args.visibility } : undefined),
          ...(!existing && args.spaceId
            ? { spaceId: args.spaceId }
            : undefined),
        },
      });
    });
  }
  async recordExecution(args: {
    actorIdentityId?: string | undefined;
    channelName?: string;
    conversationId: string;
    createdAtMs: number;
    destination?: Destination | undefined;
    execution: ConversationExecution;
    lastActivityAtMs: number;
    metrics: ConversationRunMetrics | null;
    actor?: StoredSlackActor;
    source?: ConversationSource;
    title?: string;
    updatedAtMs: number;
    visibility?: ConversationPrivacy;
  }): Promise<void> {
    if (args.metrics && !args.execution.runId) {
      throw new Error("Conversation Run metrics require a Run id");
    }
    await this.withConversationMutation(args.conversationId, async () => {
      const existingRow = await this.readConversationRow(args.conversationId);
      const existing = existingRow
        ? conversationFromRow(existingRow)
        : undefined;
      // Execution dual-write updates existing rows or creates roots that already
      // carry a destination. It does not create roots without a destination.
      if (!existing && !args.destination) {
        return;
      }
      const incomingExecutionAt =
        args.execution.updatedAtMs ?? args.updatedAtMs;
      const existingExecutionAt =
        existing?.execution.updatedAtMs ?? existing?.updatedAtMs ?? 0;
      const latestMetricRunId = existing?.executionMetrics?.runId;
      // A Run with metric rows that no longer owns the latest metrics is older
      // than the latest Run. Its terminal status must not replace the status
      // of that newer Run.
      const olderRunFinished =
        args.metrics !== null &&
        args.execution.runId !== undefined &&
        latestMetricRunId !== undefined &&
        latestMetricRunId !== args.execution.runId &&
        (args.execution.status === "idle" ||
          args.execution.status === "failed") &&
        (await readConversationRunMetrics(this.executor, {
          conversationId: args.conversationId,
          runId: args.execution.runId,
        })) !== undefined;
      const incomingIsFresh =
        !olderRunFinished && incomingExecutionAt >= existingExecutionAt;
      const execution = incomingIsFresh
        ? args.execution
        : (existing?.execution ?? args.execution);
      // Root Actor and origin Source come from the saved Conversation, as in
      // recordActivity. A later Turn, such as an event on a Conversation that
      // the dashboard started, must not derive a system Actor from its Source.
      const actor = mergeActor(existing?.actor, args.actor);
      const source = existing?.source ?? args.source;
      await this.upsertConversation({
        conversation: {
          schemaVersion: 1,
          conversationId: args.conversationId,
          createdAtMs: args.createdAtMs,
          kind: existing?.kind ?? "thread",
          lastActivityAtMs: args.lastActivityAtMs,
          updatedAtMs: args.updatedAtMs,
          ...(existing?.parentConversationId
            ? { parentConversationId: existing.parentConversationId }
            : undefined),
          ...(existing?.location ? { location: existing.location } : undefined),
          ...(args.channelName ? { channelName: args.channelName } : undefined),
          ...(args.destination && !keepsStoredDestination(existing)
            ? { destination: args.destination }
            : undefined),
          ...(actor ? { actor } : undefined),
          ...(source ? { source } : undefined),
          ...(args.title ? { title: args.title } : undefined),
          ...(args.visibility ? { visibility: args.visibility } : undefined),
          execution,
        },
      });
      if (args.metrics && args.execution.runId) {
        await replaceConversationMetrics(this.executor, {
          actorIdentityId: args.actorIdentityId,
          conversationId: args.conversationId,
          runId: args.execution.runId,
          occurredAtMs: args.createdAtMs,
          updatedAtMs: incomingExecutionAt,
          ...args.metrics,
        });
        if (incomingIsFresh) {
          await this.executor
            .db()
            .update(juniorConversations)
            .set({
              metricRunId: args.execution.runId,
              executionDurationMs: args.metrics.durationMs,
              executionUsage: args.metrics.usage ?? null,
              detailVersion: nextDetailVersion,
            })
            .where(eq(juniorConversations.conversationId, args.conversationId));
        }
      }
    });
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
        destination: juniorDestinations,
        actorIdentity: juniorIdentities,
        actorUserDisplayName: juniorUsers.displayName,
        treeSpaceId: treeSpaceIdColumn,
      })
      .from(juniorConversations)
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .leftJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      // Only tree roots. Other children are left out of top-level listings
      // and purge with their root on the root's visibility window.
      .where(topLevelConversation())
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
    if (row.visibility === "public" || row.visibility === "private") {
      return row.visibility;
    }
    return undefined;
  }

  async recordDestinationVisibility(args: {
    channelName?: string;
    destination: Destination;
    nowMs?: number;
    visibility: ConversationPrivacy;
  }): Promise<void> {
    await upsertDestination(
      this.executor,
      destinationUpsertFromDestination(args),
      args.nowMs ?? Date.now(),
    );
  }

  async findSlackDestinationByName(args: {
    channelName: string;
    teamId: string;
  }): Promise<{ channelId: string; channelName?: string } | undefined> {
    const normalized = args.channelName.trim().replace(/^#/, "").toLowerCase();
    if (!normalized) {
      return undefined;
    }

    // Limit 2 so an ambiguous exact name fails closed instead of guessing.
    const rows = await this.executor
      .db()
      .select({
        channelId: juniorDestinations.providerDestinationId,
        channelName: juniorDestinations.displayName,
      })
      .from(juniorDestinations)
      .where(
        and(
          eq(juniorDestinations.provider, "slack"),
          eq(juniorDestinations.providerTenantId, tenantId(args.teamId)),
          eq(juniorDestinations.kind, "channel"),
          sql`lower(ltrim(${juniorDestinations.displayName}, '#')) = ${normalized}`,
        ),
      )
      .limit(2);

    if (rows.length !== 1) {
      return undefined;
    }
    const row = rows[0];
    if (!row?.channelId) {
      return undefined;
    }
    return {
      channelId: row.channelId,
      ...(row.channelName ? { channelName: row.channelName } : undefined),
    };
  }

  /** Serialize all durable mutations for one conversation inside a SQL transaction. */
  private async withConversationMutation<T>(
    conversationId: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    return await withConversationMutationLock(
      this.executor,
      conversationId,
      callback,
    );
  }

  private async readConversationRow(
    conversationId: string,
  ): Promise<ConversationReadRow | undefined> {
    const rows = await this.executor
      .db()
      .select({
        conversation: juniorConversations,
        destination: juniorDestinations,
        actorIdentity: juniorIdentities,
        actorUserDisplayName: juniorUsers.displayName,
        treeSpaceId: treeSpaceIdColumn,
      })
      .from(juniorConversations)
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .leftJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(eq(juniorConversations.conversationId, conversationId));
    return rows[0];
  }

  /** Upsert the conversation row while preserving previously discovered nullable metadata fields. */
  private async upsertConversation(args: {
    conversation: Conversation;
    /** A new child's Destination row, copied from its parent. */
    destinationId?: string | undefined;
  }): Promise<void> {
    const { conversation } = args;
    if (
      !kindAllowsParent(conversation.kind, !!conversation.parentConversationId)
    ) {
      throw new Error(
        `Conversation ${conversation.conversationId} kind does not match its parent`,
      );
    }
    // Root Conversations set Destination on first write. A Conversation with a
    // parent can omit Destination. Later updates may omit Destination because
    // onConflict keeps the existing destination_id.
    if (!conversation.parentConversationId && !conversation.destination) {
      const existing = await this.get({
        conversationId: conversation.conversationId,
      });
      if (!existing) {
        throw new Error(
          `Conversation ${conversation.conversationId} requires a destination at create`,
        );
      }
    }
    const incomingExecutionVersion = sql`coalesce(excluded.execution_updated_at, excluded.updated_at)`;
    const currentExecutionVersion = sql`coalesce(${juniorConversations.executionUpdatedAt}, ${juniorConversations.updatedAt})`;
    const incomingExecutionIsFresh = sql`${incomingExecutionVersion} >= ${currentExecutionVersion}`;
    const upsertedDestination = await upsertDestination(
      this.executor,
      destinationUpsertFromDestination({
        channelName: conversation.channelName,
        conversationId: conversation.conversationId,
        destination: conversation.destination,
        ...(conversation.visibility
          ? { visibility: conversation.visibility }
          : undefined),
      }),
      conversation.updatedAtMs,
    );
    const destinationId = upsertedDestination?.id ?? args.destinationId;
    // A root takes the visibility of its Destination. A child copies its
    // root's, under the root Destination lock that
    // `fillMissingTreeVisibility` takes.
    const visibility = copiesRootVisibility(conversation)
      ? (
          await resolveRootVisibility(
            this.executor,
            conversation.parentConversationId ?? conversation.conversationId,
          )
        ).visibility
      : (upsertedDestination?.visibility ?? null);
    const location = locationForWrite({
      destination: conversation.destination,
      destinationId,
      location: conversation.location,
      sessionSource: conversation.sessionSource,
    });
    const actorIdentityId = await resolveConversationActorIdentityId(
      this.executor,
      conversation,
    );
    const rootConversationId = conversation.parentConversationId
      ? sql<string | null>`(
          select parent.root_conversation_id
          from junior_conversations parent
          where parent.conversation_id = ${conversation.parentConversationId}
        )`
      : conversation.conversationId;
    // A Lead's children are its child agents, so each stores an agent
    // config. A spawn writes its own config after this.
    const agentConfig = sql`(
      select case when parent.kind = 'lead' then '{}'::jsonb end
      from junior_conversations parent
      where parent.conversation_id = ${conversation.parentConversationId ?? null}
    )`;
    // Only a Lead stores its Space. A Lead's child reads it from the Lead.
    const spaceId = storesSpace(conversation.kind)
      ? (conversation.spaceId ?? null)
      : null;
    const db = this.executor.db();
    // Reads the row as it was before this statement, so a root that first
    // gets a visibility or an Actor here knows it.
    const prior = db.$with("prior_conversation").as(
      db
        .select({
          actorIdentityId: juniorConversations.actorIdentityId,
          visibility: juniorConversations.visibility,
        })
        .from(juniorConversations)
        .where(
          eq(juniorConversations.conversationId, conversation.conversationId),
        ),
    );
    const rows = await db
      .with(prior)
      .insert(juniorConversations)
      .values({
        conversationId: conversation.conversationId,
        schemaVersion: 1,
        source: conversation.source ?? null,
        sessionSource: conversation.sessionSource ?? null,
        location: location ?? null,
        destinationId: destinationId ?? null,
        destination: null,
        actorIdentityId: actorIdentityId ?? null,
        creatorIdentityId: null,
        credentialSubjectIdentityId: null,
        actor: null,
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
        parentConversationId: conversation.parentConversationId ?? null,
        kind: conversation.kind,
        agentConfig,
        rootConversationId,
        spaceId,
        visibility,
      })
      .onConflictDoUpdate({
        target: juniorConversations.conversationId,
        set: {
          // Origin source is set-once so dashboard continues cannot rewrite a Slack root.
          source: sql`coalesce(${juniorConversations.source}, excluded.source)`,
          sessionSource: sql`coalesce(${juniorConversations.sessionSource}, excluded.source_json)`,
          location: sql`coalesce(excluded.location_json, ${juniorConversations.location})`,
          destinationId: sql`coalesce(excluded.destination_id, ${juniorConversations.destinationId})`,
          // Keep the stored Identity. A human reply cannot replace a system root.
          actorIdentityId: sql`coalesce(${juniorConversations.actorIdentityId}, excluded.actor_identity_id)`,
          creatorIdentityId: sql`coalesce(excluded.creator_identity_id, ${juniorConversations.creatorIdentityId})`,
          credentialSubjectIdentityId: sql`coalesce(excluded.credential_subject_identity_id, ${juniorConversations.credentialSubjectIdentityId})`,
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
          rootConversationId: sql`coalesce(${juniorConversations.rootConversationId}, excluded.root_conversation_id)`,
          // Set once. This also fills a null kind left by an older deploy.
          kind: sql`coalesce(${juniorConversations.kind}, excluded.kind)`,
          // Only a new Lead sends a Space.
          spaceId: sql`coalesce(${juniorConversations.spaceId}, excluded.space_id)`,
          // A write fills a missing visibility and never changes a known
          // one.
          visibility: sql`coalesce(${juniorConversations.visibility}, excluded.visibility)`,
          detailVersion: nextDetailVersion,
        },
      })
      .returning({
        actorIdentityId: juniorConversations.actorIdentityId,
        parentConversationId: juniorConversations.parentConversationId,
        rootConversationId: juniorConversations.rootConversationId,
        visibility: juniorConversations.visibility,
        filledVisibility: sql<boolean>`exists (select 1 from ${prior} where ${prior.visibility} is null)`,
        setActor: sql<boolean>`not exists (select 1 from ${prior} where ${prior.actorIdentityId} is not null)`,
      });
    const row = rows[0];
    if (!row?.rootConversationId) {
      throw new Error("Conversation parent is missing its persisted root");
    }
    if (
      !copiesRootVisibility(conversation) &&
      row.visibility &&
      row.filledVisibility
    ) {
      await fillMissingTreeVisibility(
        this.executor,
        row.rootConversationId,
        row.visibility,
      );
    }
    // A conflict keeps the stored parent. A history append can create the row
    // first under the event lock, so a new child can find a root row here.
    if (
      !keepsStoredParent(
        row.parentConversationId,
        conversation.parentConversationId,
      )
    ) {
      throw new Error(
        `Conversation parent changed for ${conversation.conversationId}`,
      );
    }
    // The root Actor is a Participant before they author a message. Only the
    // write that sets the Actor adds them, so a later Turn does not undo
    // their Leave.
    if (
      row.actorIdentityId &&
      row.setActor &&
      row.parentConversationId === null
    ) {
      await recordConversationParticipant(this.executor, {
        actorIdentityId: row.actorIdentityId,
        conversationId: conversation.conversationId,
        atMs: conversation.lastActivityAtMs,
      });
    }
  }
}

/** Create a SQL-backed conversation store. */
export function createSqlStore(executor: JuniorSqlDatabase): SqlStore {
  return new SqlStore(executor);
}
