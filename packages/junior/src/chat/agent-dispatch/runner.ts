/**
 * Durable agent dispatch runner.
 *
 * This is the queue/scheduled-task path for agent turns that are not driven by
 * a live Slack event. It claims a dispatch lease, reconstructs thread state,
 * calls the same agent boundary as Slack replies, persists visible result
 * state, and schedules follow-up slices when a turn needs to continue.
 */
import { botConfig } from "@/chat/config";
import { standardModelId } from "@/chat/model-profile";
import { RetryableDeliveryError } from "@/chat/agent/request";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { logException } from "@/chat/logging";
import {
  buildConversationContext,
  markConversationMessage,
  normalizeConversationText,
  recordDeliveredAssistantMessage,
  turnHasReply,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import {
  coerceThreadConversationState,
  type ThreadConversationState,
} from "@/chat/state/conversation";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/messages";
import { loadProjection } from "@/chat/conversations/projection";
import {
  coerceThreadArtifactsState,
  type ThreadArtifactsState,
} from "@/chat/state/artifacts";
import {
  getChannelConfigurationServiceById,
  getPersistedSandboxState,
  getPersistedThreadState,
  mergeArtifactsState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import type { SandboxRef } from "@/chat/sandbox/ref";
import { getStateAdapter } from "@/chat/state/adapter";
import { sendSlackReply } from "@/chat/slack/reply";
import { finalizeFailedTurnReplyWithEvent } from "@/chat/services/turn-failure-response";
import { completeDeliveredTurn } from "@/chat/services/turn-session-record";
import {
  ConversationTurnLifecycleService,
  type ConversationTurnLifecycle,
} from "@/chat/conversations/turn-lifecycle";
import type { ConversationTurnFailureCode } from "@/chat/conversations/history";
import { getConversationEventStore } from "@/chat/db";
import { persistWithRetry } from "@/chat/services/persist-retry";
import { getAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import { isRetryableSlackPostError } from "@/chat/slack/errors";
import { scheduleSessionCompletedPluginTasks } from "@/chat/plugins/task-runner";
import { scheduleDispatchCallback } from "./signing";
import {
  getDispatchConversationId,
  getDispatchDestinationLockId,
  getDispatchStorageKey,
  getDispatchTurnId,
  isTerminalDispatchStatus,
  parseDispatchRecord,
  updateDispatchRecord,
  withDispatchLock,
} from "./store";
import type { DispatchCallback, DispatchRecord } from "./types";

const DISPATCH_SLICE_LEASE_MS = 5 * 60 * 1000;

export interface AgentDispatchRunnerDeps {
  agentRunner: AgentRunner;
  turnLifecycle?: ConversationTurnLifecycle;
  scheduleCallback?: typeof scheduleDispatchCallback;
  scheduleSessionCompletedPluginTasks?: typeof scheduleSessionCompletedPluginTasks;
}

function getUserMessageId(dispatch: DispatchRecord): string {
  return `dispatch:${dispatch.id}:user`;
}

function buildDispatchConversationText(dispatch: DispatchRecord): string {
  return `[dispatched task] ${dispatch.input}`;
}

function upsertDispatchUserMessage(args: {
  conversation: ThreadConversationState;
  dispatch: DispatchRecord;
  nowMs: number;
}): string {
  return upsertConversationMessage(args.conversation, {
    id: getUserMessageId(args.dispatch),
    role: "user",
    text: normalizeConversationText(
      buildDispatchConversationText(args.dispatch),
    ),
    createdAtMs: args.nowMs,
    author: {
      userName: `system:${args.dispatch.actor.name}`,
      isBot: true,
    },
    meta: {
      explicitMention: true,
    },
  });
}

async function persistRuntimePatch(args: {
  artifacts?: ThreadArtifactsState;
  conversation: ThreadConversationState;
  sandboxRef?: SandboxRef;
  threadId: string;
}): Promise<void> {
  await persistThreadStateById(args.threadId, {
    artifacts: args.artifacts,
    conversation: args.conversation,
    sandboxRef: args.sandboxRef,
  });
}

async function markDispatch(args: {
  dispatch: DispatchRecord;
  errorMessage?: string;
  resultMessageTs?: string;
  status: DispatchRecord["status"];
}): Promise<DispatchRecord> {
  return await withDispatchLock(args.dispatch.id, async (state) => {
    const current = parseDispatchRecord(
      await state.get(getDispatchStorageKey(args.dispatch.id)),
    );
    if (!current) {
      throw new Error("Dispatch record is missing or invalid.");
    }
    return await updateDispatchRecord(state, {
      ...current,
      status: args.status,
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
      ...(args.resultMessageTs
        ? { resultMessageTs: args.resultMessageTs }
        : {}),
    });
  });
}

function canClaimDispatch(record: DispatchRecord, nowMs: number): boolean {
  if (isTerminalDispatchStatus(record.status)) {
    return false;
  }
  if (record.attempt >= record.maxAttempts) {
    return false;
  }
  if (
    record.status === "running" &&
    typeof record.leaseExpiresAtMs === "number" &&
    record.leaseExpiresAtMs > nowMs
  ) {
    return false;
  }
  return true;
}

/** Run one serverless slice for a core-owned agent dispatch. */
export async function runAgentDispatchSlice(
  callback: DispatchCallback,
  deps: AgentDispatchRunnerDeps,
): Promise<void> {
  const scheduleCallback = deps.scheduleCallback ?? scheduleDispatchCallback;
  const scheduleCompletedTasks =
    deps.scheduleSessionCompletedPluginTasks ??
    scheduleSessionCompletedPluginTasks;
  const turnLifecycle =
    deps.turnLifecycle ??
    new ConversationTurnLifecycleService(getConversationEventStore());
  const nowMs = Date.now();
  const claimedDispatch = await withDispatchLock(callback.id, async (state) => {
    const current = parseDispatchRecord(
      await state.get(getDispatchStorageKey(callback.id)),
    );
    if (
      !current ||
      !canClaimDispatch(current, nowMs) ||
      current.version !== callback.expectedVersion
    ) {
      return undefined;
    }
    return await updateDispatchRecord(state, {
      ...current,
      lastCallbackAtMs: nowMs,
      leaseExpiresAtMs: nowMs + DISPATCH_SLICE_LEASE_MS,
      status: "running",
    });
  });
  if (!claimedDispatch) {
    return;
  }
  let dispatch = claimedDispatch;

  const conversationId = getDispatchConversationId(dispatch);
  const turnId = getDispatchTurnId(dispatch.id);
  const logContext = {
    conversationId,
    messageConversationId: conversationId,
    destinationName: dispatch.destination.channelId,
    runId: dispatch.id,
    actorType: dispatch.actor.platform,
    actorId: dispatch.actor.name,
    assistantUserName: botConfig.userName,
  };
  const destinationLockId = getDispatchDestinationLockId(dispatch.destination);
  const stateAdapter = getStateAdapter();
  let lifecycleStarted = false;
  let lifecycleTerminalized = false;
  let failureCode: ConversationTurnFailureCode = "persistence_failed";
  await stateAdapter.connect();
  const destinationLock = await stateAdapter.acquireLock(
    destinationLockId,
    DISPATCH_SLICE_LEASE_MS,
  );
  if (!destinationLock) {
    await markDispatch({
      dispatch,
      status: "pending",
      errorMessage: "Destination conversation is busy",
    });
    return;
  }

  try {
    const startedDispatch = await withDispatchLock(
      dispatch.id,
      async (state) => {
        const current = parseDispatchRecord(
          await state.get(getDispatchStorageKey(dispatch.id)),
        );
        if (
          !current ||
          current.status !== "running" ||
          current.version !== dispatch.version ||
          current.attempt >= current.maxAttempts
        ) {
          return undefined;
        }
        return await updateDispatchRecord(state, {
          ...current,
          attempt: current.attempt + 1,
        });
      },
    );
    if (!startedDispatch) {
      return;
    }
    dispatch = startedDispatch;

    const persisted = await getPersistedThreadState(conversationId);
    const conversation = coerceThreadConversationState(persisted);
    await hydrateConversationMessages({ conversation, conversationId });
    const completedSession = await getAgentTurnSessionRecord(
      conversationId,
      turnId,
    );
    if (completedSession?.state === "completed") {
      const deliveredMessage = [...conversation.messages]
        .reverse()
        .find(
          (message) =>
            message.id.startsWith(`${turnId}:assistant:`) &&
            typeof message.meta?.slackTs === "string",
        );
      await markDispatch({
        dispatch,
        status: "completed",
        ...(deliveredMessage?.meta?.slackTs
          ? { resultMessageTs: deliveredMessage.meta.slackTs }
          : {}),
      });
      return;
    }

    let artifacts = coerceThreadArtifactsState(persisted);
    let sandboxRef = getPersistedSandboxState(persisted);
    const channelConfiguration = getChannelConfigurationServiceById(
      dispatch.destination.channelId,
    );
    const configuration = await channelConfiguration.resolveValues();
    const userMessageId = upsertDispatchUserMessage({
      conversation,
      dispatch,
      nowMs,
    });
    await persistConversationMessages({ conversation, conversationId });
    await turnLifecycle.start({
      conversationId,
      turnId,
      createdAtMs: nowMs,
      inputMessageIds: [userMessageId],
      surface: "api",
    });
    lifecycleStarted = true;
    failureCode = "agent_run_failed";
    const conversationContext = buildConversationContext(conversation, {
      excludeMessageId: userMessageId,
    });
    let resultMessageTs: string | undefined;
    let assistantMessageDelivered = turnHasReply(conversation, turnId);
    /** Post and record one completed assistant message for this dispatch. */
    const deliverAssistantMessage = async (assistantMessage: {
      text: string;
    }): Promise<void> => {
      if (!assistantMessage.text.trim()) {
        return;
      }
      failureCode = "delivery_failed";
      try {
        resultMessageTs = await sendSlackReply({
          channelId: dispatch.destination.channelId,
          conversationId,
          text: assistantMessage.text,
        });
      } catch (error) {
        if (isRetryableSlackPostError(error)) {
          throw new RetryableDeliveryError(error);
        }
        throw error;
      }
      assistantMessageDelivered = true;
      const recordedMessageId = recordDeliveredAssistantMessage({
        conversation,
        sessionId: turnId,
        text: assistantMessage.text,
        userMessageId,
      });
      if (resultMessageTs) {
        markConversationMessage(conversation, recordedMessageId, {
          slackTs: resultMessageTs,
        });
      }
      try {
        await persistWithRetry(() =>
          persistConversationMessages({ conversation, conversationId }),
        );
      } catch (persistError) {
        logException(
          new Error("Accepted assistant message persistence failed"),
          "agent_dispatch_assistant_message_post_delivery_persist_failed",
          logContext,
          {
            "error.type":
              persistError instanceof Error
                ? persistError.name
                : typeof persistError,
          },
          "Failed to persist an accepted dispatch assistant message",
        );
      }
      failureCode = "agent_run_failed";
    };
    const outcome = await deps.agentRunner.run({
      conversationId,
      turnId,
      runId: dispatch.id,
      input: {
        messageText: dispatch.input,
        conversationContext,
        // Pi history for redelivered dispatch slices comes from the SQL
        // event-store projection, not a thread-state mirror.
        piMessages: await loadProjection({ conversationId }),
      },
      routing: {
        credentialContext: {
          actor: dispatch.actor,
          ...(dispatch.credentialSubject
            ? { subject: dispatch.credentialSubject }
            : {}),
        },
        destination: dispatch.destination,
        destinationVisibility: dispatch.destinationVisibility,
        source: dispatch.source,
        dispatch: {
          actor: dispatch.actor,
          metadata: dispatch.metadata,
          plugin: dispatch.plugin,
        },
        surface: "api",
        toolChannelId: dispatch.destination.channelId,
      },
      policy: {
        authorizationFlowMode: "disabled",
        configuration,
        channelConfiguration,
      },
      state: {
        artifactState: artifacts,
        sandboxRef,
      },
      delivery: {
        onAssistantMessage: deliverAssistantMessage,
      },
      durability: {
        onSandboxRefChanged: async (nextSandboxRef) => {
          sandboxRef = nextSandboxRef;
          await persistRuntimePatch({
            threadId: conversationId,
            conversation,
            artifacts,
            sandboxRef,
          });
        },
        onArtifactStateUpdated: async (nextArtifacts) => {
          artifacts = nextArtifacts;
          await persistRuntimePatch({
            threadId: conversationId,
            conversation,
            artifacts,
            sandboxRef,
          });
        },
      },
    });
    if (outcome.status === "awaiting_auth") {
      await turnLifecycle.fail({
        conversationId,
        turnId,
        createdAtMs: Date.now(),
        failureCode: "agent_run_failed",
      });
      lifecycleTerminalized = true;
      await markDispatch({
        dispatch,
        status: "blocked",
        errorMessage:
          "Dispatch requires authorization from an interactive user turn.",
      });
      return;
    }
    if (outcome.status === "suspended") {
      const awaiting = await markDispatch({
        dispatch,
        status: "awaiting_resume",
      });
      await scheduleCallback({
        id: awaiting.id,
        expectedVersion: awaiting.version,
      });
      return;
    }

    let reply = outcome.result;

    const failure =
      reply.diagnostics.outcome === "success"
        ? undefined
        : (reply.diagnostics.errorMessage ??
          `Agent turn ended with ${reply.diagnostics.outcome}.`);
    let modelFailureEventId: string | undefined;
    if (failure) {
      const finalized = finalizeFailedTurnReplyWithEvent({
        reply,
        logException,
        context: {
          ...logContext,
          modelId: reply.diagnostics.modelId,
        },
      });
      reply = finalized.reply;
      modelFailureEventId = finalized.eventId;
      await deliverAssistantMessage({ text: reply.text });
    }

    failureCode = "persistence_failed";

    // Final bookkeeping retries all accepted message facts and runtime state
    // before terminalizing the dispatch; it must never re-post a delivery.
    markConversationMessage(conversation, userMessageId, {
      replied: true,
      skippedReason: undefined,
    });
    updateConversationStats(conversation);
    const nextArtifacts = reply.artifactStatePatch
      ? mergeArtifactsState(artifacts, reply.artifactStatePatch)
      : artifacts;
    let statePersisted = false;
    try {
      await persistWithRetry(async () => {
        await persistConversationMessages({ conversation, conversationId });
        await persistRuntimePatch({
          threadId: conversationId,
          conversation,
          artifacts: nextArtifacts,
          sandboxRef: reply.sandboxRef ?? sandboxRef,
        });
      });
      statePersisted = true;
    } catch (persistError) {
      const eventId = logException(
        persistError,
        "agent_dispatch_post_delivery_persist_failed",
        logContext,
        {},
        "Failed to persist delivered dispatch state after Slack accepted the reply",
      );
      await turnLifecycle.fail({
        conversationId,
        turnId,
        createdAtMs: Date.now(),
        failureCode: "persistence_failed",
        ...(eventId ? { eventId } : {}),
      });
      lifecycleTerminalized = true;
    }
    if (reply.piMessages?.length) {
      // Destination acceptance is the completion boundary for the session
      // record too; this call swallows its own persistence failures.
      await completeDeliveredTurn({
        conversationId,
        sessionId: turnId,
        sliceId: 1,
        messages: reply.piMessages,
        modelId: reply.diagnostics.modelId,
        durationMs: reply.diagnostics.durationMs,
        usage: reply.diagnostics.usage,
        reasoningLevel: reply.diagnostics.reasoningLevel,
        destination: dispatch.destination,
        destinationVisibility: dispatch.destinationVisibility,
        source: dispatch.source,
        actor: dispatch.actor,
        surface: "api",
      });
    }
    if (statePersisted) {
      if (failure) {
        await turnLifecycle.fail({
          conversationId,
          turnId,
          createdAtMs: Date.now(),
          failureCode: "model_execution_failed",
          ...(modelFailureEventId ? { eventId: modelFailureEventId } : {}),
        });
      } else {
        await turnLifecycle.complete({
          conversationId,
          turnId,
          createdAtMs: Date.now(),
          outcome: assistantMessageDelivered ? "success" : "no_reply",
        });
      }
      lifecycleTerminalized = true;
    }
    dispatch = await markDispatch({
      dispatch,
      status: failure ? "failed" : "completed",
      ...(failure ? { errorMessage: failure } : {}),
      resultMessageTs,
    });
    if (!failure) {
      try {
        await scheduleCompletedTasks({
          conversationId,
          sessionId: turnId,
        });
      } catch (error) {
        logException(
          error,
          "plugin_session_completed_task_schedule_failed",
          logContext,
          {},
          "Plugin session.completed task scheduling failed",
        );
      }
    }
  } catch (error) {
    if (error instanceof AuthorizationFlowDisabledError) {
      if (lifecycleStarted && !lifecycleTerminalized) {
        await turnLifecycle.fail({
          conversationId,
          turnId,
          createdAtMs: Date.now(),
          failureCode: "agent_run_failed",
        });
        lifecycleTerminalized = true;
      }
      await markDispatch({
        dispatch,
        status: "blocked",
        errorMessage: `Dispatch requires ${error.provider} authorization.`,
      });
      return;
    }
    if (error instanceof PluginCredentialFailureError) {
      if (lifecycleStarted && !lifecycleTerminalized) {
        await turnLifecycle.fail({
          conversationId,
          turnId,
          createdAtMs: Date.now(),
          failureCode: "agent_run_failed",
        });
        lifecycleTerminalized = true;
      }
      await markDispatch({
        dispatch,
        status: "blocked",
        errorMessage: error.message,
      });
      return;
    }
    const eventId = logException(
      error,
      "agent_dispatch_run_failed",
      {
        ...logContext,
        modelId: standardModelId(botConfig),
      },
      {},
      "Agent dispatch failed",
    );
    if (lifecycleStarted && !lifecycleTerminalized) {
      await turnLifecycle.fail({
        conversationId,
        turnId,
        createdAtMs: Date.now(),
        failureCode,
        ...(eventId ? { eventId } : {}),
      });
      lifecycleTerminalized = true;
    }
    await markDispatch({
      dispatch,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await stateAdapter.releaseLock(destinationLock);
  }
}
