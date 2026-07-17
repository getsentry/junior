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
} from "@/chat/state/turn-session";
import { completeDeliveredTurn } from "@/chat/services/turn-session-record";
import type {
  RecoverableSlackDelivery,
  RecoverableSlackDeliveryOutcome,
  RecoverableSlackDeliveryTerminalizingInput,
} from "@/chat/slack/recoverable-delivery";

const DEFAULT_RECOVERY_LIMIT = 25;

/** Repair session and derived thread state before terminal delivery deletion. */
export async function repairTerminalizingSlackDelivery(
  input: RecoverableSlackDeliveryTerminalizingInput,
): Promise<void> {
  const command = input.command;
  const conversationId = input.conversationId;
  const sessionId = input.turnId;
  const sessionRecord = await getAgentTurnSessionRecord(
    conversationId,
    sessionId,
  );

  if (input.deliveryOutcome === "accepted") {
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
  } else if (
    sessionRecord &&
    sessionRecord.state !== "completed" &&
    sessionRecord.state !== "failed" &&
    sessionRecord.state !== "abandoned"
  ) {
    await failAgentTurnSessionRecord({
      conversationId,
      expectedVersion: sessionRecord.version,
      sessionId,
      errorMessage: "Slack rejected the final turn reply",
    });
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
  await persistThreadStateById(conversationId, patch);
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
      const outcome = await args.delivery.advance(intent, {
        beforeTerminalize: repairTerminalizingSlackDelivery,
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

/** Recover one known turn before a resume handler decides whether Pi may run. */
export async function recoverSlackDeliveryForTurn(args: {
  conversationId: string;
  delivery?: RecoverableSlackDelivery;
  turnId: string;
}): Promise<RecoverableSlackDeliveryOutcome | undefined> {
  if (!args.delivery) return undefined;
  const pending = await args.delivery.loadByTurn(args);
  if (pending) {
    const outcome = await args.delivery.advance(pending, {
      beforeTerminalize: repairTerminalizingSlackDelivery,
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
