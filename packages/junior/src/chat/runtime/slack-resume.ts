import { botConfig } from "@/chat/config";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import {
  generateAssistantReply,
  type AssistantReply,
  type ReplyRequestContext,
} from "@/chat/respond";
import {
  buildTurnFailureResponse,
  logException,
  type LogContext,
} from "@/chat/logging";
import { isRetryableTurnError } from "@/chat/runtime/turn";
import {
  finalizeFailedTurnReply,
  requireTurnFailureEventId,
} from "@/chat/services/turn-failure-response";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import {
  createSlackWebApiAssistantStatusSession,
  type AssistantStatusSession,
} from "@/chat/slack/assistant-thread/status";
import { buildSlackReplyFooter } from "@/chat/slack/footer";
import {
  planSlackReplyPosts,
  postSlackApiReplyPosts,
} from "@/chat/slack/reply";
import { postSlackMessage as postSlackApiMessage } from "@/chat/slack/outbound";
import { ACTIVE_LOCK_TTL_MS, getStateAdapter } from "@/chat/state/adapter";
import {
  startSlackProcessingReactionForMessage,
  type ProcessingReactionSession,
} from "@/chat/runtime/processing-reaction";
import { buildAuthPauseResponse } from "@/chat/services/auth-pause-response";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";

function resolveReplyTimeoutMs(explicitTimeoutMs?: number): number | undefined {
  if (typeof explicitTimeoutMs === "number" && explicitTimeoutMs > 0) {
    return explicitTimeoutMs;
  }

  const raw = process.env.EVAL_AGENT_REPLY_TIMEOUT_MS?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function postSlackMessageBestEffort(
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  try {
    await postSlackApiMessage({
      channelId,
      threadTs,
      text,
    });
  } catch {
    // Resume-side status notices should not decide whether the turn succeeds.
  }
}

/** Create a read-only configuration service from persisted values. */
function createReadOnlyConfigService(
  values: Record<string, unknown>,
): ChannelConfigurationService {
  const entries = Object.entries(values).map(([key, value]) => ({
    key,
    value,
    scope: "conversation" as const,
    updatedAt: new Date().toISOString(),
  }));

  return {
    get: async (key) => entries.find((entry) => entry.key === key),
    set: async () => {
      throw new Error("Read-only configuration in resumed context");
    },
    unset: async () => false,
    list: async ({ prefix } = {}) =>
      entries.filter((entry) => !prefix || entry.key.startsWith(prefix)),
    resolve: async (key) => values[key],
    resolveValues: async ({ keys, prefix } = {}) => {
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        if (prefix && !key.startsWith(prefix)) continue;
        if (keys && !keys.includes(key)) continue;
        filtered[key] = value;
      }
      return filtered;
    },
  };
}

/** Error raised when another worker already owns the resume lock. */
export class ResumeTurnBusyError extends Error {
  constructor(lockKey: string) {
    super(`A turn already owns resume lock "${lockKey}"`);
    this.name = "ResumeTurnBusyError";
  }
}

interface ResumeSlackTurnArgs {
  messageText: string;
  channelId: string;
  threadTs: string;
  messageTs?: string;
  replyContext?: ReplyRequestContext;
  lockKey?: string;
  initialText?: string;
  generateReply?: typeof generateAssistantReply;
  onSuccess?: (reply: AssistantReply) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (error: unknown) => Promise<void>;
  onTimeoutPause?: (error: unknown) => Promise<void>;
  onPostDeliveryCommitFailure?: (error: unknown) => Promise<void>;
  beforeStart?: () => Promise<Partial<ResumeSlackTurnArgs> | false | void>;
  replyTimeoutMs?: number;
}

function getDefaultLockKey(channelId: string, threadTs: string): string {
  return `slack:${channelId}:${threadTs}`;
}

function getResumeLogContext(
  args: ResumeSlackTurnArgs,
  lockKey: string,
): LogContext {
  return {
    conversationId: args.replyContext?.correlation?.conversationId ?? lockKey,
    slackThreadId: args.replyContext?.correlation?.threadId ?? lockKey,
    slackUserId:
      args.replyContext?.requester?.userId ??
      args.replyContext?.correlation?.requesterId,
    slackUserName: args.replyContext?.requester?.userName,
    slackChannelId: args.channelId,
    runId: args.replyContext?.correlation?.runId,
    assistantUserName: botConfig.userName,
    modelId: botConfig.modelId,
  };
}

async function postResumeFailureReply(args: {
  channelId: string;
  threadTs: string;
  eventId: string;
  logContext: LogContext;
}): Promise<void> {
  try {
    await postSlackApiMessage({
      channelId: args.channelId,
      threadTs: args.threadTs,
      text: buildTurnFailureResponse(args.eventId),
    });
  } catch (error) {
    logException(
      error,
      "slack_resume_failure_reply_post_failed",
      args.logContext,
      {
        "app.error.original_event_id": args.eventId,
      },
      "Failed to post resumed turn failure reply",
    );
    throw error;
  }
}

async function handleResumeFailure(args: {
  body: string;
  error: unknown;
  eventName: string;
  lockKey: string;
  resumeArgs: ResumeSlackTurnArgs;
}): Promise<void> {
  const logContext = getResumeLogContext(args.resumeArgs, args.lockKey);
  const capturedEventId = logException(
    args.error,
    args.eventName,
    logContext,
    {},
    args.body,
  );
  await args.resumeArgs.onFailure?.(args.error);
  const eventId = requireTurnFailureEventId(capturedEventId, args.eventName);
  await postResumeFailureReply({
    channelId: args.resumeArgs.channelId,
    threadTs: args.resumeArgs.threadTs,
    eventId,
    logContext,
  });
}

function createResumeReplyContext(
  args: ResumeSlackTurnArgs,
  statusSession: AssistantStatusSession,
): ReplyRequestContext {
  const replyContext = args.replyContext ?? {};
  const requestDeadline = getTurnRequestDeadline();
  const threadId =
    args.lockKey ?? getDefaultLockKey(args.channelId, args.threadTs);
  const persistedChannelConfiguration =
    replyContext.channelConfiguration ??
    (replyContext.configuration
      ? createReadOnlyConfigService(replyContext.configuration)
      : undefined);

  return {
    ...replyContext,
    turnDeadlineAtMs:
      replyContext.turnDeadlineAtMs ?? requestDeadline?.deadlineAtMs,
    correlation: {
      ...replyContext.correlation,
      threadId: replyContext.correlation?.threadId ?? threadId,
      channelId: replyContext.correlation?.channelId ?? args.channelId,
      threadTs: replyContext.correlation?.threadTs ?? args.threadTs,
      requesterId:
        replyContext.correlation?.requesterId ?? replyContext.requester?.userId,
    },
    channelConfiguration: persistedChannelConfiguration,
    onSandboxAcquired: async (sandbox) => {
      await persistThreadStateById(threadId, {
        sandboxId: sandbox.sandboxId,
        sandboxDependencyProfileHash: sandbox.sandboxDependencyProfileHash,
      });
      await replyContext.onSandboxAcquired?.(sandbox);
    },
    onArtifactStateUpdated: async (artifacts) => {
      await persistThreadStateById(threadId, { artifacts });
      await replyContext.onArtifactStateUpdated?.(artifacts);
    },
    onStatus: async (nextStatus) => {
      statusSession.update(nextStatus);
      await replyContext.onStatus?.(nextStatus);
    },
  };
}

/**
 * Resume a paused Slack turn under the normal thread lock.
 *
 * Started resumes own their terminal side effects: final delivery, pause
 * persistence, or failure response. Returns false only when `beforeStart`
 * proves the resume is stale before generation begins.
 */
export async function resumeSlackTurn(
  args: ResumeSlackTurnArgs,
): Promise<boolean> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const lockKey =
    args.lockKey ?? getDefaultLockKey(args.channelId, args.threadTs);
  const lock = await stateAdapter.acquireLock(lockKey, ACTIVE_LOCK_TTL_MS);
  if (!lock) {
    throw new ResumeTurnBusyError(lockKey);
  }

  const status = createSlackWebApiAssistantStatusSession({
    channelId: args.channelId,
    threadTs: args.threadTs,
  });
  let processingReaction: ProcessingReactionSession | undefined;
  let deferredPauseKind: "auth" | "timeout" | undefined;
  let deferredPauseHandler: (() => Promise<void>) | undefined;
  let deferredFailureHandler: (() => Promise<void>) | undefined;
  let finalReplyDelivered = false;
  let postDeliveryCommitError: unknown;
  let runArgs = args;
  try {
    const preparedArgs = await args.beforeStart?.();
    if (preparedArgs === false) {
      return false;
    }
    if (preparedArgs) {
      runArgs = { ...args, ...preparedArgs };
    }

    if (!runArgs.replyContext?.requester?.userId) {
      throw new Error("Resumed turn requires replyContext.requester.userId");
    }
    const credentialContext = runArgs.replyContext.credentialContext;
    if (!credentialContext) {
      throw new Error("Resumed turn requires replyContext.credentialContext");
    }
    if (
      credentialContext.actor.type !== "user" ||
      credentialContext.actor.userId !== runArgs.replyContext.requester.userId
    ) {
      throw new Error(
        "Resumed turn credential actor must match replyContext.requester.userId",
      );
    }

    if (runArgs.messageTs) {
      processingReaction = await startSlackProcessingReactionForMessage({
        channelId: runArgs.channelId,
        timestamp: runArgs.messageTs,
        logException,
        logContext: { ...getResumeLogContext(runArgs, lockKey) },
      });
    }
    if (runArgs.initialText) {
      await postSlackMessageBestEffort(
        runArgs.channelId,
        runArgs.threadTs,
        runArgs.initialText,
      );
    }
    status.start();

    const generateReply = runArgs.generateReply ?? generateAssistantReply;
    const replyContext = createResumeReplyContext(runArgs, status);
    const replyPromise = generateReply(runArgs.messageText, replyContext);
    const replyTimeoutMs = resolveReplyTimeoutMs(runArgs.replyTimeoutMs);
    let reply =
      typeof replyTimeoutMs === "number"
        ? await Promise.race([
            replyPromise,
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `generateAssistantReply timed out after ${replyTimeoutMs}ms`,
                    ),
                  ),
                replyTimeoutMs,
              ),
            ),
          ])
        : await replyPromise;
    reply = finalizeFailedTurnReply({
      reply,
      logException,
      context: getResumeLogContext(runArgs, lockKey),
    });

    await status.stop();
    const footer = buildSlackReplyFooter({
      conversationId:
        runArgs.replyContext?.correlation?.conversationId ?? lockKey,
    });
    await postSlackApiReplyPosts({
      channelId: runArgs.channelId,
      threadTs: runArgs.threadTs,
      posts: planSlackReplyPosts({ reply }),
      fileUploadFailureMode: "best_effort",
      footer,
    });
    finalReplyDelivered = true;
    await runArgs.onSuccess?.(reply);
  } catch (error) {
    await status.stop();

    const onAuthPause = runArgs.onAuthPause;
    const onTimeoutPause = runArgs.onTimeoutPause;
    if (finalReplyDelivered) {
      postDeliveryCommitError = error;
      try {
        await runArgs.onPostDeliveryCommitFailure?.(error);
      } catch (terminalizeError) {
        logException(
          terminalizeError,
          "slack_resume_post_delivery_terminalize_failed",
          getResumeLogContext(runArgs, lockKey),
          {},
          "Failed to terminalize resumed turn after post-delivery commit failure",
        );
      }
    } else if (
      (isRetryableTurnError(error, "mcp_auth_resume") ||
        isRetryableTurnError(error, "plugin_auth_resume")) &&
      onAuthPause
    ) {
      deferredPauseKind = "auth";
      deferredPauseHandler = async () => {
        await onAuthPause(error);
      };
    } else if (
      isRetryableTurnError(error, "turn_timeout_resume") &&
      onTimeoutPause
    ) {
      deferredPauseKind = "timeout";
      deferredPauseHandler = async () => {
        await onTimeoutPause(error);
      };
    } else {
      deferredFailureHandler = async () => {
        await handleResumeFailure({
          body: "Failed to resume Slack turn",
          error,
          eventName: "slack_resume_turn_failed",
          lockKey,
          resumeArgs: runArgs,
        });
      };
    }
  } finally {
    if (finalReplyDelivered) {
      await processingReaction?.complete();
    } else {
      await processingReaction?.stop();
    }
    await stateAdapter.releaseLock(lock);
  }

  if (postDeliveryCommitError) {
    logException(
      postDeliveryCommitError,
      "slack_resume_success_handler_failed",
      getResumeLogContext(runArgs, lockKey),
      {},
      "Failed to persist resumed turn state after final reply delivery",
    );
    throw postDeliveryCommitError;
  }

  if (deferredPauseHandler) {
    try {
      await deferredPauseHandler();
      if (deferredPauseKind === "auth") {
        await postSlackMessageBestEffort(
          runArgs.channelId,
          runArgs.threadTs,
          buildAuthPauseResponse(),
        );
      }
      return true;
    } catch (pauseError) {
      await handleResumeFailure({
        body: "Failed to handle resumed turn pause",
        error: pauseError,
        eventName: "slack_resume_pause_handler_failed",
        lockKey,
        resumeArgs: runArgs,
      });
      return true;
    }
  }

  if (deferredFailureHandler) {
    await deferredFailureHandler();
  }

  return true;
}

/** Resume an OAuth-paused Slack request through the shared resume runner. */
export async function resumeAuthorizedRequest(args: {
  messageText: string;
  channelId: string;
  threadTs: string;
  messageTs?: string;
  connectedText: string;
  replyContext?: ReplyRequestContext;
  lockKey?: string;
  generateReply?: typeof generateAssistantReply;
  onSuccess?: (reply: AssistantReply) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (error: unknown) => Promise<void>;
  onTimeoutPause?: (error: unknown) => Promise<void>;
  onPostDeliveryCommitFailure?: (error: unknown) => Promise<void>;
  beforeStart?: () => Promise<Partial<ResumeSlackTurnArgs> | false | void>;
  replyTimeoutMs?: number;
}) {
  await resumeSlackTurn({
    messageText: args.messageText,
    channelId: args.channelId,
    threadTs: args.threadTs,
    messageTs: args.messageTs,
    replyContext: args.replyContext,
    lockKey: args.lockKey,
    initialText: args.connectedText,
    generateReply: args.generateReply,
    onSuccess: args.onSuccess,
    onFailure: args.onFailure,
    onAuthPause: args.onAuthPause,
    onTimeoutPause: args.onTimeoutPause,
    onPostDeliveryCommitFailure: args.onPostDeliveryCommitFailure,
    beforeStart: args.beforeStart,
    replyTimeoutMs: args.replyTimeoutMs,
  });
}
