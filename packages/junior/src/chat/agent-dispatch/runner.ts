/**
 * Durable agent dispatch runner.
 *
 * This is the queue/scheduled-task path for agent turns that are not driven by
 * a live Slack event. It claims a dispatch lease, reconstructs thread state,
 * calls the same agent boundary as Slack replies, persists visible result
 * state, and schedules follow-up slices when a turn needs to continue.
 */
import { botConfig } from "@/chat/config";
import {
  generateAssistantReply as generateAssistantReplyImpl,
  type AssistantReply,
} from "@/chat/respond";
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
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import { canScheduleTurnTimeoutResume } from "@/chat/services/timeout-resume";
import { isRetryableTurnError } from "@/chat/runtime/turn";
import { scheduleDispatchCallback } from "./signing";
import {
  getDispatchConversationId,
  getDispatchStorageKey,
  getDispatchTurnId,
  isTerminalDispatchStatus,
  updateDispatchRecord,
  withDispatchLock,
} from "./store";
import type { DispatchCallback, DispatchRecord } from "./types";

const DISPATCH_SLICE_LEASE_MS = 5 * 60 * 1000;

export interface AgentDispatchRunnerDeps {
  generateAssistantReply?: typeof generateAssistantReplyImpl;
  scheduleCallback?: typeof scheduleDispatchCallback;
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

function ensureVisibleDeliveryText(reply: AssistantReply): AssistantReply {
  if (reply.text.trim().length > 0 || !reply.files?.length) {
    return reply;
  }
  return {
    ...reply,
    text: "Generated files are attached.",
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
      userName: `system:${args.dispatch.actor.id}`,
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
    const current =
      (await state.get<DispatchRecord>(
        getDispatchStorageKey(args.dispatch.id),
      )) ?? args.dispatch;
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
  deps: AgentDispatchRunnerDeps = {},
): Promise<void> {
  const generateAssistantReply =
    deps.generateAssistantReply ?? generateAssistantReplyImpl;
  const scheduleCallback = deps.scheduleCallback ?? scheduleDispatchCallback;
  const nowMs = Date.now();
  const claimedDispatch = await withDispatchLock(callback.id, async (state) => {
    const current =
      (await state.get<DispatchRecord>(getDispatchStorageKey(callback.id))) ??
      undefined;
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

  const conversationId = getDispatchConversationId(dispatch.destination);
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const conversationLock = await stateAdapter.acquireLock(
    conversationId,
    DISPATCH_SLICE_LEASE_MS,
  );
  if (!conversationLock) {
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
        const current =
          (await state.get<DispatchRecord>(
            getDispatchStorageKey(dispatch.id),
          )) ?? dispatch;
        if (
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
    const conversationContext = buildConversationContext(conversation, {
      excludeMessageId: userMessageId,
    });

    let reply = await generateAssistantReply(dispatch.input, {
      authorizationFlowMode: "disabled",
      ...(dispatch.credentialSubject
        ? { credentialSubject: dispatch.credentialSubject }
        : {}),
      configuration,
      channelConfiguration,
      conversationContext,
      artifactState: artifacts,
      piMessages: conversation.piMessages,
      correlation: {
        conversationId,
        threadId: conversationId,
        turnId: getDispatchTurnId(dispatch.id),
        runId: dispatch.id,
        channelId: dispatch.destination.channelId,
        teamId: dispatch.destination.teamId,
        actorType: dispatch.actor.type,
        actorId: dispatch.actor.id,
      },
      toolChannelId: dispatch.destination.channelId,
      sandbox: {
        sandboxId,
        sandboxDependencyProfileHash,
      },
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
    });

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
          conversationId,
          slackThreadId: conversationId,
          slackChannelId: dispatch.destination.channelId,
          runId: dispatch.id,
          actorType: dispatch.actor.type,
          actorId: dispatch.actor.id,
          assistantUserName: botConfig.userName,
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
        durationMs: deliveryReply.diagnostics.durationMs,
        thinkingLevel: deliveryReply.diagnostics.thinkingLevel,
        usage: deliveryReply.diagnostics.usage,
      }),
      fileUploadFailureMode: "strict",
    });

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
    await persistRuntimePatch({
      threadId: conversationId,
      conversation,
      artifacts: nextArtifacts,
      sandboxId: reply.sandboxId ?? sandboxId,
      sandboxDependencyProfileHash:
        reply.sandboxDependencyProfileHash ?? sandboxDependencyProfileHash,
    });
    dispatch = await markDispatch({
      dispatch,
      status: failure ? "failed" : "completed",
      ...(failure ? { errorMessage: failure } : {}),
      resultMessageTs,
    });
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
    if (
      isRetryableTurnError(error, "mcp_auth_resume") ||
      isRetryableTurnError(error, "plugin_auth_resume")
    ) {
      await markDispatch({
        dispatch,
        status: "blocked",
        errorMessage:
          "Dispatch requires authorization from an interactive user turn.",
      });
      return;
    }
    if (isRetryableTurnError(error, "turn_timeout_resume")) {
      const version = error.metadata?.version;
      const nextSliceId = error.metadata?.sliceId;
      if (
        typeof version === "number" &&
        canScheduleTurnTimeoutResume(nextSliceId)
      ) {
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
    }

    logException(
      error,
      "agent_dispatch_run_failed",
      {
        conversationId,
        slackThreadId: conversationId,
        slackChannelId: dispatch.destination.channelId,
        runId: dispatch.id,
        actorType: dispatch.actor.type,
        actorId: dispatch.actor.id,
        assistantUserName: botConfig.userName,
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
    await stateAdapter.releaseLock(conversationLock);
  }
}
