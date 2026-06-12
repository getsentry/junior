/**
 * SQL-backed conversation metadata store.
 *
 * This owns queryable metadata only: execution state, routing fields, display
 * activity, and transient pending inbound input. Injected input is cleared so
 * SQL does not become a transcript authority; execution timestamps stay
 * separate from display activity for recovery scans.
 */
import { randomUUID } from "node:crypto";
import type { Destination } from "@sentry/junior-plugin-api";
import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { isRecord, toOptionalString } from "@/chat/coerce";
import { parseDestination, sameDestination } from "@/chat/destination";
import {
  parseStoredSlackRequester,
  type StoredSlackRequester,
} from "@/chat/requester";
import {
  CONVERSATION_WORK_LEASE_TTL_MS,
  type AgentInput,
  type AppendInboundMessageResult,
  type Conversation,
  type ConversationExecution,
  type ConversationWorkState,
  type ExecutionStatus,
  type InboundMessage,
  type Lease,
  type RequestConversationWorkResult,
  type Source,
  type StartConversationWorkResult,
} from "../state-task-execution-store";
import { migrateSchema } from "./migrations";
import type {
  JuniorSqlDatabase,
  JuniorSqlMigrationExecutor,
} from "@/chat/sql/db";
import type { ConversationMetadataStore } from "../store";
import {
  juniorConversationInboundMessages,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "./schema";
import type {
  JuniorDestinationKind,
  JuniorDestinationVisibility,
} from "./schema/destinations";
import type { JuniorIdentityKind } from "./schema/identities";

type ConversationRow = typeof juniorConversations.$inferSelect;
type InboundMessageRow = typeof juniorConversationInboundMessages.$inferSelect;

interface IdentityUpsert {
  email?: string;
  displayName?: string;
  handle?: string;
  kind: JuniorIdentityKind;
  metadata?: Record<string, unknown>;
  provider: string;
  providerSubjectId: string;
  providerTenantId?: string;
}

interface DestinationUpsert {
  displayName?: string;
  kind: JuniorDestinationKind;
  metadata?: Record<string, unknown>;
  provider: string;
  providerDestinationId: string;
  providerTenantId?: string;
  visibility: JuniorDestinationVisibility;
}

const CONVERSATION_MUTATION_LOCK_PREFIX = "junior_conversation_metadata";

function now(): number {
  return Date.now();
}

function dateFromMs(ms: number): Date {
  return new Date(ms);
}

function tenantId(value: string | undefined): string {
  return value ?? "";
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
    throw new Error("Conversation metadata timestamp is invalid");
  }
  return ms;
}

function sourceFromValue(value: unknown): Source | undefined {
  if (
    value === "api" ||
    value === "internal" ||
    value === "local" ||
    value === "plugin" ||
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
    ...(requester.email ? { email: requester.email } : {}),
    metadata: { platform: "slack" },
  };
}

function systemIdentityFromSource(
  source: Source | undefined,
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

function originTypeFromSource(source: Source | undefined): string | undefined {
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
    const visibility = channelId.startsWith("D")
      ? "direct"
      : channelId.startsWith("G")
        ? "private"
        : "public";
    return {
      kind: channelKind,
      provider: "slack",
      providerTenantId: destination.teamId,
      providerDestinationId: channelId,
      visibility,
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
    visibility: "direct",
    metadata: { platform: "local" },
  };
}

function executionStatusFromValue(value: unknown): ExecutionStatus {
  if (
    value === "awaiting_resume" ||
    value === "idle" ||
    value === "pending" ||
    value === "running"
  ) {
    return value;
  }
  throw new Error("Conversation metadata execution status is invalid");
}

function inputFromValue(value: unknown): AgentInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const text = toOptionalString(value.text);
  if (!text) {
    return undefined;
  }
  return {
    text,
    authorId: toOptionalString(value.authorId),
    attachments: Array.isArray(value.attachments)
      ? [...value.attachments]
      : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

function compareMessages(left: InboundMessage, right: InboundMessage): number {
  return (
    left.createdAtMs - right.createdAtMs ||
    left.receivedAtMs - right.receivedAtMs ||
    left.inboundMessageId.localeCompare(right.inboundMessageId)
  );
}

function pendingMessages(rows: InboundMessageRow[]): InboundMessage[] {
  return rows
    .filter((row) => row.injectedAt == null)
    .map((row) => {
      const destination = parseDestination(row.destination);
      const source = sourceFromValue(row.source);
      const input = inputFromValue(row.input);
      if (!destination || !source || !input) {
        throw new Error("Pending conversation metadata inbound row is invalid");
      }
      const injectedAtMs = msFromDate(row.injectedAt);
      return {
        conversationId: row.conversationId,
        inboundMessageId: row.inboundMessageId,
        source,
        destination,
        input,
        createdAtMs: requiredMsFromDate(row.createdAt),
        receivedAtMs: requiredMsFromDate(row.receivedAt),
        ...(injectedAtMs === undefined ? {} : { injectedAtMs }),
      };
    })
    .sort(compareMessages);
}

function leaseFromRow(row: ConversationRow): Lease | undefined {
  if (!row.leaseToken) {
    return undefined;
  }
  const acquiredAtMs = msFromDate(row.leaseAcquiredAt);
  const lastCheckInAtMs = msFromDate(row.leaseLastCheckInAt);
  const expiresAtMs = msFromDate(row.leaseExpiresAt);
  if (
    typeof acquiredAtMs !== "number" ||
    typeof lastCheckInAtMs !== "number" ||
    typeof expiresAtMs !== "number"
  ) {
    return undefined;
  }
  return {
    token: row.leaseToken,
    acquiredAtMs,
    lastCheckInAtMs,
    expiresAtMs,
  };
}

function hasRunnableWork(conversation: Conversation): boolean {
  return (
    conversation.execution.status !== "idle" ||
    conversation.execution.pendingMessages.length > 0
  );
}

function conversationFromRows(
  row: ConversationRow,
  inboundRows: InboundMessageRow[],
): Conversation {
  if (row.schemaVersion !== 1) {
    throw new Error("Conversation metadata schema version is invalid");
  }
  const destination =
    row.destination === undefined || row.destination === null
      ? undefined
      : parseDestination(row.destination);
  const requester = parseStoredSlackRequester(row.requester);
  const source =
    row.source === undefined || row.source === null
      ? undefined
      : sourceFromValue(row.source);
  if (row.source !== undefined && row.source !== null && !source) {
    throw new Error("Conversation metadata source is invalid");
  }
  const messages = pendingMessages(inboundRows);
  const inboundMessageIds = inboundRows.map(
    (message) => message.inboundMessageId,
  );
  const lease = leaseFromRow(row);
  const execution: ConversationExecution = {
    status: executionStatusFromValue(row.executionStatus),
    inboundMessageIds: [...new Set(inboundMessageIds)],
    pendingCount: messages.length,
    pendingMessages: messages,
    lastCheckpointAtMs: msFromDate(row.lastCheckpointAt),
    lastEnqueuedAtMs: msFromDate(row.lastEnqueuedAt),
    ...(lease ? { lease } : {}),
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
  };
}

function conversationWorkState(
  conversation: Conversation,
): ConversationWorkState {
  const lease = conversation.execution.lease;
  return {
    ...conversation,
    ...(lease
      ? {
          lease: {
            acquiredAtMs: lease.acquiredAtMs,
            lastCheckInAtMs: lease.lastCheckInAtMs,
            leaseExpiresAtMs: lease.expiresAtMs,
            leaseToken: lease.token,
          },
        }
      : {}),
    messages: [...conversation.execution.pendingMessages],
    needsRun: hasRunnableWork(conversation),
  };
}

function emptyConversation(args: {
  conversationId: string;
  destination?: Destination;
  nowMs: number;
  source?: Source;
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
      inboundMessageIds: [],
      pendingCount: 0,
      pendingMessages: [],
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

function isLeaseActive(lease: Lease | undefined, nowMs: number): boolean {
  return Boolean(lease && lease.expiresAtMs > nowMs);
}

function inputTextLength(input: AgentInput): number {
  return input.text.length;
}

function attachmentCount(input: AgentInput): number {
  return Array.isArray(input.attachments) ? input.attachments.length : 0;
}

export class SqlStore implements ConversationMetadataStore {
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

  async getConversation(args: {
    conversationId: string;
  }): Promise<Conversation | undefined> {
    const row = await this.readConversationRow(args.conversationId);
    if (!row) {
      return undefined;
    }
    return conversationFromRows(
      row,
      await this.readInboundRows(args.conversationId),
    );
  }

  async getConversationWorkState(args: {
    conversationId: string;
  }): Promise<ConversationWorkState | undefined> {
    const conversation = await this.getConversation(args);
    return conversation ? conversationWorkState(conversation) : undefined;
  }

  async appendInboundMessage(args: {
    message: InboundMessage;
    nowMs?: number;
  }): Promise<AppendInboundMessageResult> {
    const nowMs = args.nowMs ?? now();
    return await this.withConversationMutation(
      args.message.conversationId,
      async () => {
        const existing =
          (await this.getConversation({
            conversationId: args.message.conversationId,
          })) ??
          emptyConversation({
            conversationId: args.message.conversationId,
            destination: args.message.destination,
            nowMs,
            source: args.message.source,
          });
        assertSameConversationDestination({
          conversationId: args.message.conversationId,
          current: existing.destination,
          next: args.message.destination,
        });

        const existingRows = await this.executor
          .db()
          .select({
            injectedAt: juniorConversationInboundMessages.injectedAt,
          })
          .from(juniorConversationInboundMessages)
          .where(
            and(
              eq(
                juniorConversationInboundMessages.conversationId,
                args.message.conversationId,
              ),
              eq(
                juniorConversationInboundMessages.inboundMessageId,
                args.message.inboundMessageId,
              ),
            ),
          );
        if (existingRows.length > 0) {
          if (existingRows[0]?.injectedAt == null) {
            const nextStatus =
              existing.execution.status === "idle"
                ? "pending"
                : existing.execution.status;
            await this.upsertConversation({
              conversation: {
                ...existing,
                updatedAtMs: nowMs,
                execution: {
                  ...existing.execution,
                  status: nextStatus,
                  updatedAtMs: nowMs,
                },
              },
            });
          }
          return { status: "duplicate" };
        }

        const status =
          existing.execution.lease && existing.execution.status === "running"
            ? "running"
            : existing.execution.lease
              ? "awaiting_resume"
              : "pending";
        await this.upsertConversation({
          conversation: {
            ...existing,
            destination: existing.destination ?? args.message.destination,
            source: existing.source ?? args.message.source,
            lastActivityAtMs: nowMs,
            updatedAtMs: nowMs,
            execution: {
              ...existing.execution,
              status,
              updatedAtMs: nowMs,
            },
          },
        });
        await this.upsertInboundMessage(args.message);
        return { status: "appended" };
      },
    );
  }

  async requestConversationWork(args: {
    conversationId: string;
    destination: Destination;
    nowMs?: number;
  }): Promise<RequestConversationWorkResult> {
    const nowMs = args.nowMs ?? now();
    return await this.withConversationMutation(
      args.conversationId,
      async () => {
        const existing = await this.getConversation({
          conversationId: args.conversationId,
        });
        if (existing) {
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
          });
        await this.upsertConversation({
          conversation: {
            ...current,
            destination: current.destination ?? args.destination,
            updatedAtMs: nowMs,
            execution: {
              ...current.execution,
              status: current.execution.lease ? "awaiting_resume" : "pending",
              updatedAtMs: nowMs,
            },
          },
        });
        return { status: existing === undefined ? "created" : "updated" };
      },
    );
  }

  async recordConversationActivity(args: {
    activityAtMs?: number;
    channelName?: string;
    conversationId: string;
    destination?: Destination;
    nowMs?: number;
    requester?: StoredSlackRequester;
    source?: Source;
    title?: string;
  }): Promise<void> {
    const nowMs = args.nowMs ?? now();
    const activityAtMs = args.activityAtMs ?? nowMs;
    await this.withConversationMutation(args.conversationId, async () => {
      const existing = await this.getConversation({
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
      await this.upsertConversation({
        conversation: {
          ...current,
          destination: current.destination ?? args.destination,
          source: current.source ?? args.source,
          channelName: current.channelName ?? args.channelName,
          requester: current.requester ?? args.requester,
          title: current.title ?? args.title,
          lastActivityAtMs: Math.max(current.lastActivityAtMs, activityAtMs),
          updatedAtMs: nowMs,
          execution: {
            ...current.execution,
            updatedAtMs: current.execution.updatedAtMs ?? nowMs,
          },
        },
      });
    });
  }

  async startConversationWork(args: {
    conversationId: string;
    nowMs?: number;
  }): Promise<StartConversationWorkResult> {
    const nowMs = args.nowMs ?? now();
    return await this.withConversationMutation(
      args.conversationId,
      async () => {
        const current = await this.getConversation({
          conversationId: args.conversationId,
        });
        if (!current) {
          return { status: "no_work" };
        }
        if (isLeaseActive(current.execution.lease, nowMs)) {
          return {
            status: "active",
            leaseExpiresAtMs: current.execution.lease!.expiresAtMs,
          };
        }
        if (!hasRunnableWork(current)) {
          return { status: "no_work" };
        }

        const lease: Lease = {
          token: randomUUID(),
          acquiredAtMs: nowMs,
          lastCheckInAtMs: nowMs,
          expiresAtMs: nowMs + CONVERSATION_WORK_LEASE_TTL_MS,
        };
        await this.upsertConversation({
          conversation: {
            ...current,
            updatedAtMs: nowMs,
            execution: {
              ...current.execution,
              lease,
              status: "running",
              runId: current.execution.runId ?? randomUUID(),
              lastEnqueuedAtMs: undefined,
              updatedAtMs: nowMs,
            },
          },
        });
        return {
          status: "acquired",
          leaseToken: lease.token,
          leaseExpiresAtMs: lease.expiresAtMs,
        };
      },
    );
  }

  async checkInConversationWork(args: {
    conversationId: string;
    leaseToken: string;
    nowMs?: number;
  }): Promise<boolean> {
    const nowMs = args.nowMs ?? now();
    return await this.withConversationMutation(
      args.conversationId,
      async () => {
        const current = await this.getConversation({
          conversationId: args.conversationId,
        });
        if (!current || current.execution.lease?.token !== args.leaseToken) {
          return false;
        }
        await this.upsertConversation({
          conversation: {
            ...current,
            updatedAtMs: nowMs,
            execution: {
              ...current.execution,
              lease: {
                ...current.execution.lease,
                lastCheckInAtMs: nowMs,
                expiresAtMs: nowMs + CONVERSATION_WORK_LEASE_TTL_MS,
              },
              updatedAtMs: nowMs,
            },
          },
        });
        return true;
      },
    );
  }

  async drainConversationMailbox(args: {
    conversationId: string;
    inject: (messages: InboundMessage[]) => Promise<void>;
    leaseToken: string;
    nowMs?: number;
  }): Promise<InboundMessage[]> {
    const nowMs = args.nowMs ?? now();
    const pending = await this.withConversationMutation(
      args.conversationId,
      async () => {
        const current = await this.getConversation({
          conversationId: args.conversationId,
        });
        if (!current || current.execution.lease?.token !== args.leaseToken) {
          throw new Error(
            `Conversation lease is not held for ${args.conversationId}`,
          );
        }
        return [...current.execution.pendingMessages];
      },
    );
    if (pending.length === 0) {
      return [];
    }

    await args.inject(pending);
    await this.markConversationMessagesInjected({
      conversationId: args.conversationId,
      inboundMessageIds: pending.map((message) => message.inboundMessageId),
      leaseToken: args.leaseToken,
      nowMs,
    });
    return pending;
  }

  async markConversationMessagesInjected(args: {
    conversationId: string;
    inboundMessageIds: string[];
    leaseToken: string;
    nowMs?: number;
  }): Promise<boolean> {
    const nowMs = args.nowMs ?? now();
    return await this.withConversationMutation(
      args.conversationId,
      async () => {
        const current = await this.getConversation({
          conversationId: args.conversationId,
        });
        if (!current || current.execution.lease?.token !== args.leaseToken) {
          return false;
        }
        if (args.inboundMessageIds.length === 0) {
          return true;
        }
        await this.executor
          .db()
          .update(juniorConversationInboundMessages)
          .set({
            injectedAt: dateFromMs(nowMs),
            input: null,
          })
          .where(
            and(
              eq(
                juniorConversationInboundMessages.conversationId,
                args.conversationId,
              ),
              inArray(
                juniorConversationInboundMessages.inboundMessageId,
                args.inboundMessageIds,
              ),
            ),
          );
        await this.upsertConversation({
          conversation: {
            ...current,
            updatedAtMs: nowMs,
            execution: {
              ...current.execution,
              pendingMessages: current.execution.pendingMessages.filter(
                (message) =>
                  !args.inboundMessageIds.includes(message.inboundMessageId),
              ),
              updatedAtMs: nowMs,
            },
          },
        });
        return true;
      },
    );
  }

  async requestConversationContinuation(args: {
    conversationId: string;
    destination: Destination;
    leaseToken: string;
    nowMs?: number;
  }): Promise<boolean> {
    const nowMs = args.nowMs ?? now();
    return await this.withConversationMutation(
      args.conversationId,
      async () => {
        const current = await this.getConversation({
          conversationId: args.conversationId,
        });
        if (!current || current.execution.lease?.token !== args.leaseToken) {
          return false;
        }
        assertSameConversationDestination({
          conversationId: args.conversationId,
          current: current.destination,
          next: args.destination,
        });
        await this.upsertConversation({
          conversation: {
            ...current,
            updatedAtMs: nowMs,
            execution: {
              ...current.execution,
              status: "awaiting_resume",
              updatedAtMs: nowMs,
            },
          },
        });
        return true;
      },
    );
  }

  async releaseConversationWork(args: {
    conversationId: string;
    leaseToken: string;
    nowMs?: number;
  }): Promise<boolean> {
    const nowMs = args.nowMs ?? now();
    return await this.withConversationMutation(
      args.conversationId,
      async () => {
        const current = await this.getConversation({
          conversationId: args.conversationId,
        });
        if (!current || current.execution.lease?.token !== args.leaseToken) {
          return false;
        }
        await this.upsertConversation({
          conversation: {
            ...current,
            updatedAtMs: nowMs,
            execution: {
              ...current.execution,
              lease: undefined,
              status:
                current.execution.status === "running"
                  ? "pending"
                  : current.execution.status,
              updatedAtMs: nowMs,
            },
          },
        });
        return true;
      },
    );
  }

  async completeConversationWork(args: {
    conversationId: string;
    leaseToken: string;
    nowMs?: number;
  }): Promise<"completed" | "lost_lease" | "pending"> {
    const nowMs = args.nowMs ?? now();
    return await this.withConversationMutation(
      args.conversationId,
      async () => {
        const current = await this.getConversation({
          conversationId: args.conversationId,
        });
        if (!current || current.execution.lease?.token !== args.leaseToken) {
          return "lost_lease";
        }
        const pending = current.execution.pendingMessages.length > 0;
        const continuation = current.execution.status === "awaiting_resume";
        const runnable = pending || continuation;
        await this.upsertConversation({
          conversation: {
            ...current,
            updatedAtMs: nowMs,
            execution: {
              ...current.execution,
              lease: undefined,
              status: runnable ? "pending" : "idle",
              runId: runnable ? current.execution.runId : undefined,
              updatedAtMs: nowMs,
            },
          },
        });
        return runnable ? "pending" : "completed";
      },
    );
  }

  async markConversationWorkEnqueued(args: {
    conversationId: string;
    nowMs?: number;
  }): Promise<void> {
    const nowMs = args.nowMs ?? now();
    await this.withConversationMutation(args.conversationId, async () => {
      const current = await this.getConversation({
        conversationId: args.conversationId,
      });
      if (!current) {
        return;
      }
      await this.upsertConversation({
        conversation: {
          ...current,
          updatedAtMs: nowMs,
          execution: {
            ...current.execution,
            lastEnqueuedAtMs: nowMs,
            updatedAtMs: nowMs,
          },
        },
      });
    });
  }

  async clearExpiredConversationLease(args: {
    conversationId: string;
    nowMs?: number;
  }): Promise<boolean> {
    const nowMs = args.nowMs ?? now();
    return await this.withConversationMutation(
      args.conversationId,
      async () => {
        const current = await this.getConversation({
          conversationId: args.conversationId,
        });
        if (
          !current?.execution.lease ||
          current.execution.lease.expiresAtMs > nowMs
        ) {
          return false;
        }
        await this.upsertConversation({
          conversation: {
            ...current,
            updatedAtMs: nowMs,
            execution: {
              ...current.execution,
              lease: undefined,
              status: "pending",
              updatedAtMs: nowMs,
            },
          },
        });
        return true;
      },
    );
  }

  async removeActiveConversation(): Promise<void> {}

  /** Copy one conversation record into SQL during metadata backfill. */
  async backfillConversation(conversation: Conversation): Promise<void> {
    await this.withConversationMutation(
      conversation.conversationId,
      async () => {
        const existing = await this.getConversation({
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
        if (!refreshExecutionFromSource) {
          return;
        }
        const pendingIds = new Set(
          conversation.execution.pendingMessages.map(
            (message) => message.inboundMessageId,
          ),
        );
        for (const message of conversation.execution.pendingMessages) {
          await this.upsertInboundMessage(message);
        }
        for (const inboundMessageId of conversation.execution
          .inboundMessageIds) {
          if (!pendingIds.has(inboundMessageId)) {
            await this.upsertSeenInboundMessage({
              conversation: mergedConversation,
              inboundMessageId,
            });
          }
        }
      },
    );
  }

  async listConversationsByActivity(
    args: {
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Conversation[]> {
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversations)
      .orderBy(
        desc(juniorConversations.lastActivityAt),
        asc(juniorConversations.conversationId),
      )
      .limit(Math.max(0, args.limit ?? 10_000))
      .offset(Math.max(0, args.offset ?? 0));
    const conversations: Conversation[] = [];
    for (const row of rows) {
      conversations.push(
        conversationFromRows(
          row,
          await this.readInboundRows(row.conversationId),
        ),
      );
    }
    return conversations;
  }

  async listActiveConversationIds(
    args: {
      limit?: number;
      staleBeforeMs?: number;
    } = {},
  ): Promise<string[]> {
    const executionUpdatedAt = sql<Date>`coalesce(${juniorConversations.executionUpdatedAt}, ${juniorConversations.updatedAt})`;
    const rows = await this.executor
      .db()
      .select({ conversationId: juniorConversations.conversationId })
      .from(juniorConversations)
      .where(
        and(
          ne(juniorConversations.executionStatus, "idle"),
          args.staleBeforeMs === undefined
            ? undefined
            : lte(executionUpdatedAt, dateFromMs(args.staleBeforeMs)),
        ),
      )
      .orderBy(asc(executionUpdatedAt), asc(juniorConversations.conversationId))
      .limit(Math.max(0, args.limit ?? 10_000));
    return rows.map((row) => row.conversationId);
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
  ): Promise<ConversationRow | undefined> {
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, conversationId));
    return rows[0];
  }

  private async readInboundRows(
    conversationId: string,
  ): Promise<InboundMessageRow[]> {
    return await this.executor
      .db()
      .select()
      .from(juniorConversationInboundMessages)
      .where(
        eq(juniorConversationInboundMessages.conversationId, conversationId),
      )
      .orderBy(
        asc(juniorConversationInboundMessages.createdAt),
        asc(juniorConversationInboundMessages.receivedAt),
        asc(juniorConversationInboundMessages.inboundMessageId),
      );
  }

  /** Upsert the conversation row while preserving previously discovered nullable metadata fields. */
  private async upsertConversation(args: {
    conversation: Conversation;
  }): Promise<void> {
    const { conversation } = args;
    const lease = conversation.execution.lease;
    const destinationId = await this.upsertDestination(
      destinationUpsertFromDestination({
        channelName: conversation.channelName,
        conversationId: conversation.conversationId,
        destination: conversation.destination,
      }),
      conversation.updatedAtMs,
    );
    const requesterIdentityId = await this.upsertIdentity(
      identityFromRequester(conversation.requester),
      conversation.updatedAtMs,
    );
    const actorIdentityId = await this.upsertIdentity(
      actorIdentityForConversation(conversation),
      conversation.updatedAtMs,
    );
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
        actorIdentityId: actorIdentityId ?? null,
        requesterIdentityId: requesterIdentityId ?? null,
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
        leaseToken: lease?.token ?? null,
        leaseAcquiredAt: lease ? dateFromMs(lease.acquiredAtMs) : null,
        leaseLastCheckInAt: lease ? dateFromMs(lease.lastCheckInAtMs) : null,
        leaseExpiresAt: lease ? dateFromMs(lease.expiresAtMs) : null,
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
          lastActivityAt: sql`greatest(${juniorConversations.lastActivityAt}, excluded.last_activity_at)`,
          updatedAt: sql`excluded.updated_at`,
          executionUpdatedAt: sql`excluded.execution_updated_at`,
          executionStatus: sql`excluded.execution_status`,
          runId: sql`excluded.run_id`,
          lastCheckpointAt: sql`excluded.last_checkpoint_at`,
          lastEnqueuedAt: sql`excluded.last_enqueued_at`,
          leaseToken: sql`excluded.lease_token`,
          leaseAcquiredAt: sql`excluded.lease_acquired_at`,
          leaseLastCheckInAt: sql`excluded.lease_last_check_in_at`,
          leaseExpiresAt: sql`excluded.lease_expires_at`,
        },
      });
  }

  private async upsertIdentity(
    identity: IdentityUpsert | undefined,
    nowMs: number,
  ): Promise<string | undefined> {
    if (!identity) {
      return undefined;
    }
    const rows = await this.executor
      .db()
      .insert(juniorIdentities)
      .values({
        id: randomUUID(),
        kind: identity.kind,
        provider: identity.provider,
        providerTenantId: tenantId(identity.providerTenantId),
        providerSubjectId: identity.providerSubjectId,
        displayName: identity.displayName ?? null,
        handle: identity.handle ?? null,
        email: identity.email ?? null,
        avatarUrl: null,
        metadata: identity.metadata ?? null,
        createdAt: dateFromMs(nowMs),
        updatedAt: dateFromMs(nowMs),
      })
      .onConflictDoUpdate({
        target: [
          juniorIdentities.provider,
          juniorIdentities.providerTenantId,
          juniorIdentities.providerSubjectId,
        ],
        set: {
          kind: sql`excluded.kind`,
          displayName: sql`coalesce(excluded.display_name, ${juniorIdentities.displayName})`,
          handle: sql`coalesce(excluded.handle, ${juniorIdentities.handle})`,
          email: sql`coalesce(excluded.email, ${juniorIdentities.email})`,
          avatarUrl: sql`coalesce(excluded.avatar_url, ${juniorIdentities.avatarUrl})`,
          metadata: sql`coalesce(excluded.metadata_json, ${juniorIdentities.metadata})`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ id: juniorIdentities.id });
    return rows[0]?.id;
  }

  private async upsertDestination(
    destination: DestinationUpsert | undefined,
    nowMs: number,
  ): Promise<string | undefined> {
    if (!destination) {
      return undefined;
    }
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
          visibility: sql`excluded.visibility`,
          metadata: sql`coalesce(excluded.metadata_json, ${juniorDestinations.metadata})`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ id: juniorDestinations.id });
    return rows[0]?.id;
  }

  private async upsertInboundMessage(message: InboundMessage): Promise<void> {
    const destinationId = await this.upsertDestination(
      destinationUpsertFromDestination({
        conversationId: message.conversationId,
        destination: message.destination,
      }),
      message.receivedAtMs,
    );
    if (!destinationId) {
      throw new Error("Inbound conversation metadata destination is invalid");
    }
    await this.executor
      .db()
      .insert(juniorConversationInboundMessages)
      .values({
        conversationId: message.conversationId,
        inboundMessageId: message.inboundMessageId,
        source: message.source,
        destinationId,
        destination: message.destination,
        input: message.input,
        inputTextLength: inputTextLength(message.input),
        attachmentCount: attachmentCount(message.input),
        createdAt: dateFromMs(message.createdAtMs),
        receivedAt: dateFromMs(message.receivedAtMs),
        injectedAt:
          message.injectedAtMs === undefined
            ? null
            : dateFromMs(message.injectedAtMs),
      })
      .onConflictDoUpdate({
        target: [
          juniorConversationInboundMessages.conversationId,
          juniorConversationInboundMessages.inboundMessageId,
        ],
        set: {
          source: sql`excluded.source`,
          destinationId: sql`excluded.destination_id`,
          destination: sql`excluded.destination_json`,
          input: sql`coalesce(${juniorConversationInboundMessages.input}, excluded.input_json)`,
          inputTextLength: sql`excluded.input_text_length`,
          attachmentCount: sql`excluded.attachment_count`,
          createdAt: sql`excluded.created_at`,
          receivedAt: sql`excluded.received_at`,
          injectedAt: sql`coalesce(${juniorConversationInboundMessages.injectedAt}, excluded.injected_at)`,
        },
      });
  }

  /** Record an already-injected inbound id for dedupe without retaining input. */
  private async upsertSeenInboundMessage(args: {
    conversation: Conversation;
    inboundMessageId: string;
  }): Promise<void> {
    const destination = args.conversation.destination;
    if (!destination) {
      return;
    }
    const eventAtMs =
      args.conversation.execution.updatedAtMs ?? args.conversation.updatedAtMs;
    const destinationId = await this.upsertDestination(
      destinationUpsertFromDestination({
        channelName: args.conversation.channelName,
        conversationId: args.conversation.conversationId,
        destination,
      }),
      eventAtMs,
    );
    if (!destinationId) {
      throw new Error("Seen conversation metadata destination is invalid");
    }
    await this.executor
      .db()
      .insert(juniorConversationInboundMessages)
      .values({
        conversationId: args.conversation.conversationId,
        inboundMessageId: args.inboundMessageId,
        source: args.conversation.source ?? "internal",
        destinationId,
        destination,
        input: null,
        inputTextLength: 0,
        attachmentCount: 0,
        createdAt: dateFromMs(eventAtMs),
        receivedAt: dateFromMs(eventAtMs),
        injectedAt: dateFromMs(eventAtMs),
      })
      .onConflictDoNothing();
  }
}

/** Create a SQL-backed conversation metadata store. */
export function createSqlStore(executor: JuniorSqlMigrationExecutor): SqlStore {
  return new SqlStore(executor, executor);
}
