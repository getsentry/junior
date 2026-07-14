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
import {
  planSlackReplyPosts,
  postSlackApiReplyPosts,
} from "@/chat/slack/reply";
import { buildSlackReplyFooter } from "@/chat/slack/footer";
import { finalizeFailedTurnReply } from "@/chat/services/turn-failure-response";
import { completeDeliveredTurn } from "@/chat/services/turn-session-record";
import { persistWithRetry } from "@/chat/services/persist-retry";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
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
  scheduleCallback?: typeof scheduleDispatchCallback;
  scheduleSessionCompletedPluginTasks?: typeof scheduleSessionCompletedPluginTasks;
}

function getUserMessageId(dispatch: DispatchRecord): string {
  return `dispatch:${dispatch.id}:user`;
}

function getAssistantMessageId(dispatch: DispatchRecord): string {
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
    slackThreadId: conversationId,
    slackChannelId: dispatch.destination.channelId,
    runId: dispatch.id,
    actorType: dispatch.actor.platform,
    actorId: dispatch.actor.name,
    assistantUserName: botConfig.userName,
  };
  const destinationLockId = getDispatchDestinationLockId(dispatch.destination);
  const stateAdapter = getStateAdapter();
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
    const deliveredMessage = conversation.messages.find(
      (message) =>
        message.id === getAssistantMessageId(dispatch) &&
        message.meta?.replied === true &&
        typeof message.meta.slackTs === "string",
    );
    if (typeof deliveredMessage?.meta?.slackTs === "string") {
      await markDispatch({
        dispatch,
        status: "completed",
        resultMessageTs: deliveredMessage.meta.slackTs,
      });
      return;
    }

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
    const conversationContext = buildConversationContext(conversation, {
      excludeMessageId: userMessageId,
    });

    const outcome = await deps.agentRunner.run({
      input: {
        messageText: dispatch.input,
        conversationContext,
        // Pi history for redelivered dispatch slices comes from the SQL
        // step-store projection, not a thread-state mirror.
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
    if (failure) {
      reply = finalizeFailedTurnReply({
        reply,
        logException,
        context: {
          ...logContext,
          modelId: reply.diagnostics.modelId,
        },
      });
    }

    const deliveryReply = ensureVisibleDeliveryText(reply);
    const resultMessageTs = await postSlackApiReplyPosts({
      channelId: dispatch.destination.channelId,
      posts: planSlackReplyPosts({ reply: deliveryReply }),
      footer: buildSlackReplyFooter({
        conversationId,
      }),
    });

    // Slack accepted the reply: everything after this point serves duplicate
    // suppression and bookkeeping, and must not turn into a failed dispatch
    // that a retry would re-post. Persist the delivered marker
    // (`meta.slackTs`, checked by the redelivery guard above) immediately and
    // durably before the dispatch is marked terminal so the crash window
    // between post and marker stays as small as possible. The retry-and-swallow
    // `persistRuntimePatch` below write-throughs the SQL transcript, so no
    // separate transcript persist runs outside that guarded block.
    markConversationMessage(conversation, userMessageId, {
      replied: true,
      skippedReason: undefined,
    });
    upsertConversationMessage(conversation, {
      id: getAssistantMessageId(dispatch),
      role: "assistant",
      text: normalizeConversationText(deliveryReply.text) || "[empty response]",
      createdAtMs: nowMs,
      author: {
        userName: botConfig.userName,
        isBot: true,
      },
      meta: {
        replied: true,
        slackTs: resultMessageTs,
      },
    });
    updateConversationStats(conversation);
    const nextArtifacts = reply.artifactStatePatch
      ? mergeArtifactsState(artifacts, reply.artifactStatePatch)
      : artifacts;
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
      logException(
        persistError,
        "agent_dispatch_post_delivery_persist_failed",
        logContext,
        {},
        "Failed to persist delivered dispatch state after Slack accepted the reply",
      );
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
      await markDispatch({
        dispatch,
        status: "blocked",
        errorMessage: `Dispatch requires ${error.provider} authorization.`,
      });
      return;
    }
    if (error instanceof PluginCredentialFailureError) {
      await markDispatch({
        dispatch,
        status: "blocked",
        errorMessage: error.message,
      });
      return;
    }
    logException(
      error,
      "agent_dispatch_run_failed",
      {
        ...logContext,
        modelId: botConfig.modelId,
      },
      {},
      "Agent dispatch failed",
    );
    await markDispatch({
      dispatch,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await stateAdapter.releaseLock(destinationLock);
  }
}
