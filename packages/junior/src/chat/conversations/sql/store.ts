import { randomUUID } from "node:crypto";
import type { Destination, Source } from "@sentry/junior-plugin-api";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { parseDestination, sameDestination } from "@/chat/destination";
import { upsertIdentity } from "@/chat/identities/sql";
import type { IdentityUpsert } from "@/chat/identities/identity";
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
  ConversationSource,
  ConversationStatus,
  ConversationStore,
} from "../store";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import type { AgentTurnCost, AgentTurnUsage } from "@/chat/usage";
import type {
  JuniorDestinationKind,
  JuniorDestinationVisibility,
} from "@/db/schema/destinations";
import {
  bindProviderConversation,
  getConversationIdByProviderConversation,
  type ProviderConversationBinding,
  type ProviderConversationReference,
} from "./bindings";
import { locationFromRow, privacyFromLocationRow } from "./location";
type ConversationRow = typeof juniorConversations.$inferSelect;
type DestinationRow = typeof juniorDestinations.$inferSelect;
type IdentityRow = typeof juniorIdentities.$inferSelect;
interface ConversationReadRow {
  conversation: ConversationRow;
  destination: DestinationRow | null;
  actorIdentity: IdentityRow | null;
  actorUserDisplayName: string | null;
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

function identityFromActor(
  actor: StoredSlackActor | undefined,
): IdentityUpsert | undefined {
  if (!actor?.slackUserId) {
    return undefined;
  }
  return {
    kind: "user",
    provider: "slack",
    providerTenantId: actor.teamId,
    providerSubjectId: actor.slackUserId,
    ...(actor.fullName ? { displayName: actor.fullName } : {}),
    ...(actor.slackUserName ? { handle: actor.slackUserName } : {}),
    ...(actor.email ? { email: actor.email, emailVerified: true } : {}),
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
    identityFromActor(conversation.actor) ??
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
  /** Confirmed destination visibility; omit when unavailable. */
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
      visibility: args.visibility ?? "unknown",
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

/** Reconstruct a Slack actor with the linked user name and identity-scoped provider fields. */
function actorFromIdentityRow(
  identity: IdentityRow | null,
  userDisplayName: string | null,
): StoredSlackActor | undefined {
  if (!identity) {
    return undefined;
  }
  if (identity.provider !== "slack") {
    return undefined;
  }
  const fullName = userDisplayName?.trim()
    ? userDisplayName
    : identity.displayName;
  return {
    ...(identity.emailNormalized
      ? { email: identity.emailNormalized }
      : identity.email
        ? { email: identity.email }
        : {}),
    ...(fullName ? { fullName } : {}),
    platform: "slack",
    slackUserId: identity.providerSubjectId,
    ...(identity.handle ? { slackUserName: identity.handle } : {}),
    ...(identity.providerTenantId ? { teamId: identity.providerTenantId } : {}),
  };
}

function destinationFromRow(
  destination: DestinationRow | null,
): Destination | undefined {
  const value =
    destination?.provider === "slack"
      ? {
          platform: "slack",
          teamId: destination.providerTenantId,
          channelId: destination.providerDestinationId,
        }
      : destination?.provider === "local"
        ? {
            platform: "local",
            conversationId: destination.providerDestinationId,
          }
        : undefined;
  return parseDestination(value);
}

/** Decode one SQL row and reject invalid durable conversation records. */
function conversationFromRow(readRow: ConversationReadRow): Conversation {
  const row = readRow.conversation;
  const visibility = privacyFromLocationRow(readRow.destination);
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
    ...(row.runId ? { runId: row.runId } : {}),
    updatedAtMs:
      msFromDate(row.executionUpdatedAt) ?? requiredMsFromDate(row.updatedAt),
  };
  const location = locationFromRow(readRow.destination);

  return {
    schemaVersion: 1,
    conversationId: row.conversationId,
    createdAtMs: requiredMsFromDate(row.createdAt),
    lastActivityAtMs: requiredMsFromDate(row.lastActivityAt),
    updatedAtMs: requiredMsFromDate(row.updatedAt),
    execution,
    executionMetrics: {
      durationMs: row.executionDurationMs,
      ...(row.metricRunId ? { runId: row.metricRunId } : {}),
      ...(row.executionUsage ? { usage: row.executionUsage } : {}),
    },
    ...(row.parentConversationId
      ? {
          lineage: {
            parentConversationId: row.parentConversationId,
          },
        }
      : {}),
    ...(destination ? { destination } : {}),
    ...(location ? { location } : {}),
    ...(actor ? { actor } : {}),
    ...(msFromDate(row.archivedAt) !== undefined
      ? { archivedAtMs: msFromDate(row.archivedAt) }
      : {}),
    ...(row.channelName ? { channelName: row.channelName } : {}),
    ...(source ? { source } : {}),
    ...(sessionSource ? { sessionSource } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(msFromDate(row.transcriptPurgedAt) !== undefined
      ? { transcriptPurgedAtMs: msFromDate(row.transcriptPurgedAt) }
      : {}),
    ...(visibility ? { visibility } : {}),
  };
}

function emptyConversation(args: {
  conversationId: string;
  destination?: Destination;
  nowMs: number;
  source?: ConversationSource;
  sessionSource?: SessionSource;
}): Conversation {
  return {
    schemaVersion: 1,
    conversationId: args.conversationId,
    createdAtMs: args.nowMs,
    lastActivityAtMs: args.nowMs,
    updatedAtMs: args.nowMs,
    ...(args.destination ? { destination: args.destination } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(args.sessionSource ? { sessionSource: args.sessionSource } : {}),
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

function mergeActor(
  current: StoredSlackActor | undefined,
  next: StoredSlackActor | undefined,
): StoredSlackActor | undefined {
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

function tokenTotal(usage: AgentTurnUsage | undefined): number {
  if (!usage) return 0;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cachedInputTokens ?? 0) +
    (usage.cacheCreationTokens ?? 0)
  );
}

function updateConversationUsage(args: {
  current: AgentTurnUsage | undefined;
  previousExecution: AgentTurnUsage | undefined;
  nextExecution: AgentTurnUsage;
}): AgentTurnUsage {
  const usage: AgentTurnUsage = {
    totalTokens:
      tokenTotal(args.current) -
      tokenTotal(args.previousExecution) +
      tokenTotal(args.nextExecution),
  };
  if (
    args.current?.reasoningTokens !== undefined ||
    args.previousExecution?.reasoningTokens !== undefined ||
    args.nextExecution.reasoningTokens !== undefined
  ) {
    usage.reasoningTokens =
      (args.current?.reasoningTokens ?? 0) -
      (args.previousExecution?.reasoningTokens ?? 0) +
      (args.nextExecution.reasoningTokens ?? 0);
  }
  const costFields = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "total",
  ] as const satisfies ReadonlyArray<keyof AgentTurnCost>;
  const cost: AgentTurnCost = {};
  for (const field of costFields) {
    if (
      args.current?.cost?.[field] === undefined &&
      args.previousExecution?.cost?.[field] === undefined &&
      args.nextExecution.cost?.[field] === undefined
    ) {
      continue;
    }
    cost[field] =
      Math.round(
        ((args.current?.cost?.[field] ?? 0) -
          (args.previousExecution?.cost?.[field] ?? 0) +
          (args.nextExecution.cost?.[field] ?? 0)) *
          1e12,
      ) / 1e12;
  }
  if (Object.keys(cost).length > 0) usage.cost = cost;
  return usage;
}

export class SqlStore implements ConversationStore {
  constructor(private readonly executor: JuniorSqlDatabase) {}

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

  async createChild(args: {
    childConversationId: string;
    parentConversationId: string;
    nowMs?: number;
    source?: ConversationSource;
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
            if (
              existing.lineage?.parentConversationId !==
              args.parentConversationId
            ) {
              throw new Error(
                `Conversation lineage changed for ${args.childConversationId}`,
              );
            }
            return;
          }
          const parent = await this.get({
            conversationId: args.parentConversationId,
          });
          if (!parent) {
            throw new Error(
              `Conversation parent is missing for ${args.childConversationId}`,
            );
          }
          if (parent.lineage) {
            throw new Error("Recursive agent delegation is not enabled");
          }
          const child: Conversation = {
            ...emptyConversation({
              conversationId: args.childConversationId,
              nowMs,
              source: args.source,
            }),
            lineage: {
              parentConversationId: args.parentConversationId,
            },
          };
          await this.upsertConversation({ conversation: child });
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

  async recordActivity(args: {
    activityAtMs?: number;
    channelName?: string;
    conversationId: string;
    destination?: Destination;
    nowMs?: number;
    actor?: StoredSlackActor;
    source?: ConversationSource;
    sessionSource?: Source;
    title?: string;
    visibility?: ConversationPrivacy;
  }): Promise<void> {
    const nowMs = args.nowMs ?? now();
    const activityAtMs = args.activityAtMs ?? nowMs;
    const sessionSource = normalizeSessionSource(args.sessionSource);
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
          ...(sessionSource ? { sessionSource } : {}),
        });
      // Persist visibility only from the current event's live signal; the
      // previously stored confirmation must not be replayed as a new signal.
      const {
        sessionSource: _persistedSessionSource,
        visibility: _persistedVisibility,
        ...currentWithoutPersistedSignals
      } = current;
      await this.upsertConversation({
        conversation: {
          ...currentWithoutPersistedSignals,
          destination: current.destination ?? args.destination,
          source: current.source ?? args.source,
          ...(sessionSource ? { sessionSource } : {}),
          channelName: current.channelName ?? args.channelName,
          actor: mergeActor(current.actor, args.actor),
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
    metrics: {
      durationMs: number;
      usage?: AgentTurnUsage;
    } | null;
    actor?: StoredSlackActor;
    source?: ConversationSource;
    title?: string;
    updatedAtMs: number;
    visibility?: ConversationPrivacy;
  }): Promise<void> {
    await this.withConversationMutation(args.conversationId, async () => {
      const existingRow = await this.readConversationRow(args.conversationId);
      const existing = existingRow
        ? conversationFromRow(existingRow)
        : undefined;
      const incomingExecutionAt =
        args.execution.updatedAtMs ?? args.updatedAtMs;
      const existingExecutionAt =
        existing?.execution.updatedAtMs ?? existing?.updatedAtMs ?? 0;
      const incomingIsFresh = incomingExecutionAt >= existingExecutionAt;
      const metricRunId = existingRow?.conversation.metricRunId;
      const sameRun =
        Boolean(metricRunId) && metricRunId === args.execution.runId;
      const execution = incomingIsFresh
        ? args.execution
        : (existing?.execution ?? args.execution);
      await this.upsertConversation({
        conversation: {
          schemaVersion: 1,
          conversationId: args.conversationId,
          createdAtMs: args.createdAtMs,
          lastActivityAtMs: args.lastActivityAtMs,
          updatedAtMs: args.updatedAtMs,
          ...(args.channelName ? { channelName: args.channelName } : {}),
          ...(args.destination ? { destination: args.destination } : {}),
          ...(args.actor ? { actor: args.actor } : {}),
          ...(args.source ? { source: args.source } : {}),
          ...(args.title ? { title: args.title } : {}),
          ...(args.visibility ? { visibility: args.visibility } : {}),
          execution,
        },
      });
      if (incomingIsFresh && args.metrics) {
        const row = existingRow?.conversation;
        const usage = args.metrics.usage
          ? updateConversationUsage({
              current: row?.usage ?? undefined,
              previousExecution: sameRun
                ? (row?.executionUsage ?? undefined)
                : undefined,
              nextExecution: args.metrics.usage,
            })
          : (row?.usage ?? undefined);
        await this.executor
          .db()
          .update(juniorConversations)
          .set({
            durationMs:
              (row?.durationMs ?? 0) -
              (sameRun ? (row?.executionDurationMs ?? 0) : 0) +
              args.metrics.durationMs,
            usage: usage ?? null,
            metricRunId: args.execution.runId ?? null,
            executionDurationMs: args.metrics.durationMs,
            executionUsage:
              args.metrics.usage ??
              (sameRun ? (row?.executionUsage ?? null) : null),
          })
          .where(eq(juniorConversations.conversationId, args.conversationId));
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
      // Subagent child conversations are excluded from top-level listings and
      // purge with their root on the root's visibility window.
      .where(isNull(juniorConversations.parentConversationId))
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
    const actorIdentityObservation = actorIdentityForConversation(conversation);
    const actorIdentity = actorIdentityObservation
      ? await upsertIdentity(
          this.executor,
          actorIdentityObservation,
          conversation.updatedAtMs,
        )
      : undefined;
    const rootConversationId = conversation.lineage
      ? sql<string | null>`(
          select parent.root_conversation_id
          from junior_conversations parent
          where parent.conversation_id = ${conversation.lineage.parentConversationId}
        )`
      : conversation.conversationId;
    const rows = await this.executor
      .db()
      .insert(juniorConversations)
      .values({
        conversationId: conversation.conversationId,
        schemaVersion: 1,
        source: conversation.source ?? null,
        sessionSource: conversation.sessionSource ?? null,
        originType: originTypeFromSource(conversation.source) ?? null,
        originId: null,
        originRunId: null,
        destinationId: destinationId ?? null,
        destination: null,
        actorIdentityId: actorIdentity?.id ?? null,
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
        parentConversationId:
          conversation.lineage?.parentConversationId ?? null,
        rootConversationId,
      })
      .onConflictDoUpdate({
        target: juniorConversations.conversationId,
        set: {
          source: sql`coalesce(excluded.source, ${juniorConversations.source})`,
          sessionSource: sql`coalesce(${juniorConversations.sessionSource}, excluded.source_json)`,
          originType: sql`coalesce(excluded.origin_type, ${juniorConversations.originType})`,
          originId: sql`coalesce(excluded.origin_id, ${juniorConversations.originId})`,
          originRunId: sql`coalesce(excluded.origin_run_id, ${juniorConversations.originRunId})`,
          destinationId: sql`coalesce(excluded.destination_id, ${juniorConversations.destinationId})`,
          actorIdentityId: sql`coalesce(excluded.actor_identity_id, ${juniorConversations.actorIdentityId})`,
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
        },
      })
      .returning({
        rootConversationId: juniorConversations.rootConversationId,
      });
    if (!rows[0]?.rootConversationId) {
      throw new Error("Conversation parent is missing its persisted root");
    }
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
          // Signal-less writes remain unknown and must not clobber an existing
          // public/private value. Live source signals refresh this field so
          // converted channels converge on the next message.
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
export function createSqlStore(executor: JuniorSqlDatabase): SqlStore {
  return new SqlStore(executor);
}
