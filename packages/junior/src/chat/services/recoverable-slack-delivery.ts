import { randomUUID } from "node:crypto";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  claimPendingConversationDelivery,
  createPendingConversationDelivery,
  loadDeliveryTerminalOutcome,
  loadPendingDeliveryByConversation,
  loadPendingDeliveryByTurn,
  markPendingDeliveryPosting,
  markPendingDeliveryRepostable,
  recordPendingDeliveryAccepted,
  recordPendingDeliveryFailed,
  recordPendingDeliveryRetryable,
  recordPendingDeliveryUncertain,
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
import { juniorConversationMessages } from "@/db/schema";
import type {
  RecoverableSlackPostResult,
  RecoverableSlackReconciliationResult,
  SlackDeliveryMetadata,
} from "@/chat/slack/outbound";
import { logError } from "@/chat/logging";

const LEASE_DURATION_MS = 120_000;
const RETRY_DELAY_MS = 5_000;
// Recheck operator-recoverable permissions on the same one-hour cadence as
// capped Slack provider retries without coupling this service to Slack code.
const PERMANENT_RECONCILIATION_RETRY_DELAY_MS = 60 * 60 * 1_000;
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

  /** Load the conversation's only unresolved delivery. */
  async loadByConversation(args: {
    conversationId: string;
  }): Promise<PendingConversationDelivery | undefined> {
    return loadPendingDeliveryByConversation(this.sql, args);
  }

  /** Resolve the canonical turn terminal after an ambiguous outbox commit. */
  async loadTerminalOutcome(args: {
    conversationId: string;
    turnId: string;
    knownIntent?: boolean;
  }) {
    return loadDeliveryTerminalOutcome(this.sql, args);
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
          turnId: pending.turnId,
          knownIntent: true,
        });
        if (terminal) return { outcome: terminal.deliveryOutcome };
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
        const state = current.progress.currentState;
        const metadata: SlackDeliveryMetadata = {
          locator: current.command
            .publicLocator as SlackDeliveryMetadata["locator"],
          partIndex,
        };
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
          const reconciliationNow = this.now();
          if (reconciliation.outcome === "accepted") {
            current = await recordPendingDeliveryAccepted(this.sql, {
              deliveryId: current.deliveryId,
              lease,
              providerMessageId: reconciliation.ts,
              nowMs: reconciliationNow,
            });
            continue;
          }
          if (reconciliation.outcome === "retryable") {
            const retryAtMs =
              reconciliation.retryAtMs ?? reconciliationNow + RETRY_DELAY_MS;
            await recordPendingDeliveryUncertain(this.sql, {
              deliveryId: current.deliveryId,
              lease,
              nowMs: reconciliationNow,
              retryAtMs,
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
              current = await markPendingDeliveryRepostable(this.sql, {
                deliveryId: current.deliveryId,
                lease,
                nowMs: reconciliationNow,
                graceElapsedAtMs,
              });
              continue;
            }
            await recordPendingDeliveryUncertain(this.sql, {
              deliveryId: current.deliveryId,
              lease,
              nowMs: reconciliationNow,
              retryAtMs: graceElapsedAtMs,
              confirmedAbsentAtMs,
            });
            return { outcome: "pending", retryAtMs: graceElapsedAtMs };
          }
          const retryDelayMs =
            reconciliation.outcome === "unresolved" &&
            reconciliation.reason === "permanent_provider_error"
              ? PERMANENT_RECONCILIATION_RETRY_DELAY_MS
              : RETRY_DELAY_MS;
          const retryAtMs = reconciliationNow + retryDelayMs;
          if (
            reconciliation.outcome === "unresolved" &&
            reconciliation.reason === "permanent_provider_error"
          ) {
            logError(
              "slack_delivery_reconciliation_blocked",
              {
                conversationId: current.conversationId,
                platform: "slack",
                slackChannelId: current.command.route.channelId,
                slackThreadId: current.command.route.threadTs,
              },
              {
                "app.delivery.id": current.deliveryId,
                "app.turn.id": current.turnId,
                "app.provider.error_code":
                  reconciliation.providerErrorCode ?? "unknown",
                "app.retry.delay_ms": retryDelayMs,
              },
              "Slack delivery reconciliation is blocked by a permanent provider error; restore Slack access before the next retry",
            );
          }
          await recordPendingDeliveryUncertain(this.sql, {
            deliveryId: current.deliveryId,
            lease,
            nowMs: reconciliationNow,
            retryAtMs,
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
            retryAtMs,
          };
        }

        current = await markPendingDeliveryPosting(this.sql, {
          deliveryId: current.deliveryId,
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
          current = await recordPendingDeliveryAccepted(this.sql, {
            deliveryId: current.deliveryId,
            lease,
            providerMessageId: post.ts,
            nowMs: postNow,
          });
          continue;
        }
        if (post.outcome === "definitive_failure") {
          current = await recordPendingDeliveryFailed(this.sql, {
            deliveryId: current.deliveryId,
            lease,
            failureCode: "provider_rejected",
            nowMs: postNow,
          });
          break;
        }
        if (post.outcome === "retryable_absence") {
          current = await recordPendingDeliveryRetryable(this.sql, {
            deliveryId: current.deliveryId,
            lease,
            nowMs: postNow,
            retryAtMs: post.retryAtMs ?? postNow + RETRY_DELAY_MS,
          });
          return {
            outcome: "pending",
            retryAtMs: post.retryAtMs ?? postNow + RETRY_DELAY_MS,
          };
        }
        await recordPendingDeliveryUncertain(this.sql, {
          deliveryId: current.deliveryId,
          lease,
          nowMs: postNow,
          retryAtMs: postNow + RETRY_DELAY_MS,
        });
        return { outcome: "pending", retryAtMs: postNow + RETRY_DELAY_MS };
      }

      const failed = current.progress.currentState.status === "failed";
      if (failed) {
        try {
          await terminalizeFailedPendingDelivery(this.sql, {
            conversationId: current.conversationId,
            deliveryId: current.deliveryId,
            turnId: current.turnId,
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
            turnId: current.turnId,
            knownIntent: true,
          });
          if (terminal) return { outcome: terminal.deliveryOutcome };
          throw error;
        }
        return { outcome: "failed" };
      }
      try {
        await terminalizeAcceptedPendingDelivery(this.sql, {
          conversationId: current.conversationId,
          deliveryId: current.deliveryId,
          turnId: current.turnId,
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
          turnId: current.turnId,
          knownIntent: true,
        });
        if (terminal) return { outcome: terminal.deliveryOutcome };
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
        }).catch(() => undefined);
      }
    }
  }
}
