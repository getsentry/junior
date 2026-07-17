/** Repair non-SQL state while a durable Slack delivery intent still exists. */
import { botConfig } from "@/chat/config";
import { logException } from "@/chat/logging";
import { scheduleSessionCompletedPluginTasks } from "@/chat/plugins/task-runner";
import { loadTurnProjection } from "@/chat/conversations/projection";
import { hydrateConversationMessages } from "@/chat/conversations/visible-messages";
import {
  buildRecoveredDeliveredTurnStatePatch,
  buildRecoveredFailedDeliveryStatePatch,
} from "@/chat/runtime/delivered-turn-state";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  failAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import { completeDeliveredTurn } from "@/chat/services/turn-session-record";
import { markTurnFailed } from "@/chat/runtime/turn";
import {
  markConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import type {
  RecoverableSlackDelivery,
  RecoverableSlackDeliveryOutcome,
  RecoverableSlackDeliveryTerminalizingInput,
} from "@/chat/slack/recoverable-delivery";
import type { PendingConversationDelivery } from "@/chat/slack/delivery-outbox";
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";

const DEFAULT_RECOVERY_LIMIT = 25;

/** Repair session and derived thread state before terminal delivery deletion. */
async function repairOwnedTerminalizingSlackDelivery(
  input: RecoverableSlackDeliveryTerminalizingInput,
): Promise<void> {
  const command = input.command;
  const conversationId = input.conversationId;
  const sessionId = input.turnId;
  const sessionRecord = await getAgentTurnSessionRecord(
    conversationId,
    sessionId,
  );

  const turnCompleted =
    input.deliveryOutcome === "accepted" &&
    command.completion.terminal.outcome === "success";
  if (turnCompleted) {
    if (sessionRecord?.state !== "completed") {
      const projection = await loadTurnProjection({
        conversationId,
        committedSeq: command.completion.model.committedSeq,
        includeTail: false,
      });
      if (!projection) {
        throw new Error("Delivered turn projection is unavailable");
      }
      await completeDeliveredTurn({
        conversationId,
        destination: command.session.destination,
        destinationVisibility: command.session.destinationVisibility,
        durationMs: command.completion.durationMs,
        messages: projection.messages,
        modelId: projection.modelId ?? command.completion.model.modelId,
        actor: command.session.actor,
        reasoningLevel: command.completion.reasoningLevel,
        sessionId,
        sliceId: command.completion.sliceId,
        source: command.session.source,
        surface: command.session.surface,
        usage: command.completion.usage,
        channelName: command.session.channelName,
        logContext: {
          threadId: conversationId,
          actorId:
            command.session.actor?.platform === "slack"
              ? command.session.actor.userId
              : undefined,
          channelId: command.session.destination.channelId,
          assistantUserName: botConfig.userName,
        },
      });
    }
  } else {
    const errorMessage =
      input.deliveryOutcome === "accepted"
        ? "Delivered terminal failure reply"
        : "Slack rejected the final turn reply";
    if (!sessionRecord) {
      const projection = await loadTurnProjection({
        conversationId,
        committedSeq: command.completion.model.committedSeq,
        includeTail: false,
      });
      if (!projection) {
        throw new Error("Terminal turn projection is unavailable");
      }
      await upsertAgentTurnSessionRecord({
        conversationId,
        cumulativeDurationMs: command.completion.durationMs,
        cumulativeUsage: command.completion.usage,
        destination: command.session.destination,
        destinationVisibility: command.session.destinationVisibility,
        source: command.session.source,
        sessionId,
        sliceId: command.completion.sliceId,
        state: "failed",
        surface: command.session.surface,
        piMessages: projection.messages,
        modelId: projection.modelId ?? command.completion.model.modelId,
        actor: command.session.actor,
        reasoningLevel: command.completion.reasoningLevel,
        errorMessage,
      });
    } else if (
      sessionRecord.state !== "completed" &&
      sessionRecord.state !== "failed" &&
      sessionRecord.state !== "abandoned"
    ) {
      await failAgentTurnSessionRecord({
        conversationId,
        expectedVersion: sessionRecord.version,
        sessionId,
        errorMessage,
      });
    }
  }

  const currentState = await getPersistedThreadState(conversationId);
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({ conversation, conversationId });
  const patch =
    input.deliveryOutcome === "accepted"
      ? buildRecoveredDeliveredTurnStatePatch({
          assistantMessage: command.completion.assistantMessage,
          conversation,
          inputMessageIds: command.completion.inputMessageIds,
          sessionId,
        })
      : buildRecoveredFailedDeliveryStatePatch({
          conversation,
          inputMessageIds: command.completion.inputMessageIds,
          sessionId,
        });
  if (
    input.deliveryOutcome === "accepted" &&
    command.completion.terminal.outcome === "failed"
  ) {
    markTurnFailed({
      conversation: patch.conversation,
      nowMs: Date.now(),
      sessionId,
      markConversationMessage,
      updateConversationStats,
    });
  }
  await persistThreadStateById(conversationId, patch);
}

interface AdvanceSlackDeliveryArgs {
  delivery: RecoverableSlackDelivery;
  intent: PendingConversationDelivery;
  beforeRepair?: (
    input: RecoverableSlackDeliveryTerminalizingInput,
  ) => Promise<void>;
}

/** Advance a delivery while the caller owns the active conversation lock. */
export async function advanceOwnedSlackDeliveryWithTerminalRepair(
  args: AdvanceSlackDeliveryArgs,
): Promise<RecoverableSlackDeliveryOutcome> {
  return await args.delivery.advance(args.intent, {
    beforeTerminalize: async (input) => {
      await args.beforeRepair?.(input);
      await repairOwnedTerminalizingSlackDelivery(input);
    },
  });
}

/** Acquire turn ownership before advancing and repairing a Slack delivery. */
export async function advanceSlackDeliveryWithTerminalRepair(
  args: AdvanceSlackDeliveryArgs,
): Promise<RecoverableSlackDeliveryOutcome> {
  const state = getStateAdapter();
  await state.connect();
  const lock = await acquireActiveLock(state, args.intent.conversationId);
  if (!lock) {
    return { outcome: "pending", retryAtMs: Date.now() + 5_000 };
  }
  try {
    return await advanceOwnedSlackDeliveryWithTerminalRepair(args);
  } finally {
    await state.releaseLock(lock);
  }
}

async function scheduleCompletedDeliveryPlugins(args: {
  command: RecoverableSlackDeliveryTerminalizingInput["command"];
  conversationId: string;
  outcome: RecoverableSlackDeliveryOutcome;
}): Promise<void> {
  if (
    args.outcome.outcome === "accepted" &&
    args.command.completion.terminal.outcome === "success"
  ) {
    await scheduleSessionCompletedPluginTasks({
      conversationId: args.conversationId,
      sessionId: args.command.completion.turnId,
    });
  }
}

/** Advance due Slack delivery intents without starting an agent run. */
export async function recoverDueSlackDeliveries(args: {
  delivery: RecoverableSlackDelivery;
  limit?: number;
  nowMs: number;
}): Promise<number> {
  const pending = await args.delivery.listDue({
    limit: args.limit ?? DEFAULT_RECOVERY_LIMIT,
    nowMs: args.nowMs,
  });
  let recovered = 0;
  for (const intent of pending) {
    try {
      const outcome = await advanceSlackDeliveryWithTerminalRepair({
        delivery: args.delivery,
        intent,
      });
      await scheduleCompletedDeliveryPlugins({
        command: intent.command,
        conversationId: intent.conversationId,
        outcome,
      });
      recovered += 1;
    } catch (error) {
      logException(
        error,
        "slack_delivery_recovery_failed",
        { conversationId: intent.conversationId },
        {
          "app.delivery.id": intent.deliveryId,
          "app.turn.id": intent.turnId,
        },
        "Heartbeat Slack delivery recovery failed",
      );
    }
  }
  return recovered;
}

async function recoverSlackDeliveryForTurnWithOwnership(args: {
  conversationId: string;
  delivery?: RecoverableSlackDelivery;
  ownsActiveLock: boolean;
  turnId: string;
}): Promise<RecoverableSlackDeliveryOutcome | undefined> {
  if (!args.delivery) return undefined;
  const pending = await args.delivery.loadByTurn(args);
  if (pending) {
    const advance = args.ownsActiveLock
      ? advanceOwnedSlackDeliveryWithTerminalRepair
      : advanceSlackDeliveryWithTerminalRepair;
    const outcome = await advance({
      delivery: args.delivery,
      intent: pending,
    });
    await scheduleCompletedDeliveryPlugins({
      command: pending.command,
      conversationId: pending.conversationId,
      outcome,
    });
    return outcome;
  }
  const terminal = await args.delivery.loadTerminalOutcome({
    conversationId: args.conversationId,
    turnId: args.turnId,
    acceptanceEvidence: "visible_assistant",
  });
  return terminal ? { outcome: terminal.deliveryOutcome } : undefined;
}

/** Recover one known turn after acquiring active conversation ownership. */
export async function recoverSlackDeliveryForTurn(args: {
  conversationId: string;
  delivery?: RecoverableSlackDelivery;
  turnId: string;
}): Promise<RecoverableSlackDeliveryOutcome | undefined> {
  return await recoverSlackDeliveryForTurnWithOwnership({
    ...args,
    ownsActiveLock: false,
  });
}

/** Recover one known turn while the caller owns active conversation state. */
export async function recoverOwnedSlackDeliveryForTurn(args: {
  conversationId: string;
  delivery?: RecoverableSlackDelivery;
  turnId: string;
}): Promise<RecoverableSlackDeliveryOutcome | undefined> {
  return await recoverSlackDeliveryForTurnWithOwnership({
    ...args,
    ownsActiveLock: true,
  });
}
