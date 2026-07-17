/**
 * Durable agent dispatch runner.
 *
 * This is the queue/scheduled-task path for agent turns that are not driven by
 * a live Slack event. It claims a dispatch lease, reconstructs thread state,
 * calls the same agent boundary as Slack replies, persists visible result
 * state, and schedules follow-up slices when a turn needs to continue.
 */
import { botConfig } from "@/chat/config";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { logException } from "@/chat/logging";
import {
  buildConversationContext,
  markConversationMessage,
  normalizeConversationText,
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
} from "@/chat/conversations/visible-messages";
import { loadProjection } from "@/chat/conversations/projection";
import {
  coerceThreadArtifactsState,
  type ThreadArtifactsState,
} from "@/chat/state/artifacts";
import {
  getChannelConfigurationServiceById,
  getPersistedThreadState,
  mergeArtifactsState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { getStateAdapter } from "@/chat/state/adapter";
import { planSlackReplyPosts } from "@/chat/slack/reply";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
} from "@/chat/slack/footer";
import { createSlackDeliveryLocator } from "@/chat/slack/outbound";
import type { RecoverableSlackDelivery } from "@/chat/slack/recoverable-delivery";
import { buildDeterministicAssistantMessageId } from "@/chat/state/turn-id";
import { finalizeFailedTurnReplyWithEvent } from "@/chat/services/turn-failure-response";
import { completeDeliveredTurn } from "@/chat/services/turn-session-record";
import { repairTerminalizingSlackDelivery } from "@/chat/runtime/slack-delivery-recovery";
import { persistWithRetry } from "@/chat/services/persist-retry";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import { scheduleSessionCompletedPluginTasks } from "@/chat/plugins/task-runner";
import type {
  ConversationTurnLifecycle,
  StartConversationTurnInput,
} from "@/chat/conversations/turn-lifecycle";
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
  recoverableSlackDelivery: RecoverableSlackDelivery;
  turnLifecycle: ConversationTurnLifecycle;
  scheduleCallback?: typeof scheduleDispatchCallback;
  scheduleSessionCompletedPluginTasks?: typeof scheduleSessionCompletedPluginTasks;
}

interface CanonicalDispatchTerminalProjection {
  errorMessage?: string;
  resultMessageTs?: string;
  status: "completed" | "failed";
}

function getUserMessageId(dispatch: DispatchRecord): string {
  return `dispatch:${dispatch.id}:user`;
}

function getAssistantMessageId(dispatch: DispatchRecord): string {
  return buildDeterministicAssistantMessageId(getDispatchTurnId(dispatch.id));
}

function getLegacyAssistantMessageId(dispatch: DispatchRecord): string {
  return `dispatch:${dispatch.id}:assistant`;
}

function buildDispatchConversationText(dispatch: DispatchRecord): string {
  return `[dispatched task] ${dispatch.input}`;
}

/** True when dispatch finalization should produce a visible Slack text reply. */
function shouldPostDispatchReplyText(reply: AgentRunResult): boolean {
  return (
    reply.deliveryPlan?.postThreadText ??
    (reply.deliveryMode ?? "thread") !== "channel_only"
  );
}

function ensureVisibleDeliveryText(reply: AgentRunResult): AgentRunResult {
  if (!shouldPostDispatchReplyText(reply)) {
    return reply;
  }
  if (reply.text.trim().length > 0) {
    return reply;
  }
  return {
    ...reply,
    text: "The task completed without a visible response.",
  };
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
  sandboxDependencyProfileHash?: string;
  sandboxId?: string;
  threadId: string;
}): Promise<void> {
  await persistThreadStateById(args.threadId, {
    artifacts: args.artifacts,
    conversation: args.conversation,
    sandboxId: args.sandboxId,
    sandboxDependencyProfileHash: args.sandboxDependencyProfileHash,
  });
}

async function markDispatch(args: {
  dispatch: DispatchRecord;
  errorMessage?: string;
  nextCallbackAtMs?: number;
  nextCallbackKind?: "delivery";
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
      nextCallbackAtMs: args.nextCallbackAtMs,
      nextCallbackKind: args.nextCallbackKind,
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
      ...(args.resultMessageTs
        ? { resultMessageTs: args.resultMessageTs }
        : {}),
    });
  });
}

async function parkPendingDelivery(args: {
  dispatch: DispatchRecord;
  retryAtMs: number;
  schedule: typeof scheduleDispatchCallback;
}): Promise<void> {
  const pending = await markDispatch({
    dispatch: args.dispatch,
    status: "awaiting_resume",
    nextCallbackAtMs: args.retryAtMs,
    nextCallbackKind: "delivery",
  });
  if (args.retryAtMs <= Date.now()) {
    await args.schedule({
      id: pending.id,
      expectedVersion: pending.version,
      kind: "delivery",
    });
  }
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

/** Process one authenticated callback as a serverless dispatch execution slice. */
export async function processAgentDispatchCallback(
  callback: DispatchCallback,
  deps: AgentDispatchRunnerDeps,
): Promise<void> {
  const scheduleCallback = deps.scheduleCallback ?? scheduleDispatchCallback;
  const scheduleCompletedTasks =
    deps.scheduleSessionCompletedPluginTasks ??
    scheduleSessionCompletedPluginTasks;
  const nowMs = Date.now();
  const isDeliveryCallback = callback.kind === "delivery";
  const claimedDispatch = await withDispatchLock(callback.id, async (state) => {
    const current = parseDispatchRecord(
      await state.get(getDispatchStorageKey(callback.id)),
    );
    if (
      !current ||
      current.version !== callback.expectedVersion ||
      (isDeliveryCallback
        ? current.nextCallbackKind !== "delivery"
        : !canClaimDispatch(current, nowMs))
    ) {
      return undefined;
    }
    return await updateDispatchRecord(state, {
      ...current,
      lastCallbackAtMs: nowMs,
      ...(isDeliveryCallback
        ? {}
        : {
            leaseExpiresAtMs: nowMs + DISPATCH_SLICE_LEASE_MS,
            status: "running" as const,
          }),
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
    slackThreadId: conversationId,
    slackChannelId: dispatch.destination.channelId,
    runId: dispatch.id,
    actorType: dispatch.actor.platform,
    actorId: dispatch.actor.name,
    assistantUserName: botConfig.userName,
  };
  const destinationLockId = getDispatchDestinationLockId(dispatch.destination);
  const stateAdapter = getStateAdapter();
  let lifecycleStart: StartConversationTurnInput | undefined;
  let lifecycleTerminalized = false;
  let canonicalTerminalProjection:
    | CanonicalDispatchTerminalProjection
    | undefined;
  let failureCode:
    | "agent_run_failed"
    | "delivery_failed"
    | "persistence_failed" = "agent_run_failed";
  await stateAdapter.connect();
  const destinationLock = await stateAdapter.acquireLock(
    destinationLockId,
    DISPATCH_SLICE_LEASE_MS,
  );
  if (!destinationLock) {
    if (isDeliveryCallback) {
      await parkPendingDelivery({
        dispatch,
        retryAtMs: Date.now() + 60_000,
        schedule: scheduleCallback,
      });
    } else {
      await markDispatch({
        dispatch,
        status: "pending",
        errorMessage: "Destination conversation is busy",
      });
    }
    return;
  }

  try {
    const persisted = await getPersistedThreadState(conversationId);
    const conversation = coerceThreadConversationState(persisted);
    await hydrateConversationMessages({ conversation, conversationId });
    const pendingDelivery = await deps.recoverableSlackDelivery.loadByTurn({
      conversationId,
      turnId,
    });
    if (pendingDelivery) {
      const recovered = await deps.recoverableSlackDelivery.advance(
        pendingDelivery,
        { beforeTerminalize: repairTerminalizingSlackDelivery },
      );
      if (recovered.outcome === "pending") {
        await parkPendingDelivery({
          dispatch,
          retryAtMs: recovered.retryAtMs,
          schedule: scheduleCallback,
        });
        return;
      }
      await hydrateConversationMessages({ conversation, conversationId });
    }
    const priorTerminal =
      await deps.recoverableSlackDelivery.loadTerminalOutcome({
        conversationId,
        turnId,
        acceptanceEvidence: isDeliveryCallback
          ? "known_outbox_intent"
          : "visible_assistant",
      });
    const deliveredMessage = conversation.messages.find(
      (message) =>
        (message.id === getAssistantMessageId(dispatch) ||
          message.id === getLegacyAssistantMessageId(dispatch)) &&
        message.meta?.replied === true &&
        typeof message.meta.slackTs === "string",
    );
    if (priorTerminal) {
      canonicalTerminalProjection = {
        status: priorTerminal.modelSucceeded ? "completed" : "failed",
        ...(typeof deliveredMessage?.meta?.slackTs === "string"
          ? { resultMessageTs: deliveredMessage.meta.slackTs }
          : {}),
      };
      lifecycleStart = {
        conversationId,
        turnId,
        createdAtMs: nowMs,
        inputMessageIds: [getUserMessageId(dispatch)],
        surface: "api",
      };
      await deps.turnLifecycle.start(lifecycleStart);
      lifecycleTerminalized = true;
      await persistRuntimePatch({
        threadId: conversationId,
        conversation,
        artifacts: coerceThreadArtifactsState(persisted),
      });
      await markDispatch({
        dispatch,
        ...canonicalTerminalProjection,
      });
      return;
    }
    if (deliveredMessage) {
      lifecycleStart = {
        conversationId,
        turnId,
        createdAtMs: nowMs,
        inputMessageIds: [getUserMessageId(dispatch)],
        surface: "api",
      };
      await deps.turnLifecycle.start(lifecycleStart);
      await deps.turnLifecycle.fail({
        conversationId,
        turnId,
        createdAtMs: Date.now(),
        failureCode: "persistence_failed",
      });
      lifecycleTerminalized = true;
      canonicalTerminalProjection = {
        status: "completed",
        resultMessageTs: deliveredMessage.meta!.slackTs!,
      };
      await persistRuntimePatch({
        threadId: conversationId,
        conversation,
        artifacts: coerceThreadArtifactsState(persisted),
      });
      await markDispatch({
        dispatch,
        ...canonicalTerminalProjection,
      });
      return;
    }
    if (isDeliveryCallback) {
      throw new Error("Delivery callback has no pending delivery outcome");
    }

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
    if (!startedDispatch) return;
    dispatch = startedDispatch;

    let artifacts = coerceThreadArtifactsState(persisted);
    let sandboxId =
      typeof persisted.app_sandbox_id === "string"
        ? persisted.app_sandbox_id
        : undefined;
    let sandboxDependencyProfileHash =
      typeof persisted.app_sandbox_dependency_profile_hash === "string"
        ? persisted.app_sandbox_dependency_profile_hash
        : undefined;
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
    lifecycleStart = {
      conversationId,
      turnId,
      createdAtMs: nowMs,
      inputMessageIds: [userMessageId],
      surface: "api",
    };
    await deps.turnLifecycle.start(lifecycleStart);
    const conversationContext = buildConversationContext(conversation, {
      excludeMessageId: userMessageId,
    });
    const outcome = await deps.agentRunner.run({
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
        correlation: {
          conversationId,
          threadId: conversationId,
          turnId,
          runId: dispatch.id,
          channelId: dispatch.destination.channelId,
          teamId: dispatch.destination.teamId,
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
        sandbox: {
          sandboxId,
          sandboxDependencyProfileHash,
        },
      },
      durability: {
        onSandboxAcquired: async (sandbox) => {
          sandboxId = sandbox.sandboxId;
          sandboxDependencyProfileHash = sandbox.sandboxDependencyProfileHash;
          await persistRuntimePatch({
            threadId: conversationId,
            conversation,
            artifacts,
            sandboxId,
            sandboxDependencyProfileHash,
          });
        },
        onArtifactStateUpdated: async (nextArtifacts) => {
          artifacts = nextArtifacts;
          await persistRuntimePatch({
            threadId: conversationId,
            conversation,
            artifacts,
            sandboxId,
            sandboxDependencyProfileHash,
          });
        },
      },
    });
    if (outcome.status === "awaiting_auth") {
      await deps.turnLifecycle.fail({
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
    let finalizedFailureEventId: string | undefined;
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
      finalizedFailureEventId = finalized.eventId;
    }

    const deliveryReply = ensureVisibleDeliveryText(reply);
    const plannedPosts = planSlackReplyPosts({ reply: deliveryReply }).filter(
      (post) => post.text.trim().length > 0,
    );
    let resultMessageTs: string | undefined;
    let deliveryTerminalized = false;
    if (plannedPosts.length > 0) {
      failureCode = "delivery_failed";
      const footer = buildSlackReplyFooter({ conversationId });
      const intent = await deps.recoverableSlackDelivery.createIntent({
        conversationId,
        turnId,
        deliveryId: `slack:${turnId}`,
        modelMessages: reply.piMessages ?? [],
        command: {
          route: { channelId: dispatch.destination.channelId },
          publicLocator: createSlackDeliveryLocator(),
          session: {
            surface: "api",
            source: dispatch.source,
            destination: dispatch.destination,
            destinationVisibility: dispatch.destinationVisibility,
            actor: dispatch.actor,
            startedAtMs: dispatch.createdAtMs,
          },
          parts: plannedPosts.map((post, index) => {
            const blocks = buildSlackReplyBlocks(
              post.text,
              index === plannedPosts.length - 1 ? footer : undefined,
            );
            return {
              text: post.text,
              ...(blocks ? { blocks } : {}),
            };
          }),
          completion: {
            turnId,
            inputMessageIds: [userMessageId],
            assistantMessage: {
              messageId: getAssistantMessageId(dispatch),
              text:
                normalizeConversationText(deliveryReply.text) ||
                "[empty response]",
              createdAtMs: nowMs,
              author: { userName: botConfig.userName, isBot: true },
            },
            model: { modelId: reply.diagnostics.modelId },
            ...(reply.diagnostics.durationMs !== undefined
              ? { durationMs: reply.diagnostics.durationMs }
              : {}),
            ...(reply.diagnostics.usage
              ? { usage: reply.diagnostics.usage }
              : {}),
            ...(reply.diagnostics.reasoningLevel
              ? { reasoningLevel: reply.diagnostics.reasoningLevel }
              : {}),
            sliceId: 1,
            terminal: failure
              ? {
                  outcome: "failed" as const,
                  failureCode: "model_execution_failed" as const,
                  ...(finalizedFailureEventId
                    ? { eventId: finalizedFailureEventId }
                    : {}),
                }
              : { outcome: "success" as const },
          },
        },
      });
      const delivery = await deps.recoverableSlackDelivery.advance(intent, {
        beforeTerminalize: repairTerminalizingSlackDelivery,
      });
      if (delivery.outcome === "pending") {
        await parkPendingDelivery({
          dispatch,
          retryAtMs: delivery.retryAtMs,
          schedule: scheduleCallback,
        });
        return;
      }
      lifecycleTerminalized = true;
      deliveryTerminalized = true;
      canonicalTerminalProjection =
        delivery.outcome === "failed"
          ? {
              status: "failed",
              errorMessage: "Slack rejected the dispatched reply.",
            }
          : {
              status: failure ? "failed" : "completed",
              ...(failure ? { errorMessage: failure } : {}),
              ...(delivery.messageTs
                ? { resultMessageTs: delivery.messageTs }
                : {}),
            };
      await hydrateConversationMessages({ conversation, conversationId });
      if (delivery.outcome === "failed") {
        await persistRuntimePatch({
          threadId: conversationId,
          conversation,
          artifacts,
          sandboxId,
          sandboxDependencyProfileHash,
        });
        await markDispatch({
          dispatch,
          ...canonicalTerminalProjection,
        });
        return;
      }
      resultMessageTs = delivery.messageTs;
      failureCode = "persistence_failed";
    } else {
      markConversationMessage(conversation, userMessageId, {
        replied: true,
        skippedReason: undefined,
      });
    }
    updateConversationStats(conversation);
    const nextArtifacts = reply.artifactStatePatch
      ? mergeArtifactsState(artifacts, reply.artifactStatePatch)
      : artifacts;
    let postDeliveryPersistenceFailed = false;
    let postDeliveryPersistenceEventId: string | undefined;
    try {
      await persistWithRetry(() =>
        persistRuntimePatch({
          threadId: conversationId,
          conversation,
          artifacts: nextArtifacts,
          sandboxId: reply.sandboxId ?? sandboxId,
          sandboxDependencyProfileHash:
            reply.sandboxDependencyProfileHash ?? sandboxDependencyProfileHash,
        }),
      );
    } catch (persistError) {
      postDeliveryPersistenceFailed = true;
      postDeliveryPersistenceEventId = logException(
        persistError,
        "agent_dispatch_post_delivery_persist_failed",
        logContext,
        {},
        "Failed to persist delivered dispatch state after Slack accepted the reply",
      );
    }
    if (reply.piMessages?.length && !deliveryTerminalized) {
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
        logContext: {
          threadId: conversationId,
          channelId: dispatch.destination.channelId,
          runId: dispatch.id,
          assistantUserName: botConfig.userName,
        },
      });
    }
    if (deliveryTerminalized) {
      lifecycleTerminalized = true;
    } else if (postDeliveryPersistenceFailed) {
      await deps.turnLifecycle.fail({
        conversationId,
        turnId,
        createdAtMs: Date.now(),
        failureCode: "persistence_failed",
        ...(postDeliveryPersistenceEventId
          ? { eventId: postDeliveryPersistenceEventId }
          : {}),
      });
    } else if (failure) {
      await deps.turnLifecycle.fail({
        conversationId,
        turnId,
        createdAtMs: Date.now(),
        failureCode: "model_execution_failed",
        ...(finalizedFailureEventId
          ? { eventId: finalizedFailureEventId }
          : {}),
      });
    } else {
      await deps.turnLifecycle.complete({
        conversationId,
        turnId,
        createdAtMs: Date.now(),
        outcome: shouldPostDispatchReplyText(reply) ? "success" : "no_reply",
      });
    }
    lifecycleTerminalized = true;
    canonicalTerminalProjection = {
      status: failure ? "failed" : "completed",
      ...(failure ? { errorMessage: failure } : {}),
      ...(resultMessageTs ? { resultMessageTs } : {}),
    };
    dispatch = await markDispatch({
      dispatch,
      ...canonicalTerminalProjection,
    });
    if (!failure && !postDeliveryPersistenceFailed) {
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
    const unresolvedDelivery = await deps.recoverableSlackDelivery.loadByTurn({
      conversationId,
      turnId,
    });
    if (unresolvedDelivery) {
      logException(
        error,
        "agent_dispatch_delivery_advance_failed",
        logContext,
        {},
        "Failed to advance durable dispatch delivery",
      );
      await parkPendingDelivery({
        dispatch,
        retryAtMs: Math.max(
          unresolvedDelivery.nextAttemptAtMs,
          Date.now() + 5_000,
        ),
        schedule: scheduleCallback,
      });
      return;
    }
    if (canonicalTerminalProjection) {
      logException(
        error,
        "agent_dispatch_terminal_projection_failed",
        logContext,
        {},
        "Failed to repair or project a canonically terminal dispatch",
      );
      return;
    }
    if (error instanceof AuthorizationFlowDisabledError) {
      if (lifecycleStart && !lifecycleTerminalized) {
        await deps.turnLifecycle.start(lifecycleStart);
        await deps.turnLifecycle.fail({
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
      if (lifecycleStart && !lifecycleTerminalized) {
        await deps.turnLifecycle.start(lifecycleStart);
        await deps.turnLifecycle.fail({
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
        modelId: botConfig.modelId,
      },
      {},
      "Agent dispatch failed",
    );
    if (lifecycleStart && !lifecycleTerminalized) {
      await deps.turnLifecycle.start(lifecycleStart);
      await deps.turnLifecycle.fail({
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
