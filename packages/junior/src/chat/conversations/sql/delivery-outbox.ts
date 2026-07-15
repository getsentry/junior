import { isDeepStrictEqual } from "node:util";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversationEvents, juniorPendingDeliveries } from "@/db/schema";
import { sanitizePostgresJson } from "@/db/postgres-json";
import { buildDeterministicAssistantMessageId } from "@/chat/state/turn-id";
import {
  conversationDeliveryFailureCodeSchema,
  conversationDeliveryIdSchema,
  pendingConversationDeliveryCommandSchema,
  pendingConversationDeliveryProgressSchema,
  type PendingConversationDeliveryCommand,
  type PendingConversationDeliveryProgress,
} from "../delivery";
import { conversationEventDataSchema } from "../history";
import { ensureConversationRow } from "./conversation-row";
import { withConversationEventLock } from "./event-lock";

type PendingDeliveryRow = typeof juniorPendingDeliveries.$inferSelect;

const leaseOwnerSchema = z.string().min(1).max(160);

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
  progress: PendingConversationDeliveryProgress;
  nextPartIndex: number;
  nextAttemptAtMs: number;
  lease?: PendingDeliveryLease;
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

function initialProgress(): PendingConversationDeliveryProgress {
  return { acceptedReceipts: [], currentState: { status: "pending" } };
}

function parseRow(row: PendingDeliveryRow): PendingConversationDelivery {
  const command = pendingConversationDeliveryCommandSchema.parse(row.command);
  const progress = pendingConversationDeliveryProgressSchema.parse(
    row.progress,
  );
  if (progress.acceptedReceipts.length > command.parts.length) {
    throw new Error("Pending delivery progress exceeds its command");
  }
  if (
    progress.acceptedReceipts.length === command.parts.length &&
    progress.currentState.status !== "pending"
  ) {
    throw new Error("Completed delivery progress has an active current state");
  }
  if ((row.leaseOwner === null) !== (row.leaseExpiresAt === null)) {
    throw new Error("Pending delivery has a partial lease");
  }
  return {
    deliveryId: conversationDeliveryIdSchema.parse(row.deliveryId),
    conversationId: row.conversationId,
    turnId: row.turnId,
    command,
    progress,
    nextPartIndex: progress.acceptedReceipts.length,
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
          command: sanitizePostgresJson(command),
          progress: sanitizePostgresJson(initialProgress()),
          nextAttemptAt: new Date(nowMs),
        })
        .onConflictDoNothing();
      const rows = await executor
        .db()
        .select()
        .from(juniorPendingDeliveries)
        .where(eq(juniorPendingDeliveries.conversationId, args.conversationId));
      const existing = rows[0];
      if (!existing) throw new Error("Pending delivery insert was lost");
      const parsed = parseRow(existing);
      if (
        parsed.deliveryId !== deliveryId ||
        !isDeepStrictEqual(parsed.command, command)
      ) {
        throw new Error(
          "Conversation already has a different pending delivery",
        );
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

/** Load the conversation's only unresolved delivery. */
export async function loadPendingDeliveryByConversation(
  executor: JuniorSqlDatabase,
  args: { conversationId: string },
): Promise<PendingConversationDelivery | undefined> {
  const rows = await executor
    .db()
    .select()
    .from(juniorPendingDeliveries)
    .where(eq(juniorPendingDeliveries.conversationId, args.conversationId))
    .limit(1);
  return rows[0] ? parseRow(rows[0]) : undefined;
}

/** Claim a due delivery; stale `posting` state becomes uncertain, never pending. */
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
    const progress: PendingConversationDeliveryProgress = {
      ...current.progress,
      currentState:
        current.progress.currentState.status === "posting"
          ? {
              status: "uncertain",
              attemptedAtMs: current.progress.currentState.attemptedAtMs,
            }
          : current.progress.currentState,
    };
    const expiresAtMs = nowMs + args.leaseDurationMs;
    const rows = await executor
      .db()
      .update(juniorPendingDeliveries)
      .set({
        progress: sanitizePostgresJson(progress),
        leaseOwner: owner,
        leaseVersion: row.leaseVersion + 1,
        leaseExpiresAt: new Date(expiresAtMs),
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
    .set({ leaseExpiresAt: new Date(expiresAtMs) })
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
  args: { deliveryId: string; lease: PendingDeliveryLease },
): Promise<void> {
  const rows = await executor
    .db()
    .update(juniorPendingDeliveries)
    .set({
      leaseOwner: null,
      leaseExpiresAt: null,
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

async function mutateClaimedProgress(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
    mutate: (
      progress: PendingConversationDeliveryProgress,
    ) => PendingConversationDeliveryProgress;
    nextAttemptAtMs?: number;
  },
): Promise<PendingConversationDelivery> {
  return executor.transaction(async () => {
    const row = await lockedRow(executor, args.deliveryId);
    if (!row) throw new PendingDeliveryLeaseLostError();
    requireFence(row, args.lease, args.nowMs);
    const current = parseRow(row);
    const progress = pendingConversationDeliveryProgressSchema.parse(
      args.mutate(current.progress),
    );
    if (progress.acceptedReceipts.length > current.command.parts.length) {
      throw new Error("Pending delivery progress exceeds its command");
    }
    const rows = await executor
      .db()
      .update(juniorPendingDeliveries)
      .set({
        progress: sanitizePostgresJson(progress),
        ...(args.nextAttemptAtMs !== undefined
          ? { nextAttemptAt: new Date(args.nextAttemptAtMs) }
          : {}),
      })
      .where(eq(juniorPendingDeliveries.deliveryId, args.deliveryId))
      .returning();
    if (!rows[0]) throw new PendingDeliveryLeaseLostError();
    return parseRow(rows[0]);
  });
}

/** Durably mark the current ordered part as posting before the external call. */
export async function markPendingDeliveryPosting(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
  },
): Promise<PendingConversationDelivery> {
  return mutateClaimedProgress(executor, {
    ...args,
    mutate: (progress) => {
      if (progress.currentState.status !== "pending") {
        throw new Error(
          `Cannot post delivery in ${progress.currentState.status} state`,
        );
      }
      return {
        ...progress,
        currentState: { status: "posting", attemptedAtMs: args.nowMs },
      };
    },
  });
}

/**
 * Return an uncertain part to pending only after reconciliation explicitly
 * confirmed absence and its caller-supplied grace period elapsed.
 */
export async function markPendingDeliveryRepostable(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
    graceElapsedAtMs: number;
  },
): Promise<PendingConversationDelivery> {
  return mutateClaimedProgress(executor, {
    ...args,
    mutate: (progress) => {
      const state = progress.currentState;
      if (state.status !== "uncertain") {
        throw new Error(`Cannot make delivery repostable from ${state.status}`);
      }
      if (
        state.confirmedAbsentAtMs === undefined ||
        args.graceElapsedAtMs > args.nowMs ||
        args.graceElapsedAtMs < state.confirmedAbsentAtMs
      ) {
        throw new Error("Repost reconciliation and grace must be complete");
      }
      return { ...progress, currentState: { status: "pending" } };
    },
  });
}

/** Append the provider receipt and advance to the next ordered part. */
export async function recordPendingDeliveryAccepted(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    lease: PendingDeliveryLease;
    providerMessageId: string;
    nowMs: number;
  },
): Promise<PendingConversationDelivery> {
  const receipt = z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .parse(args.providerMessageId);
  return mutateClaimedProgress(executor, {
    ...args,
    mutate: (progress) => {
      const state = progress.currentState;
      if (state.status !== "posting" && state.status !== "uncertain") {
        throw new Error(`Cannot accept delivery in ${state.status} state`);
      }
      return {
        acceptedReceipts: [...progress.acceptedReceipts, receipt],
        currentState: { status: "pending" },
      };
    },
  });
}

/** Preserve an ambiguous external result and its pagination/backoff cursor. */
export async function recordPendingDeliveryUncertain(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
    retryAtMs: number;
    reconciliationCursor?: string;
    confirmedAbsentAtMs?: number;
  },
): Promise<PendingConversationDelivery> {
  return mutateClaimedProgress(executor, {
    ...args,
    nextAttemptAtMs: args.retryAtMs,
    mutate: (progress) => {
      const state = progress.currentState;
      if (state.status !== "posting" && state.status !== "uncertain") {
        throw new Error(`Cannot make delivery uncertain from ${state.status}`);
      }
      return {
        ...progress,
        currentState: {
          status: "uncertain",
          attemptedAtMs: state.attemptedAtMs,
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
      };
    },
  });
}

/** Return a definitely absent transient provider rejection to pending. */
export async function recordPendingDeliveryRetryable(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    lease: PendingDeliveryLease;
    nowMs: number;
    retryAtMs: number;
  },
): Promise<PendingConversationDelivery> {
  return mutateClaimedProgress(executor, {
    ...args,
    nextAttemptAtMs: args.retryAtMs,
    mutate: (progress) => {
      const state = progress.currentState;
      if (state.status !== "posting") {
        throw new Error(`Cannot retry delivery in ${state.status} state`);
      }
      return { ...progress, currentState: { status: "pending" } };
    },
  });
}

/** Record a privacy-safe definitive failure under the active fence. */
export async function recordPendingDeliveryFailed(
  executor: JuniorSqlDatabase,
  args: {
    deliveryId: string;
    lease: PendingDeliveryLease;
    failureCode: z.output<typeof conversationDeliveryFailureCodeSchema>;
    nowMs: number;
  },
): Promise<PendingConversationDelivery> {
  const failureCode = conversationDeliveryFailureCodeSchema.parse(
    args.failureCode,
  );
  return mutateClaimedProgress(executor, {
    ...args,
    mutate: (progress) => {
      const state = progress.currentState;
      if (state.status !== "posting" && state.status !== "uncertain") {
        throw new Error(`Cannot fail delivery in ${state.status} state`);
      }
      return { ...progress, currentState: { status: "failed", failureCode } };
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
      if (
        current.progress.acceptedReceipts.length !==
        current.command.parts.length
      ) {
        throw new Error("Cannot terminalize before every part is accepted");
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
      const currentState = current.progress.currentState;
      if (currentState.status !== "failed") {
        throw new Error(
          "Cannot terminalize failure without a definitive failure",
        );
      }
      const failureCode = currentState.failureCode;
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
