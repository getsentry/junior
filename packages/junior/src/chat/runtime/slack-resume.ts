/**
 * Slack resume execution boundary.
 *
 * Resumed turns run from persisted request context under the Slack thread lock.
 * Status notices are best effort, while final replies and auth-pause notices
 * reuse the shared Slack reply footer path when they are user-visible.
 */
import { botConfig } from "@/chat/config";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import type { AgentRunRequest } from "@/chat/agent/request";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { scheduleSessionCompletedPluginTasks } from "@/chat/plugins/task-runner";
import {
  buildTurnFailureResponse,
  logException,
  type LogContext,
} from "@/chat/logging";
import {
  finalizeFailedTurnReply,
  requireTurnFailureEventId,
} from "@/chat/services/turn-failure-response";
import { persistCompletedSessionRecord } from "@/chat/services/turn-session-record";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import {
  createSlackWebApiAssistantStatusSession,
  type AssistantStatusSession,
} from "@/chat/slack/assistant-thread/status";
import {
  buildSlackReplyFooter,
  type SlackReplyFooter,
} from "@/chat/slack/footer";
import {
  planSlackReplyPosts,
  postSlackApiReplyPosts,
} from "@/chat/slack/reply";
import { isUserActor, type Actor } from "@/chat/actor";
import { postSlackMessage as postSlackApiMessage } from "@/chat/slack/outbound";
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import {
  startSlackProcessingReactionForMessage,
  type ProcessingReactionSession,
} from "@/chat/runtime/processing-reaction";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
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
  footer?: SlackReplyFooter,
): Promise<void> {
  try {
    if (footer) {
      await postSlackApiReplyPosts({
        channelId,
        threadTs,
        posts: [
          {
            text,
            stage: "thread_reply",
          },
        ],
        footer,
      });
      return;
    }

    await postSlackApiMessage({ channelId, threadTs, text });
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
  messageTs?: SlackMessageTs;
  replyContext?: ResumeReplyContext;
  lockKey?: string;
  initialText?: string;
  agentRunner: AgentRunner;
  scheduleSessionCompletedPluginTasks?: (params: {
    conversationId: string;
    sessionId: string;
  }) => Promise<void>;
  onSuccess?: (reply: AgentRunResult) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (pause: { providerDisplayName: string }) => Promise<void>;
  onTimeoutPause?: (resume: { resumeVersion: number }) => Promise<void>;
  onPostDeliveryCommitFailure?: (error: unknown) => Promise<void>;
  beforeStart?: () => Promise<Partial<ResumeSlackTurnArgs> | false | void>;
  replyTimeoutMs?: number;
}

// Resume args carry the user message text, so stored contexts hold only the
// remaining input fields.
type ResumeReplyContext = Omit<AgentRunRequest, "input"> & {
  input?: Omit<AgentRunRequest["input"], "messageText">;
};

function getDefaultLockKey(channelId: string, threadTs: string): string {
  return `slack:${channelId}:${threadTs}`;
}

function getResumeLogContext(
  args: ResumeSlackTurnArgs,
  lockKey: string,
): LogContext {
  const routing = args.replyContext?.routing;
  return {
    conversationId: routing?.correlation?.conversationId ?? lockKey,
    slackThreadId: routing?.correlation?.threadId ?? lockKey,
    slackUserId: isUserActor(routing?.actor)
      ? routing.actor.userId
      : routing?.correlation?.actorId,
    slackUserName: isUserActor(routing?.actor)
      ? routing.actor.userName
      : undefined,
    slackChannelId: args.channelId,
    runId: routing?.correlation?.runId,
    assistantUserName: botConfig.userName,
    modelId: botConfig.modelId,
  };
}

/** Resolve the conversation identifier used by resumed-turn logs and Slack footers. */
function getResumeConversationId(
  args: ResumeSlackTurnArgs,
  lockKey: string,
): string {
  return args.replyContext?.routing.correlation?.conversationId ?? lockKey;
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
): AgentRunRequest {
  const replyContext = args.replyContext;
  if (!replyContext) {
    throw new TypeError("Slack resume requires a reply context");
  }
  if (!replyContext.routing.source) {
    throw new TypeError("Slack resume requires a reply context source");
  }
  const source = replyContext.routing.source;
  if (replyContext.routing.destination.platform !== "slack") {
    throw new TypeError("Slack resume requires a Slack destination");
  }
  const requestDeadline = getTurnRequestDeadline();
  const threadId =
    args.lockKey ?? getDefaultLockKey(args.channelId, args.threadTs);
  const persistedChannelConfiguration =
    replyContext.policy?.channelConfiguration ??
    (replyContext.policy?.configuration
      ? createReadOnlyConfigService(replyContext.policy.configuration)
      : undefined);

  return {
    input: {
      ...(replyContext.input ?? {}),
      messageText: args.messageText,
    },
    routing: {
      ...replyContext.routing,
      source,
      correlation: {
        ...replyContext.routing.correlation,
        threadId: replyContext.routing.correlation?.threadId ?? threadId,
        channelId:
          replyContext.routing.correlation?.channelId ?? args.channelId,
        threadTs: replyContext.routing.correlation?.threadTs ?? args.threadTs,
        actorId:
          replyContext.routing.correlation?.actorId ??
          (isUserActor(replyContext.routing.actor)
            ? replyContext.routing.actor.userId
            : undefined),
      },
    },
    policy: {
      ...replyContext.policy,
      turnDeadlineAtMs:
        replyContext.policy?.turnDeadlineAtMs ?? requestDeadline?.deadlineAtMs,
      channelConfiguration: persistedChannelConfiguration,
    },
    state: replyContext.state,
    observers: {
      ...replyContext.observers,
      onStatus: async (nextStatus) => {
        statusSession.update(nextStatus);
        await replyContext.observers?.onStatus?.(nextStatus);
      },
    },
    durability: {
      ...replyContext.durability,
      onSandboxAcquired: async (sandbox) => {
        await persistThreadStateById(threadId, {
          sandboxId: sandbox.sandboxId,
          sandboxDependencyProfileHash: sandbox.sandboxDependencyProfileHash,
        });
        await replyContext.durability?.onSandboxAcquired?.(sandbox);
      },
      onArtifactStateUpdated: async (artifacts) => {
        await persistThreadStateById(threadId, { artifacts });
        await replyContext.durability?.onArtifactStateUpdated?.(artifacts);
      },
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
  const lock = await acquireActiveLock(stateAdapter, lockKey);
  if (!lock) {
    throw new ResumeTurnBusyError(lockKey);
  }

  const status = createSlackWebApiAssistantStatusSession({
    channelId: args.channelId,
    threadTs: args.threadTs,
  });
  let processingReaction: ProcessingReactionSession | undefined;
  let deferredPauseKind: "auth" | "timeout" | undefined;
  let deferredAuthInfo:
    | { providerDisplayName: string; actorId: string | undefined }
    | undefined;
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

    const activeReplyContext = runArgs.replyContext;
    if (!activeReplyContext) {
      throw new Error("Resumed turn requires replyContext");
    }
    const credentialContext = activeReplyContext.routing.credentialContext;
    if (!credentialContext) {
      throw new Error("Resumed turn requires replyContext.credentialContext");
    }
    const routingActor = activeReplyContext.routing.actor;
    let resumeActor: Actor;
    if ("type" in credentialContext.actor) {
      if (
        !isUserActor(routingActor) ||
        credentialContext.actor.userId !== routingActor.userId
      ) {
        throw new Error(
          "Resumed turn credential actor must match replyContext.routing.actor.userId",
        );
      }
      resumeActor = routingActor;
    } else {
      if (
        routingActor &&
        (routingActor.platform !== "system" ||
          routingActor.name !== credentialContext.actor.name)
      ) {
        throw new Error(
          "Resumed turn system credential actor must match replyContext.routing.actor",
        );
      }
      resumeActor = credentialContext.actor;
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

    const replyContext = createResumeReplyContext(runArgs, status);
    const replyPromise = runArgs.agentRunner.run(replyContext);
    const replyTimeoutMs = resolveReplyTimeoutMs(runArgs.replyTimeoutMs);
    const outcome =
      typeof replyTimeoutMs === "number"
        ? await Promise.race([
            replyPromise,
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `executeAgentRun timed out after ${replyTimeoutMs}ms`,
                    ),
                  ),
                replyTimeoutMs,
              ),
            ),
          ])
        : await replyPromise;
    if (outcome.status !== "completed") {
      // Expected pauses defer their handlers until the lock is released,
      // mirroring the failure path below.
      await status.stop();
      const onAuthPause = runArgs.onAuthPause;
      const onTimeoutPause = runArgs.onTimeoutPause;
      if (outcome.status === "awaiting_auth" && onAuthPause) {
        deferredPauseKind = "auth";
        deferredAuthInfo = {
          providerDisplayName: outcome.providerDisplayName,
          actorId: isUserActor(resumeActor) ? resumeActor.userId : undefined,
        };
        deferredPauseHandler = async () => {
          await onAuthPause({
            providerDisplayName: outcome.providerDisplayName,
          });
        };
      } else if (outcome.status === "suspended" && onTimeoutPause) {
        deferredPauseKind = "timeout";
        deferredPauseHandler = async () => {
          await onTimeoutPause({ resumeVersion: outcome.resumeVersion });
        };
      } else {
        deferredFailureHandler = async () => {
          await handleResumeFailure({
            body: "Failed to resume Slack turn",
            error: new Error(
              `Resumed run ended ${outcome.status} without a pause handler`,
            ),
            eventName: "slack_resume_turn_failed",
            lockKey,
            resumeArgs: runArgs,
          });
        };
      }
    } else {
      let reply = outcome.result;
      reply = finalizeFailedTurnReply({
        reply,
        logException,
        context: getResumeLogContext(runArgs, lockKey),
      });

      await status.stop();
      const footer = buildSlackReplyFooter({
        conversationId: getResumeConversationId(runArgs, lockKey),
      });
      await postSlackApiReplyPosts({
        channelId: runArgs.channelId,
        threadTs: runArgs.threadTs,
        posts: planSlackReplyPosts({ reply }),
        footer,
      });
      finalReplyDelivered = true;
      // Destination acceptance is the completion boundary: only now commit the
      // final assistant messages and the terminal completed session record.
      // Persistence is retried and any remaining failure reaches this runtime
      // boundary instead of being mistaken for a completed durable turn.
      if (
        replyContext.routing.correlation?.conversationId &&
        replyContext.routing.correlation.turnId &&
        reply.piMessages?.length
      ) {
        await persistCompletedSessionRecord({
          conversationId: replyContext.routing.correlation.conversationId,
          sessionId: replyContext.routing.correlation.turnId,
          allMessages: reply.piMessages,
          modelId: reply.diagnostics.modelId,
          currentDurationMs: reply.diagnostics.durationMs,
          currentUsage: reply.diagnostics.usage,
          destination: replyContext.routing.destination,
          source: replyContext.routing.source,
          actor: resumeActor,
          surface: "slack",
          logContext: {
            threadId: replyContext.routing.correlation.threadId,
            actorId: isUserActor(replyContext.routing.actor)
              ? replyContext.routing.actor.userId
              : undefined,
            channelId: runArgs.channelId,
            runId: replyContext.routing.correlation.runId,
            assistantUserName: botConfig.userName,
          },
        });
      }
      await runArgs.onSuccess?.(reply);
      if (
        reply.diagnostics.outcome === "success" &&
        replyContext.routing.correlation?.conversationId &&
        replyContext.routing.correlation.turnId
      ) {
        try {
          const params = {
            conversationId: replyContext.routing.correlation.conversationId,
            sessionId: replyContext.routing.correlation.turnId,
          };
          if (runArgs.scheduleSessionCompletedPluginTasks) {
            await runArgs.scheduleSessionCompletedPluginTasks(params);
          } else {
            await scheduleSessionCompletedPluginTasks(params);
          }
        } catch (scheduleError) {
          logException(
            scheduleError,
            "plugin_session_completed_task_schedule_failed",
            getResumeLogContext(runArgs, lockKey),
            {},
            "Plugin session.completed task scheduling failed",
          );
        }
      }
    }
  } catch (error) {
    await status.stop();

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
      if (deferredPauseKind === "auth" && deferredAuthInfo) {
        const footer = buildSlackReplyFooter({
          conversationId: getResumeConversationId(runArgs, lockKey),
        });
        await postSlackMessageBestEffort(
          runArgs.channelId,
          runArgs.threadTs,
          buildAuthPauseResponse(
            deferredAuthInfo.actorId,
            deferredAuthInfo.providerDisplayName,
          ),
          footer,
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
  messageTs?: SlackMessageTs;
  connectedText: string;
  replyContext?: ResumeReplyContext;
  lockKey?: string;
  agentRunner: AgentRunner;
  onSuccess?: (reply: AgentRunResult) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (pause: { providerDisplayName: string }) => Promise<void>;
  onTimeoutPause?: (resume: { resumeVersion: number }) => Promise<void>;
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
    agentRunner: args.agentRunner,
    onSuccess: args.onSuccess,
    onFailure: args.onFailure,
    onAuthPause: args.onAuthPause,
    onTimeoutPause: args.onTimeoutPause,
    onPostDeliveryCommitFailure: args.onPostDeliveryCommitFailure,
    beforeStart: args.beforeStart,
    replyTimeoutMs: args.replyTimeoutMs,
  });
}
