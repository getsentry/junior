import { randomUUID } from "node:crypto";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  claimPendingConversationDelivery,
  createPendingConversationDelivery,
  loadDeliveryTerminalOutcome,
  loadOldestPendingDeliveryByConversation,
  loadPendingDeliveryByTurn,
  markPendingDeliveryPartPosting,
  markPendingDeliveryPartRepostable,
  recordPendingDeliveryPartAccepted,
  recordPendingDeliveryPartFailed,
  recordPendingDeliveryPartRetryable,
  recordPendingDeliveryPartUncertain,
  releasePendingDeliveryLease,
  renewPendingDeliveryLease,
  terminalizeAcceptedPendingDelivery,
  terminalizeFailedPendingDelivery,
  type PendingConversationDelivery,
} from "@/chat/conversations/sql/delivery-outbox";
import {
  pendingConversationDeliveryCommandSchema,
  type PendingConversationDeliveryCommand,
} from "@/chat/conversations/delivery";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { commitMessages } from "@/chat/conversations/projection";
import type { PiMessage } from "@/chat/pi/messages";
import { toStoredConversationMessage } from "@/chat/conversations/visible-message-serializer";
import { and, eq, inArray } from "drizzle-orm";
import {
  juniorConversationEvents,
  juniorConversationMessages,
} from "@/db/schema";
import type {
  RecoverableSlackPostResult,
  RecoverableSlackReconciliationResult,
  SlackDeliveryMetadata,
} from "@/chat/slack/outbound";

const LEASE_DURATION_MS = 120_000;
const RETRY_DELAY_MS = 5_000;
const REPOST_GRACE_MS = 30_000;
const RECONCILIATION_CLOCK_SKEW_MS = 60_000;

export interface RecoverableSlackDeliveryPort {
  post(input: {
    blocks?: PendingConversationDeliveryCommand["parts"][number]["blocks"];
    channelId: string;
    metadata: SlackDeliveryMetadata;
    text: string;
    threadTs: string;
  }): Promise<RecoverableSlackPostResult>;
  reconcile(input: {
    channelId: string;
    cursor?: string;
    metadata: SlackDeliveryMetadata;
    oldestTs: string;
    threadTs: string;
  }): Promise<RecoverableSlackReconciliationResult>;
}

export type RecoverableSlackDeliveryOutcome =
  | { outcome: "accepted" }
  | { outcome: "failed" }
  | { outcome: "pending"; retryAtMs: number };

function oldestSlackTimestamp(attemptedAtMs: number): string {
  const seconds = Math.max(0, Math.floor(attemptedAtMs / 1_000));
  const micros = Math.max(0, attemptedAtMs % 1_000) * 1_000;
  return `${seconds}.${Math.floor(micros).toString().padStart(6, "0")}`;
}

async function finalizeAcceptedSql(
  sql: JuniorSqlDatabase,
  conversationId: string,
  command: PendingConversationDeliveryCommand,
  nowMs: number,
): Promise<void> {
  if (command.completion.model.messages.length > 0) {
    await commitMessages({
      conversationId,
      modelId: command.completion.model.modelId,
      messages: command.completion.model.messages as PiMessage[],
      executor: sql,
    });
  }
  const messages = createSqlConversationMessageStore(sql);
  const baselines = await sql
    .db()
    .select({ messageId: juniorConversationMessages.messageId })
    .from(juniorConversationMessages)
    .where(
      and(
        eq(juniorConversationMessages.conversationId, conversationId),
        inArray(
          juniorConversationMessages.messageId,
          command.completion.inputMessageIds,
        ),
      ),
    );
  if (baselines.length !== command.completion.inputMessageIds.length) {
    throw new Error("Delivery finalization requires every input baseline");
  }
  const assistant = command.completion.assistantMessage;
  await messages.record(conversationId, [
    toStoredConversationMessage({
      id: assistant.messageId,
      role: "assistant",
      text: assistant.text,
      author: assistant.author,
      createdAtMs: assistant.createdAtMs,
      meta: { replied: true },
    }),
  ]);
  for (const inputMessageId of command.completion.inputMessageIds) {
    await messages.markReplied(conversationId, inputMessageId, nowMs);
  }
  const lifecycle = new ConversationTurnLifecycleService(
    createSqlConversationEventStore(sql),
  );
  if (command.completion.terminal.outcome === "success") {
    await lifecycle.complete({
      conversationId,
      turnId: command.completion.turnId,
      createdAtMs: nowMs,
      outcome: "success",
    });
  } else {
    await lifecycle.fail({
      conversationId,
      turnId: command.completion.turnId,
      createdAtMs: nowMs,
      failureCode: command.completion.terminal.failureCode,
      ...(command.completion.terminal.eventId
        ? { eventId: command.completion.terminal.eventId }
        : {}),
    });
  }
}

/** Drives one durable Slack reply without ever rerunning the model. */
export class RecoverableSlackDeliveryService {
  constructor(
    private readonly sql: JuniorSqlDatabase,
    private readonly slack: RecoverableSlackDeliveryPort,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Create or validate the immutable intent for a completed model run. */
  async createIntent(args: {
    conversationId: string;
    deliveryId: string;
    turnId: string;
    command: PendingConversationDeliveryCommand;
  }): Promise<PendingConversationDelivery> {
    return createPendingConversationDelivery(this.sql, {
      ...args,
      command: pendingConversationDeliveryCommandSchema.parse(args.command),
      nowMs: this.now(),
    });
  }

  /** Load unresolved control state before deciding whether Pi may run. */
  async loadByTurn(args: {
    conversationId: string;
    turnId: string;
  }): Promise<PendingConversationDelivery | undefined> {
    return loadPendingDeliveryByTurn(this.sql, args);
  }

  /** Load the oldest unresolved delivery before selecting a newer turn. */
  async loadOldestByConversation(args: {
    conversationId: string;
  }): Promise<PendingConversationDelivery | undefined> {
    return loadOldestPendingDeliveryByConversation(this.sql, args);
  }

  /** Resolve a terminal fact when row deletion or commit acknowledgement was ambiguous. */
  async loadTerminalOutcome(args: {
    conversationId: string;
    deliveryId: string;
  }): Promise<"accepted" | "failed" | undefined> {
    return loadDeliveryTerminalOutcome(this.sql, args);
  }

  /** Resolve the canonical model outcome for a terminal turn without loading its transcript. */
  async loadTurnTerminalOutcome(args: {
    conversationId: string;
    turnId: string;
  }): Promise<"success" | "failed" | undefined> {
    const rows = await this.sql
      .db()
      .select({ type: juniorConversationEvents.type })
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, args.conversationId),
          eq(
            juniorConversationEvents.idempotencyKey,
            `turn:${args.turnId}:terminal`,
          ),
        ),
      )
      .limit(1);
    if (rows[0]?.type === "turn_completed") return "success";
    if (rows[0]?.type === "turn_failed") return "failed";
    return undefined;
  }

  /** Claim and advance one pending delivery until it must defer or terminalizes. */
  async advance(
    pending: PendingConversationDelivery,
  ): Promise<RecoverableSlackDeliveryOutcome> {
    const nowMs = this.now();
    const claimed = await claimPendingConversationDelivery(this.sql, {
      deliveryId: pending.deliveryId,
      leaseOwner: randomUUID(),
      nowMs,
      leaseDurationMs: LEASE_DURATION_MS,
    });
    if (!claimed?.lease) {
      const latest = await loadPendingDeliveryByTurn(this.sql, {
        conversationId: pending.conversationId,
        turnId: pending.turnId,
      });
      if (!latest) {
        const terminal = await loadDeliveryTerminalOutcome(this.sql, {
          conversationId: pending.conversationId,
          deliveryId: pending.deliveryId,
        });
        if (terminal) return { outcome: terminal };
        return { outcome: "pending", retryAtMs: pending.nextAttemptAtMs };
      }
      return {
        outcome: "pending",
        retryAtMs: Math.max(
          latest.nextAttemptAtMs,
          latest.lease?.expiresAtMs ?? 0,
        ),
      };
    }
    let lease = claimed.lease;
    let current = claimed;
    try {
      while (current.nextPartIndex < current.command.parts.length) {
        const partIndex = current.nextPartIndex;
        const part = current.command.parts[partIndex]!;
        const state = current.partStates[part.partId]!;
        const metadata: SlackDeliveryMetadata = {
          locator: current.command
            .publicLocator as SlackDeliveryMetadata["locator"],
          partIndex,
          version: 1,
        };
        if (state.status === "accepted") {
          throw new Error("Pending delivery cursor points at an accepted part");
        }
        if (state.status === "failed") break;
        if (state.status === "uncertain") {
          lease = await renewPendingDeliveryLease(this.sql, {
            deliveryId: current.deliveryId,
            lease,
            nowMs: this.now(),
            leaseDurationMs: LEASE_DURATION_MS,
          });
          const reconciliation = await this.slack.reconcile({
            channelId: current.command.route.channelId,
            threadTs: current.command.route.threadTs,
            metadata,
            oldestTs: oldestSlackTimestamp(
              Math.max(0, state.attemptedAtMs - RECONCILIATION_CLOCK_SKEW_MS),
            ),
            ...(state.reconciliationCursor
              ? { cursor: state.reconciliationCursor }
              : {}),
          });
          const attempt = state.reconciliationAttempt + 1;
          const reconciliationNow = this.now();
          if (reconciliation.outcome === "accepted") {
            current = await recordPendingDeliveryPartAccepted(this.sql, {
              deliveryId: current.deliveryId,
              partId: part.partId,
              lease,
              providerMessageId: reconciliation.ts,
              nowMs: reconciliationNow,
            });
            continue;
          }
          if (reconciliation.outcome === "retryable") {
            const retryAtMs =
              reconciliation.retryAtMs ?? reconciliationNow + RETRY_DELAY_MS;
            await recordPendingDeliveryPartUncertain(this.sql, {
              deliveryId: current.deliveryId,
              partId: part.partId,
              lease,
              nowMs: reconciliationNow,
              retryAtMs,
              reconciliationAttempt: attempt,
              ...(state.reconciliationCursor
                ? { reconciliationCursor: state.reconciliationCursor }
                : {}),
              ...(state.confirmedAbsentAtMs !== undefined
                ? { confirmedAbsentAtMs: state.confirmedAbsentAtMs }
                : {}),
            });
            return { outcome: "pending", retryAtMs };
          }
          if (reconciliation.outcome === "confirmed_absent") {
            const confirmedAbsentAtMs =
              state.confirmedAbsentAtMs ?? reconciliationNow;
            const graceElapsedAtMs = confirmedAbsentAtMs + REPOST_GRACE_MS;
            if (
              state.confirmedAbsentAtMs !== undefined &&
              reconciliationNow >= graceElapsedAtMs
            ) {
              current = await markPendingDeliveryPartRepostable(this.sql, {
                deliveryId: current.deliveryId,
                partId: part.partId,
                lease,
                nowMs: reconciliationNow,
                reconciliationAttempt: attempt,
                confirmedAbsentAtMs,
                graceElapsedAtMs,
              });
              continue;
            }
            await recordPendingDeliveryPartUncertain(this.sql, {
              deliveryId: current.deliveryId,
              partId: part.partId,
              lease,
              nowMs: reconciliationNow,
              retryAtMs: graceElapsedAtMs,
              reconciliationAttempt: attempt,
              confirmedAbsentAtMs,
            });
            return { outcome: "pending", retryAtMs: graceElapsedAtMs };
          }
          await recordPendingDeliveryPartUncertain(this.sql, {
            deliveryId: current.deliveryId,
            partId: part.partId,
            lease,
            nowMs: reconciliationNow,
            retryAtMs: reconciliationNow + RETRY_DELAY_MS,
            reconciliationAttempt: attempt,
            ...(reconciliation.outcome === "continue"
              ? { reconciliationCursor: reconciliation.nextCursor }
              : state.reconciliationCursor
                ? { reconciliationCursor: state.reconciliationCursor }
                : {}),
            ...(state.confirmedAbsentAtMs !== undefined
              ? { confirmedAbsentAtMs: state.confirmedAbsentAtMs }
              : {}),
          });
          return {
            outcome: "pending",
            retryAtMs: reconciliationNow + RETRY_DELAY_MS,
          };
        }

        current = await markPendingDeliveryPartPosting(this.sql, {
          deliveryId: current.deliveryId,
          partId: part.partId,
          lease,
          nowMs: this.now(),
        });
        lease = await renewPendingDeliveryLease(this.sql, {
          deliveryId: current.deliveryId,
          lease,
          nowMs: this.now(),
          leaseDurationMs: LEASE_DURATION_MS,
        });
        const post = await this.slack.post({
          channelId: current.command.route.channelId,
          threadTs: current.command.route.threadTs,
          text: part.text,
          ...(part.blocks ? { blocks: part.blocks } : {}),
          metadata,
        });
        const postNow = this.now();
        if (post.outcome === "accepted") {
          current = await recordPendingDeliveryPartAccepted(this.sql, {
            deliveryId: current.deliveryId,
            partId: part.partId,
            lease,
            providerMessageId: post.ts,
            nowMs: postNow,
          });
          continue;
        }
        if (post.outcome === "definitive_failure") {
          current = await recordPendingDeliveryPartFailed(this.sql, {
            deliveryId: current.deliveryId,
            partId: part.partId,
            lease,
            failureCode: "provider_rejected",
            nowMs: postNow,
          });
          break;
        }
        if (post.outcome === "retryable_absence") {
          current = await recordPendingDeliveryPartRetryable(this.sql, {
            deliveryId: current.deliveryId,
            partId: part.partId,
            lease,
            nowMs: postNow,
            retryAtMs: post.retryAtMs ?? postNow + RETRY_DELAY_MS,
          });
          return {
            outcome: "pending",
            retryAtMs: post.retryAtMs ?? postNow + RETRY_DELAY_MS,
          };
        }
        await recordPendingDeliveryPartUncertain(this.sql, {
          deliveryId: current.deliveryId,
          partId: part.partId,
          lease,
          nowMs: postNow,
          retryAtMs: postNow + RETRY_DELAY_MS,
          reconciliationAttempt: 0,
        });
        return { outcome: "pending", retryAtMs: postNow + RETRY_DELAY_MS };
      }

      const failed = Object.values(current.partStates).some(
        (state) => state.status === "failed",
      );
      if (failed) {
        try {
          await terminalizeFailedPendingDelivery(this.sql, {
            conversationId: current.conversationId,
            deliveryId: current.deliveryId,
            lease,
            nowMs: this.now(),
            finalizer: async ({ command }) => {
              await new ConversationTurnLifecycleService(
                createSqlConversationEventStore(this.sql),
              ).fail({
                conversationId: current.conversationId,
                turnId: command.completion.turnId,
                createdAtMs: this.now(),
                failureCode: "delivery_failed",
              });
            },
          });
        } catch (error) {
          const terminal = await loadDeliveryTerminalOutcome(this.sql, {
            conversationId: current.conversationId,
            deliveryId: current.deliveryId,
          });
          if (terminal) return { outcome: terminal };
          throw error;
        }
        return { outcome: "failed" };
      }
      try {
        await terminalizeAcceptedPendingDelivery(this.sql, {
          conversationId: current.conversationId,
          deliveryId: current.deliveryId,
          lease,
          nowMs: this.now(),
          finalizer: async ({ command }) => {
            await finalizeAcceptedSql(
              this.sql,
              current.conversationId,
              command,
              this.now(),
            );
          },
        });
      } catch (error) {
        const terminal = await loadDeliveryTerminalOutcome(this.sql, {
          conversationId: current.conversationId,
          deliveryId: current.deliveryId,
        });
        if (terminal) return { outcome: terminal };
        throw error;
      }
      return { outcome: "accepted" };
    } finally {
      const stillPending = await loadPendingDeliveryByTurn(this.sql, {
        conversationId: current.conversationId,
        turnId: current.turnId,
      });
      if (stillPending?.lease) {
        await releasePendingDeliveryLease(this.sql, {
          deliveryId: current.deliveryId,
          lease,
          nowMs: this.now(),
        }).catch(() => undefined);
      }
    }
  }
}
