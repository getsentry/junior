import { botConfig } from "@/chat/config";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import {
  generateAssistantReply,
  type AssistantReply,
  type ReplyRequestContext,
} from "@/chat/respond";
import { createSlackWebApiAssistantStatusTransport } from "@/chat/runtime/assistant-status";
import { createProgressReporter } from "@/chat/runtime/progress-reporter";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { getSlackClient } from "@/chat/slack/client";
import { splitSlackReplyText } from "@/chat/slack/output";
import { isRetryableTurnError } from "@/chat/runtime/turn";
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

/**
 * Post the final visible Slack thread reply and surface delivery failures so
 * callers can decide whether the turn actually succeeded.
 */
export async function postSlackMessage(
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  await getSlackClient().chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
  });
}

/** Post a visible Slack reply using repo-owned chunking/interruption policy. */
export async function postSlackReply(
  channelId: string,
  threadTs: string,
  text: string,
  options?: {
    interrupted?: boolean;
    normalized?: boolean;
  },
): Promise<void> {
  const chunks = splitSlackReplyText(text, options);
  for (const chunk of chunks) {
    await postSlackMessage(channelId, threadTs, chunk);
  }
}

async function postSlackMessageBestEffort(
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  try {
    await postSlackMessage(channelId, threadTs, text);
  } catch {
    // Best effort.
  }
}

/** Create a read-only configuration service from persisted values. */
export function createReadOnlyConfigService(
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

export interface ResumeSlackTurnArgs {
  messageText: string;
  channelId: string;
  threadTs: string;
  replyContext?: ReplyRequestContext;
  lockKey?: string;
  initialText?: string;
  failureText?: string;
  generateReply?: typeof generateAssistantReply;
  onReply?: (reply: AssistantReply) => Promise<void>;
  onSuccess?: (reply: AssistantReply) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (error: unknown) => Promise<void>;
  onTimeoutPause?: (error: unknown) => Promise<void>;
  replyTimeoutMs?: number;
}

function getDefaultLockKey(channelId: string, threadTs: string): string {
  return `slack:${channelId}:${threadTs}`;
}

function createResumeReplyContext(
  args: ResumeSlackTurnArgs,
  progress: ReturnType<typeof createProgressReporter>,
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
    assistant: {
      userName: botConfig.userName,
      ...replyContext.assistant,
    },
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
    onStatus: async (status) => {
      await progress.setStatus(status);
      await replyContext.onStatus?.(status);
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
  const requesterUserId = args.replyContext?.requester?.userId;
  if (!requesterUserId) {
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

  const progress = createProgressReporter({
    channelId: args.channelId,
    threadTs: args.threadTs,
    transport: createSlackWebApiAssistantStatusTransport(),
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
    await progress.start();

    const generateReply = args.generateReply ?? generateAssistantReply;
    const replyContext = createResumeReplyContext(args, progress);
    const replyPromise = generateReply(args.messageText, {
      ...replyContext,
    });
    const replyTimeoutMs = resolveReplyTimeoutMs(args.replyTimeoutMs);
    const reply =
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

    await progress.stop();
    if (args.onReply) {
      await args.onReply(reply);
    } else if (reply.text) {
      await postSlackReply(args.channelId, args.threadTs, reply.text, {
        interrupted: reply.diagnostics.outcome === "provider_error",
      });
    }
    await args.onSuccess?.(reply);
  } catch (error) {
    await progress.stop();

    if (isRetryableTurnError(error, "mcp_auth_resume") && args.onAuthPause) {
      deferredPauseHandler = async () => {
        await args.onAuthPause?.(error);
      };
    } else if (
      isRetryableTurnError(error, "turn_timeout_resume") &&
      args.onTimeoutPause
    ) {
      deferredPauseHandler = async () => {
        await args.onTimeoutPause?.(error);
      };
    } else {
      deferredFailureHandler = async () => {
        await args.onFailure?.(error);

        if (args.failureText) {
          await postSlackMessageBestEffort(
            args.channelId,
            args.threadTs,
            args.failureText,
          );
        }
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
      await args.onFailure?.(pauseError);

      if (args.failureText) {
        await postSlackMessageBestEffort(
          args.channelId,
          args.threadTs,
          args.failureText,
        );
      }
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
  provider: string;
  channelId: string;
  threadTs: string;
  connectedText: string;
  failureText: string;
  replyContext?: ReplyRequestContext;
  lockKey?: string;
  generateReply?: typeof generateAssistantReply;
  onReply?: (reply: AssistantReply) => Promise<void>;
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
    failureText: args.failureText,
    generateReply: args.generateReply,
    onReply: args.onReply,
    onSuccess: args.onSuccess,
    onFailure: args.onFailure,
    onAuthPause: args.onAuthPause,
    onTimeoutPause: args.onTimeoutPause,
    replyTimeoutMs: args.replyTimeoutMs,
  });
}
