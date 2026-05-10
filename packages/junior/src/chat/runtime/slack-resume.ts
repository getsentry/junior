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
import { getStateAdapter } from "@/chat/state/adapter";

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
    // The connected notice should not decide whether the resumed turn succeeds.
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
  replyContext?: ReplyRequestContext;
  lockKey?: string;
  initialText?: string;
  generateReply?: typeof generateAssistantReply;
  onSuccess?: (reply: AssistantReply) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (error: unknown) => Promise<void>;
  onTimeoutPause?: (error: unknown) => Promise<void>;
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
  const threadId =
    args.lockKey ?? getDefaultLockKey(args.channelId, args.threadTs);
  const persistedChannelConfiguration =
    replyContext.channelConfiguration ??
    (replyContext.configuration
      ? createReadOnlyConfigService(replyContext.configuration)
      : undefined);

  return {
    ...replyContext,
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
 * Success is defined by final reply delivery, not only by successful assistant
 * generation. If the final visible Slack post fails, the resumed turn is
 * treated as failed so thread state does not claim the user saw a reply that
 * never arrived.
 */
export async function resumeSlackTurn(args: ResumeSlackTurnArgs) {
  if (!args.replyContext?.requester?.userId) {
    throw new Error("Resumed turn requires replyContext.requester.userId");
  }

  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const lockKey =
    args.lockKey ?? getDefaultLockKey(args.channelId, args.threadTs);
  const lock = await stateAdapter.acquireLock(
    lockKey,
    botConfig.turnTimeoutMs + 60_000,
  );
  if (!lock) {
    throw new ResumeTurnBusyError(lockKey);
  }

  const status = createSlackWebApiAssistantStatusSession({
    channelId: args.channelId,
    threadTs: args.threadTs,
  });
  let deferredPauseHandler: (() => Promise<void>) | undefined;
  let deferredFailureHandler: (() => Promise<void>) | undefined;
  try {
    if (args.initialText) {
      await postSlackMessageBestEffort(
        args.channelId,
        args.threadTs,
        args.initialText,
      );
    }
    status.start();

    const generateReply = args.generateReply ?? generateAssistantReply;
    const replyContext = createResumeReplyContext(args, status);
    const replyPromise = generateReply(args.messageText, replyContext);
    const replyTimeoutMs = resolveReplyTimeoutMs(args.replyTimeoutMs);
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
      context: getResumeLogContext(args, lockKey),
    });

    await status.stop();
    const footer = buildSlackReplyFooter({
      conversationId: args.replyContext?.correlation?.conversationId ?? lockKey,
      durationMs: reply.diagnostics.durationMs,
      thinkingLevel: reply.diagnostics.thinkingLevel,
      usage: reply.diagnostics.usage,
    });
    await postSlackApiReplyPosts({
      channelId: args.channelId,
      threadTs: args.threadTs,
      posts: planSlackReplyPosts({ reply }),
      fileUploadFailureMode: "best_effort",
      footer,
    });
    await args.onSuccess?.(reply);
  } catch (error) {
    await status.stop();

    const onAuthPause = args.onAuthPause;
    const onTimeoutPause = args.onTimeoutPause;
    if (
      (isRetryableTurnError(error, "mcp_auth_resume") ||
        isRetryableTurnError(error, "plugin_auth_resume")) &&
      onAuthPause
    ) {
      deferredPauseHandler = async () => {
        await onAuthPause(error);
      };
    } else if (
      isRetryableTurnError(error, "turn_timeout_resume") &&
      onTimeoutPause
    ) {
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
          resumeArgs: args,
        });
      };
    }
  } finally {
    await stateAdapter.releaseLock(lock);
  }

  if (deferredPauseHandler) {
    try {
      await deferredPauseHandler();
      return;
    } catch (pauseError) {
      await handleResumeFailure({
        body: "Failed to handle resumed turn pause",
        error: pauseError,
        eventName: "slack_resume_pause_handler_failed",
        lockKey,
        resumeArgs: args,
      });
      return;
    }
  }

  if (deferredFailureHandler) {
    await deferredFailureHandler();
  }
}

/** Resume an OAuth-paused Slack request through the shared resume runner. */
export async function resumeAuthorizedRequest(args: {
  messageText: string;
  channelId: string;
  threadTs: string;
  connectedText: string;
  replyContext?: ReplyRequestContext;
  lockKey?: string;
  generateReply?: typeof generateAssistantReply;
  onSuccess?: (reply: AssistantReply) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (error: unknown) => Promise<void>;
  onTimeoutPause?: (error: unknown) => Promise<void>;
  replyTimeoutMs?: number;
}) {
  await resumeSlackTurn({
    messageText: args.messageText,
    channelId: args.channelId,
    threadTs: args.threadTs,
    replyContext: args.replyContext,
    lockKey: args.lockKey,
    initialText: args.connectedText,
    generateReply: args.generateReply,
    onSuccess: args.onSuccess,
    onFailure: args.onFailure,
    onAuthPause: args.onAuthPause,
    onTimeoutPause: args.onTimeoutPause,
    replyTimeoutMs: args.replyTimeoutMs,
  });
}
