import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversationEvents, juniorPendingDeliveries } from "@/db/schema";
import { sanitizePostgresJson } from "@/db/postgres-json";
import { buildDeterministicAssistantMessageId } from "@/chat/state/turn-id";
import {
  conversationDeliveryFailureCodeSchema,
  conversationDeliveryIdSchema,
  pendingConversationDeliveryCommandSchema,
  pendingConversationDeliveryPartStatesSchema,
  type PendingConversationDeliveryCommand,
  type PendingConversationDeliveryPartState,
} from "../delivery";
import { conversationEventDataSchema } from "../history";
import { ensureConversationRow } from "./conversation-row";
import { withConversationEventLock } from "./event-lock";

type PendingDeliveryRow = typeof juniorPendingDeliveries.$inferSelect;

const leaseOwnerSchema = z.string().min(1).max(160);
const partIdSchema = z.string().min(1).max(160);

/** A fenced claim that must accompany every delivery-state mutation. */
export interface PendingDeliveryLease {
  owner: string;
  version: number;
  expiresAtMs: number;
}

/** Validated unresolved delivery control state. */
export interface PendingConversationDelivery {
  deliveryId: string;
  conversationId: string;
  turnId: string;
  command: PendingConversationDeliveryCommand;
  partStates: Record<string, PendingConversationDeliveryPartState>;
  nextPartIndex: number;
  attemptCount: number;
  nextAttemptAtMs: number;
  lease?: PendingDeliveryLease;
  lastAttemptAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Canonical turn-terminal interpretation after outbox finalization commits. */
export interface PendingDeliveryTerminalOutcome {
  deliveryOutcome: "accepted" | "failed";
  modelSucceeded: boolean;
}

/** Raised when a stale worker tries to mutate state after losing its fence. */
export class PendingDeliveryLeaseLostError extends Error {
  constructor() {
    super("Pending delivery lease is no longer valid");
    this.name = "PendingDeliveryLeaseLostError";
  }
}

function initialPartStates(
  command: PendingConversationDeliveryCommand,
): Record<string, PendingConversationDeliveryPartState> {
  return Object.fromEntries(
    command.parts.map((part) => [part.partId, { status: "pending" as const }]),
  );
}

function nextPartIndex(
  command: PendingConversationDeliveryCommand,
  states: Record<string, PendingConversationDeliveryPartState>,
): number {
  const index = command.parts.findIndex(
    (part) => states[part.partId]?.status !== "accepted",
  );
  return index === -1 ? command.parts.length : index;
}

function parseRow(row: PendingDeliveryRow): PendingConversationDelivery {
  const command = pendingConversationDeliveryCommandSchema.parse(row.command);
  const partStates = pendingConversationDeliveryPartStatesSchema.parse(
    row.partStates,
  );
  const expectedPartIds = command.parts.map((part) => part.partId).sort();
  if (!isDeepStrictEqual(Object.keys(partStates).sort(), expectedPartIds)) {
    throw new Error("Pending delivery part state does not match its command");
  }
  if (
    row.messageId !== command.completion.assistantMessage.messageId ||
    row.provider !== command.provider ||
    row.deliveryKind !== command.deliveryKind
  ) {
    throw new Error("Pending delivery columns do not match its command");
  }
  if ((row.leaseOwner === null) !== (row.leaseExpiresAt === null)) {
    throw new Error("Pending delivery has a partial lease");
  }
  return {
    deliveryId: conversationDeliveryIdSchema.parse(row.deliveryId),
    conversationId: row.conversationId,
    turnId: row.turnId,
    command,
    partStates,
    nextPartIndex: row.nextPartIndex,
    attemptCount: row.attemptCount,
    nextAttemptAtMs: row.nextAttemptAt.getTime(),
    ...(row.leaseOwner && row.leaseExpiresAt
      ? {
          lease: {
            owner: row.leaseOwner,
            version: row.leaseVersion,
            expiresAtMs: row.leaseExpiresAt.getTime(),
          },
        }
      : {}),
    ...(row.lastAttemptAt
      ? { lastAttemptAtMs: row.lastAttemptAt.getTime() }
      : {}),
    createdAtMs: row.createdAt.getTime(),
    updatedAtMs: row.updatedAt.getTime(),
  };
}

function validateTime(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

async function lockedRow(
  executor: JuniorSqlDatabase,
  deliveryId: string,
): Promise<PendingDeliveryRow | undefined> {
  const rows = await executor
    .db()
    .select()
    .from(juniorPendingDeliveries)
    .where(eq(juniorPendingDeliveries.deliveryId, deliveryId))
    .for("update");
  return rows[0];
}

function requireFence(
  row: PendingDeliveryRow,
  lease: PendingDeliveryLease,
  nowMs: number,
): void {
  if (
    row.leaseOwner !== lease.owner ||
    row.leaseVersion !== lease.version ||
    row.leaseExpiresAt === null ||
    row.leaseExpiresAt.getTime() !== lease.expiresAtMs ||
    row.leaseExpiresAt.getTime() <= nowMs
  ) {
    throw new PendingDeliveryLeaseLostError();
  }
}

/** Create or validate immutable unresolved delivery control state. */
export async function createPendingConversationDelivery(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    turnId: string;
    deliveryId: string;
    command: PendingConversationDeliveryCommand;
    nowMs: number;
  },
): Promise<PendingConversationDelivery> {
  const deliveryId = conversationDeliveryIdSchema.parse(args.deliveryId);
  const command = pendingConversationDeliveryCommandSchema.parse(args.command);
  const nowMs = validateTime(args.nowMs, "nowMs");
  if (!args.conversationId || !args.turnId) {
    throw new Error("Pending delivery requires conversation and turn ids");
  }
  if (command.completion.turnId !== args.turnId) {
    throw new Error("Pending delivery command turn does not match its row");
  }
  return withConversationEventLock(executor, args.conversationId, async () =>
    executor.transaction(async () => {
      await ensureConversationRow(executor, args.conversationId, nowMs);
      if (
        await turnTerminalOutcome(
          executor,
          args.conversationId,
          args.turnId,
          true,
        )
      ) {
        throw new Error("Delivery is already terminalized");
      }
      await executor
        .db()
        .insert(juniorPendingDeliveries)
        .values({
          deliveryId,
          conversationId: args.conversationId,
          turnId: args.turnId,
          messageId: command.completion.assistantMessage.messageId,
          provider: command.provider,
          deliveryKind: command.deliveryKind,
          command: sanitizePostgresJson(command),
          partStates: sanitizePostgresJson(initialPartStates(command)),
          nextAttemptAt: new Date(nowMs),
          createdAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
        })
        .onConflictDoNothing();
      const rows = await executor
        .db()
        .select()
        .from(juniorPendingDeliveries)
        .where(
          and(
            eq(juniorPendingDeliveries.conversationId, args.conversationId),
            eq(juniorPendingDeliveries.turnId, args.turnId),
          ),
        );
      const existing = rows[0];
      if (!existing) throw new Error("Pending delivery insert was lost");
      const parsed = parseRow(existing);
      if (
        parsed.deliveryId !== deliveryId ||
        !isDeepStrictEqual(parsed.command, command)
      ) {
        throw new Error("Turn already has a different pending delivery");
      }
      return parsed;
    }),
  );
}

/** Load unresolved control state by its deterministic conversation turn. */
export async function loadPendingDeliveryByTurn(
  executor: JuniorSqlDatabase,
  args: { conversationId: string; turnId: string },
): Promise<PendingConversationDelivery | undefined> {
  const rows = await executor
    .db()
    .select()
    .from(juniorPendingDeliveries)
    .where(
      and(
        eq(juniorPendingDeliveries.conversationId, args.conversationId),
        eq(juniorPendingDeliveries.turnId, args.turnId),
      ),
    );
  return rows[0] ? parseRow(rows[0]) : undefined;
}

/** Load the oldest unresolved delivery so newer input cannot bypass it. */
export async function loadOldestPendingDeliveryByConversation(
  executor: JuniorSqlDatabase,
  args: { conversationId: string },
): Promise<PendingConversationDelivery | undefined> {
  const rows = await executor
    .db()
    .select()
    .from(juniorPendingDeliveries)
    .where(eq(juniorPendingDeliveries.conversationId, args.conversationId))
    .orderBy(
      asc(juniorPendingDeliveries.createdAt),
      asc(juniorPendingDeliveries.deliveryId),
    )
    .limit(1);
  return rows[0] ? parseRow(rows[0]) : undefined;
}

/** Claim a due delivery; stale `posting` parts become uncertain, never pending. */
export async function claimPendingConversationDelivery(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    leaseOwner: string;
    nowMs: number;
    leaseDurationMs: number;
  },
): Promise<PendingConversationDelivery | undefined> {
  const deliveryId = conversationDeliveryIdSchema.parse(args.deliveryId);
  const owner = leaseOwnerSchema.parse(args.leaseOwner);
  const nowMs = validateTime(args.nowMs, "nowMs");
  if (!Number.isFinite(args.leaseDurationMs) || args.leaseDurationMs <= 0) {
    throw new Error("leaseDurationMs must be positive");
  }
  return executor.transaction(async () => {
    const row = await lockedRow(executor, deliveryId);
    if (
      !row ||
      row.nextAttemptAt.getTime() > nowMs ||
      (row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > nowMs)
    ) {
      return undefined;
    }
    const current = parseRow(row);
    const partStates = Object.fromEntries(
      Object.entries(current.partStates).map(([partId, state]) => [
        partId,
        state.status === "posting"
          ? {
              status: "uncertain" as const,
              attemptedAtMs: state.startedAtMs,
              retryAtMs: nowMs,
              reconciliationAttempt: 0,
            }
          : state,
      ]),
    );
    const expiresAtMs = nowMs + args.leaseDurationMs;
    const rows = await executor
      .db()
      .update(juniorPendingDeliveries)
      .set({
        partStates: sanitizePostgresJson(partStates),
        leaseOwner: owner,
        leaseVersion: row.leaseVersion + 1,
        leaseExpiresAt: new Date(expiresAtMs),
        attemptCount: row.attemptCount + 1,
        lastAttemptAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      })
      .where(eq(juniorPendingDeliveries.deliveryId, deliveryId))
      .returning();
    return rows[0] ? parseRow(rows[0]) : undefined;
  });
}

/** Extend an unexpired claim without changing its fencing version. */
export async function renewPendingDeliveryLease(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
    leaseDurationMs: number;
  },
): Promise<PendingDeliveryLease> {
  const deliveryId = conversationDeliveryIdSchema.parse(args.deliveryId);
  const nowMs = validateTime(args.nowMs, "nowMs");
  if (!Number.isFinite(args.leaseDurationMs) || args.leaseDurationMs <= 0) {
    throw new Error("leaseDurationMs must be positive");
  }
  const expiresAtMs = nowMs + args.leaseDurationMs;
  const rows = await executor
    .db()
    .update(juniorPendingDeliveries)
    .set({ leaseExpiresAt: new Date(expiresAtMs), updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(juniorPendingDeliveries.deliveryId, deliveryId),
        eq(juniorPendingDeliveries.leaseOwner, args.lease.owner),
        eq(juniorPendingDeliveries.leaseVersion, args.lease.version),
        gt(juniorPendingDeliveries.leaseExpiresAt, new Date(nowMs)),
      ),
    )
    .returning({ version: juniorPendingDeliveries.leaseVersion });
  if (!rows[0]) throw new PendingDeliveryLeaseLostError();
  return { owner: args.lease.owner, version: rows[0].version, expiresAtMs };
}

/** Release a claim only when its owner and fencing version still match. */
export async function releasePendingDeliveryLease(
  executor: JuniorSqlDatabase,
  args: { deliveryId: string; lease: PendingDeliveryLease; nowMs: number },
): Promise<void> {
  const rows = await executor
    .db()
    .update(juniorPendingDeliveries)
    .set({
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(args.nowMs),
    })
    .where(
      and(
        eq(juniorPendingDeliveries.deliveryId, args.deliveryId),
        eq(juniorPendingDeliveries.leaseOwner, args.lease.owner),
        eq(juniorPendingDeliveries.leaseVersion, args.lease.version),
      ),
    )
    .returning({ deliveryId: juniorPendingDeliveries.deliveryId });
  if (!rows[0]) throw new PendingDeliveryLeaseLostError();
}

async function mutateClaimedPart(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    partId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
    mutate: (
      state: PendingConversationDeliveryPartState,
    ) => PendingConversationDeliveryPartState;
    nextAttemptAtMs?: number;
    requireCurrentPart?: boolean;
  },
): Promise<PendingConversationDelivery> {
  return executor.transaction(async () => {
    const row = await lockedRow(executor, args.deliveryId);
    if (!row) throw new PendingDeliveryLeaseLostError();
    requireFence(row, args.lease, args.nowMs);
    const current = parseRow(row);
    const partId = partIdSchema.parse(args.partId);
    const state = current.partStates[partId];
    if (!state) throw new Error("Unknown pending delivery part");
    if (
      args.requireCurrentPart &&
      current.command.parts[current.nextPartIndex]?.partId !== partId
    ) {
      throw new Error("Only the current pending delivery part can be posted");
    }
    const partStates = { ...current.partStates, [partId]: args.mutate(state) };
    const rows = await executor
      .db()
      .update(juniorPendingDeliveries)
      .set({
        partStates: sanitizePostgresJson(partStates),
        nextPartIndex: nextPartIndex(current.command, partStates),
        ...(args.nextAttemptAtMs !== undefined
          ? { nextAttemptAt: new Date(args.nextAttemptAtMs) }
          : {}),
        updatedAt: new Date(args.nowMs),
      })
      .where(eq(juniorPendingDeliveries.deliveryId, args.deliveryId))
      .returning();
    if (!rows[0]) throw new PendingDeliveryLeaseLostError();
    return parseRow(rows[0]);
  });
}

/** Durably fence one part as posting before making the external call. */
export async function markPendingDeliveryPartPosting(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    partId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
  },
): Promise<PendingConversationDelivery> {
  return mutateClaimedPart(executor, {
    ...args,
    requireCurrentPart: true,
    mutate: (state) => {
      if (state.status !== "pending") {
        throw new Error(`Cannot post delivery part in ${state.status} state`);
      }
      return { status: "posting", startedAtMs: args.nowMs };
    },
  });
}

/**
 * Return an uncertain part to pending only after reconciliation explicitly
 * confirmed absence and its caller-supplied grace period elapsed.
 */
export async function markPendingDeliveryPartRepostable(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    partId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
    reconciliationAttempt: number;
    confirmedAbsentAtMs: number;
    graceElapsedAtMs: number;
  },
): Promise<PendingConversationDelivery> {
  if (
    !Number.isInteger(args.reconciliationAttempt) ||
    args.reconciliationAttempt <= 0
  ) {
    throw new Error("reconciliationAttempt must be positive");
  }
  if (
    args.confirmedAbsentAtMs > args.nowMs ||
    args.graceElapsedAtMs > args.nowMs ||
    args.graceElapsedAtMs < args.confirmedAbsentAtMs
  ) {
    throw new Error("Repost reconciliation and grace must be complete");
  }
  return mutateClaimedPart(executor, {
    ...args,
    mutate: (state) => {
      if (state.status !== "uncertain") {
        throw new Error(
          `Cannot make delivery part repostable from ${state.status}`,
        );
      }
      if (args.reconciliationAttempt < state.reconciliationAttempt) {
        throw new Error("Repost reconciliation attempt is stale");
      }
      return { status: "pending" };
    },
  });
}

/** Record the provider receipt for a posting or reconciled uncertain part. */
export async function recordPendingDeliveryPartAccepted(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    partId: string;
    lease: PendingDeliveryLease;
    providerMessageId: string;
    nowMs: number;
  },
): Promise<PendingConversationDelivery> {
  const receipt = z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .parse(args.providerMessageId);
  return mutateClaimedPart(executor, {
    ...args,
    mutate: (state) => {
      if (state.status === "accepted") {
        if (state.providerMessageId !== receipt) {
          throw new Error("Delivery part already has a different receipt");
        }
        return state;
      }
      if (state.status !== "posting" && state.status !== "uncertain") {
        throw new Error(`Cannot accept delivery part in ${state.status} state`);
      }
      return {
        status: "accepted",
        providerMessageId: receipt,
        acceptedAtMs: args.nowMs,
      };
    },
  });
}

/** Preserve an ambiguous external result and its pagination/backoff cursor. */
export async function recordPendingDeliveryPartUncertain(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    partId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
    retryAtMs: number;
    reconciliationAttempt: number;
    reconciliationCursor?: string;
    confirmedAbsentAtMs?: number;
  },
): Promise<PendingConversationDelivery> {
  return mutateClaimedPart(executor, {
    ...args,
    nextAttemptAtMs: args.retryAtMs,
    mutate: (state) => {
      if (state.status !== "posting" && state.status !== "uncertain") {
        throw new Error(
          `Cannot make delivery part uncertain from ${state.status}`,
        );
      }
      return pendingConversationDeliveryPartStatesSchema.parse({
        [args.partId]: {
          status: "uncertain",
          attemptedAtMs:
            state.status === "posting"
              ? state.startedAtMs
              : state.attemptedAtMs,
          retryAtMs: args.retryAtMs,
          reconciliationAttempt: args.reconciliationAttempt,
          ...(args.reconciliationCursor
            ? { reconciliationCursor: args.reconciliationCursor }
            : {}),
          ...(args.confirmedAbsentAtMs !== undefined
            ? { confirmedAbsentAtMs: args.confirmedAbsentAtMs }
            : state.status === "uncertain" &&
                state.confirmedAbsentAtMs !== undefined
              ? { confirmedAbsentAtMs: state.confirmedAbsentAtMs }
              : {}),
        },
      })[args.partId]!;
    },
  });
}

/** Return a definitely absent transient provider rejection to pending. */
export async function recordPendingDeliveryPartRetryable(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    partId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
    retryAtMs: number;
  },
): Promise<PendingConversationDelivery> {
  return mutateClaimedPart(executor, {
    ...args,
    nextAttemptAtMs: args.retryAtMs,
    mutate: (state) => {
      if (state.status !== "posting") {
        throw new Error(`Cannot retry delivery part in ${state.status} state`);
      }
      return { status: "pending" };
    },
  });
}

/** Record a privacy-safe definitive part failure under the active fence. */
export async function recordPendingDeliveryPartFailed(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    partId: string;
    lease: PendingDeliveryLease;
    failureCode: z.output<typeof conversationDeliveryFailureCodeSchema>;
    nowMs: number;
  },
): Promise<PendingConversationDelivery> {
  const failureCode = conversationDeliveryFailureCodeSchema.parse(
    args.failureCode,
  );
  return mutateClaimedPart(executor, {
    ...args,
    mutate: (state) => {
      if (state.status !== "posting" && state.status !== "uncertain") {
        throw new Error(`Cannot fail delivery part in ${state.status} state`);
      }
      return { status: "failed", failureCode, failedAtMs: args.nowMs };
    },
  });
}

async function canonicalEventByKey(
  executor: JuniorSqlDatabase,
  conversationId: string,
  idempotencyKey: string,
) {
  const rows = await executor
    .db()
    .select({
      type: juniorConversationEvents.type,
      payload: juniorConversationEvents.payload,
    })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.idempotencyKey, idempotencyKey),
      ),
    );
  const row = rows[0];
  return row
    ? conversationEventDataSchema.parse({ ...row.payload, type: row.type })
    : undefined;
}

async function turnTerminalOutcome(
  executor: JuniorSqlDatabase,
  conversationId: string,
  turnId: string,
  knownIntent: boolean,
): Promise<PendingDeliveryTerminalOutcome | undefined> {
  const fact = await canonicalEventByKey(
    executor,
    conversationId,
    `turn:${turnId}:terminal`,
  );
  if (!fact) return undefined;
  if (fact.type !== "turn_completed" && fact.type !== "turn_failed") {
    throw new Error(
      "Turn terminal idempotency key has an unexpected event type",
    );
  }
  if (fact.turnId !== turnId) {
    throw new Error("Turn terminal idempotency key has conflicting data");
  }
  if (fact.type === "turn_failed" && fact.failureCode === "delivery_failed") {
    return { deliveryOutcome: "failed", modelSucceeded: false };
  }
  if (!knownIntent) {
    const assistantMessageId = buildDeterministicAssistantMessageId(turnId);
    const visibleAssistant = await canonicalEventByKey(
      executor,
      conversationId,
      `visible-message:${assistantMessageId}:recorded`,
    );
    if (!visibleAssistant) return undefined;
    if (
      visibleAssistant.type !== "visible_message_recorded" ||
      visibleAssistant.messageId !== assistantMessageId ||
      visibleAssistant.role !== "assistant"
    ) {
      throw new Error(
        "Finalized assistant idempotency key has conflicting data",
      );
    }
  }
  return {
    deliveryOutcome: "accepted",
    modelSucceeded: fact.type === "turn_completed",
  };
}

/** Interpret the authoritative turn terminal after an ambiguous SQL commit. */
export async function loadDeliveryTerminalOutcome(
  executor: JuniorSqlDatabase,
  args: { conversationId: string; turnId: string; knownIntent?: boolean },
): Promise<PendingDeliveryTerminalOutcome | undefined> {
  return turnTerminalOutcome(
    executor,
    args.conversationId,
    args.turnId,
    args.knownIntent ?? false,
  );
}

/**
 * Run accepted-delivery persistence and delete control state in one transaction.
 * A retry after commit resolves the canonical turn terminal instead.
 */
export async function terminalizeAcceptedPendingDelivery(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    deliveryId: string;
    turnId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
    finalizer: (input: {
      command: PendingConversationDeliveryCommand;
    }) => Promise<void>;
  },
): Promise<"finalized" | "already_finalized" | "not_found"> {
  return withConversationEventLock(executor, args.conversationId, async () =>
    executor.transaction(async () => {
      const row = await lockedRow(executor, args.deliveryId);
      if (!row) {
        const terminal = await turnTerminalOutcome(
          executor,
          args.conversationId,
          args.turnId,
          true,
        );
        return terminal?.deliveryOutcome === "accepted"
          ? "already_finalized"
          : "not_found";
      }
      requireFence(row, args.lease, args.nowMs);
      const current = parseRow(row);
      if (
        current.conversationId !== args.conversationId ||
        current.turnId !== args.turnId
      ) {
        throw new Error("Pending delivery belongs to a different conversation");
      }
      current.command.parts.forEach((part) => {
        const state = current.partStates[part.partId];
        if (state?.status !== "accepted") {
          throw new Error("Cannot terminalize before every part is accepted");
        }
      });
      if (
        await turnTerminalOutcome(
          executor,
          args.conversationId,
          args.turnId,
          true,
        )
      ) {
        throw new Error(
          "Pending delivery conflicts with an existing turn terminal",
        );
      }
      await args.finalizer({ command: current.command });
      const terminal = await canonicalEventByKey(
        executor,
        args.conversationId,
        `turn:${args.turnId}:terminal`,
      );
      const expected = current.command.completion.terminal;
      const matchesExpected =
        expected.outcome === "success"
          ? terminal?.type === "turn_completed" &&
            terminal.turnId === args.turnId &&
            terminal.outcome === "success"
          : terminal?.type === "turn_failed" &&
            terminal.turnId === args.turnId &&
            terminal.failureCode === expected.failureCode &&
            terminal.eventId === expected.eventId;
      if (!matchesExpected) {
        throw new Error(
          "Accepted delivery finalizer did not write the expected turn terminal",
        );
      }
      const deleted = await executor
        .db()
        .delete(juniorPendingDeliveries)
        .where(
          and(
            eq(juniorPendingDeliveries.deliveryId, args.deliveryId),
            eq(juniorPendingDeliveries.leaseOwner, args.lease.owner),
            eq(juniorPendingDeliveries.leaseVersion, args.lease.version),
          ),
        )
        .returning({ deliveryId: juniorPendingDeliveries.deliveryId });
      if (!deleted[0]) throw new PendingDeliveryLeaseLostError();
      return "finalized";
    }),
  );
}

/**
 * Run failure persistence and delete control state in one transaction. Only a
 * part already marked definitively failed can close.
 */
export async function terminalizeFailedPendingDelivery(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    deliveryId: string;
    turnId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
    finalizer: (input: {
      command: PendingConversationDeliveryCommand;
      failureCode: z.output<typeof conversationDeliveryFailureCodeSchema>;
    }) => Promise<void>;
  },
): Promise<"finalized" | "already_finalized" | "not_found"> {
  return withConversationEventLock(executor, args.conversationId, async () =>
    executor.transaction(async () => {
      const row = await lockedRow(executor, args.deliveryId);
      if (!row) {
        const terminal = await turnTerminalOutcome(
          executor,
          args.conversationId,
          args.turnId,
          true,
        );
        return terminal?.deliveryOutcome === "failed"
          ? "already_finalized"
          : "not_found";
      }
      requireFence(row, args.lease, args.nowMs);
      const current = parseRow(row);
      if (
        current.conversationId !== args.conversationId ||
        current.turnId !== args.turnId
      ) {
        throw new Error("Pending delivery belongs to a different conversation");
      }
      const failedStates = Object.values(current.partStates).filter(
        (
          state,
        ): state is Extract<
          PendingConversationDeliveryPartState,
          { status: "failed" }
        > => state.status === "failed",
      );
      const failureCode = failedStates[0]?.failureCode;
      if (!failureCode) {
        throw new Error(
          "Cannot terminalize failure without a definitively failed part",
        );
      }
      if (failedStates.some((state) => state.failureCode !== failureCode)) {
        throw new Error(
          "Pending delivery parts have conflicting failure codes",
        );
      }
      if (
        await turnTerminalOutcome(
          executor,
          args.conversationId,
          args.turnId,
          true,
        )
      ) {
        throw new Error(
          "Pending delivery conflicts with an existing turn terminal",
        );
      }
      await args.finalizer({ command: current.command, failureCode });
      const terminal = await canonicalEventByKey(
        executor,
        args.conversationId,
        `turn:${args.turnId}:terminal`,
      );
      if (
        terminal?.type !== "turn_failed" ||
        terminal.turnId !== args.turnId ||
        terminal.failureCode !== "delivery_failed"
      ) {
        throw new Error(
          "Failed delivery finalizer did not write the expected turn terminal",
        );
      }
      const deleted = await executor
        .db()
        .delete(juniorPendingDeliveries)
        .where(
          and(
            eq(juniorPendingDeliveries.deliveryId, args.deliveryId),
            eq(juniorPendingDeliveries.leaseOwner, args.lease.owner),
            eq(juniorPendingDeliveries.leaseVersion, args.lease.version),
          ),
        )
        .returning({ deliveryId: juniorPendingDeliveries.deliveryId });
      if (!deleted[0]) throw new PendingDeliveryLeaseLostError();
      return "finalized";
    }),
  );
}
