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
  finalizeFailedTurnReplyWithEvent,
  requireTurnFailureEventId,
} from "@/chat/services/turn-failure-response";
import { persistCompletedSessionRecord } from "@/chat/services/turn-session-record";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import {
  createSlackWebApiAssistantStatusSession,
  type AssistantStatusSession,
  type AssistantStatusSpec,
} from "@/chat/slack/assistant-thread/status";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
  type SlackReplyFooter,
} from "@/chat/slack/footer";
import {
  planSlackReplyPosts,
  postSlackApiReplyPosts,
} from "@/chat/slack/reply";
import { isUserActor, type Actor } from "@/chat/actor";
import { postSlackMessage as postSlackApiMessage } from "@/chat/slack/outbound";
import { createSlackDeliveryLocator } from "@/chat/slack/outbound";
import type { RecoverableSlackDelivery } from "@/chat/slack/recoverable-delivery";
import { buildDeterministicAssistantMessageId } from "@/chat/state/turn-id";
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import {
  startSlackProcessingReactionForMessage,
  type ProcessingReactionSession,
} from "@/chat/runtime/processing-reaction";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import { buildAuthPauseResponse } from "@/chat/services/auth-pause-response";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import type { ConversationTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import { loadConversationProjection } from "@/chat/conversations/projection";
import {
  TurnSliceLimitExceededError,
  buildTurnLimitResponse,
} from "@/chat/services/turn-limit";
import { advanceOwnedSlackDeliveryWithTerminalRepair } from "@/chat/runtime/slack-delivery-recovery";

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

/** Leaves a durable delivery intent for a later callback or conversation turn. */
export class ResumeDeliveryPendingError extends Error {
  constructor(readonly retryAtMs: number) {
    super("Resumed Slack delivery is awaiting retry or reconciliation");
    this.name = "ResumeDeliveryPendingError";
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
  initialStatus?: AssistantStatusSpec;
  agentRunner: AgentRunner;
  recoverableSlackDelivery?: RecoverableSlackDelivery;
  inputMessageIds?: string[];
  sliceId?: number;
  lifecycleCorrelation?: ResumeLifecycleCorrelation;
  turnLifecycle?: ConversationTurnLifecycle;
  scheduleSessionCompletedPluginTasks?: (params: {
    conversationId: string;
    sessionId: string;
  }) => Promise<void>;
  onSuccess?: (reply: AgentRunResult) => Promise<void>;
  onRecoveredSuccess?: () => Promise<void>;
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

async function scheduleResumeCompletedPluginTasks(args: {
  conversationId: string;
  logContext: LogContext;
  schedule: (params: {
    conversationId: string;
    sessionId: string;
  }) => Promise<void>;
  sessionId: string;
}): Promise<void> {
  try {
    await args.schedule({
      conversationId: args.conversationId,
      sessionId: args.sessionId,
    });
  } catch (error) {
    logException(
      error,
      "plugin_session_completed_task_schedule_failed",
      args.logContext,
      {},
      "Plugin session.completed task scheduling failed",
    );
  }
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
  error: unknown;
}): Promise<void> {
  await postSlackApiMessage({
    channelId: args.channelId,
    threadTs: args.threadTs,
    text:
      args.error instanceof TurnSliceLimitExceededError
        ? buildTurnLimitResponse(args.eventId)
        : buildTurnFailureResponse(args.eventId),
  });
}

interface ResumeLifecycleCorrelation {
  conversationId: string;
  turnId: string;
}

interface ResumeLifecycleContext extends ResumeLifecycleCorrelation {
  inputMessageIds?: string[];
}

interface StartedResumeLifecycleContext extends ResumeLifecycleCorrelation {
  inputMessageIds: string[];
}

function getResumeLifecycleContext(
  args: ResumeSlackTurnArgs,
  request: AgentRunRequest,
): StartedResumeLifecycleContext | undefined {
  const conversationId = request.routing.correlation?.conversationId;
  const turnId = request.routing.correlation?.turnId;
  if (!conversationId || !turnId) {
    return undefined;
  }
  if (!args.inputMessageIds?.length) {
    throw new TypeError(
      "Correlated Slack resume requires durable input message IDs",
    );
  }
  if (!args.turnLifecycle) {
    throw new TypeError("Correlated Slack resume requires turn lifecycle");
  }
  return {
    conversationId,
    turnId,
    inputMessageIds: [...new Set(args.inputMessageIds)],
  };
}

async function handleResumeFailure(args: {
  body: string;
  error: unknown;
  eventName: string;
  lockKey: string;
  lifecycle?: ResumeLifecycleContext;
  resumeArgs: ResumeSlackTurnArgs;
}): Promise<void> {
  const logContext = getResumeLogContext(args.resumeArgs, args.lockKey);
  if (args.lifecycle) {
    if (args.lifecycle.inputMessageIds?.length) {
      await args.resumeArgs.turnLifecycle!.start({
        conversationId: args.lifecycle.conversationId,
        turnId: args.lifecycle.turnId,
        inputMessageIds: args.lifecycle.inputMessageIds,
        createdAtMs: Date.now(),
        surface: "slack",
      });
    }
  }
  const capturedEventId = logException(
    args.error,
    args.eventName,
    logContext,
    {},
    args.body,
  );
  const eventId = requireTurnFailureEventId(capturedEventId, args.eventName);
  let failureStatePersistError: unknown;
  try {
    await args.resumeArgs.onFailure?.(args.error);
  } catch (persistError) {
    const persistEventId = logException(
      persistError,
      "slack_resume_failure_state_persist_failed",
      logContext,
      { "app.error.original_event_id": eventId },
      "Failed to persist resumed turn failure state",
    );
    try {
      if (args.lifecycle) {
        await args.resumeArgs.turnLifecycle!.fail({
          ...args.lifecycle,
          createdAtMs: Date.now(),
          failureCode: "persistence_failed",
          ...(persistEventId ? { eventId: persistEventId } : {}),
        });
      }
    } catch (lifecycleError) {
      logException(
        lifecycleError,
        "slack_resume_failure_lifecycle_persist_failed",
        logContext,
        { "app.error.original_event_id": eventId },
        "Failed to record resumed turn persistence failure",
      );
    }
    failureStatePersistError = persistError;
  }
  try {
    await postResumeFailureReply({
      channelId: args.resumeArgs.channelId,
      threadTs: args.resumeArgs.threadTs,
      eventId,
      error: args.error,
    });
  } catch (deliveryError) {
    const deliveryEventId = logException(
      deliveryError,
      "slack_resume_failure_reply_post_failed",
      logContext,
      { "app.error.original_event_id": eventId },
      "Failed to post resumed turn failure reply",
    );
    try {
      if (args.lifecycle) {
        await args.resumeArgs.turnLifecycle!.fail({
          ...args.lifecycle,
          createdAtMs: Date.now(),
          failureCode: "delivery_failed",
          ...(deliveryEventId ? { eventId: deliveryEventId } : {}),
        });
      }
    } catch (lifecycleError) {
      logException(
        lifecycleError,
        "slack_resume_failure_lifecycle_persist_failed",
        logContext,
        { "app.error.original_event_id": eventId },
        "Failed to record resumed turn delivery failure",
      );
    }
    throw deliveryError;
  }
  if (failureStatePersistError) {
    throw failureStatePersistError;
  }
  if (args.lifecycle) {
    await args.resumeArgs.turnLifecycle!.fail({
      ...args.lifecycle,
      createdAtMs: Date.now(),
      failureCode: "agent_run_failed",
      eventId,
    });
  }
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
  if (source.platform !== "slack") {
    throw new TypeError("Slack resume requires a Slack source");
  }
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
  let recoverableDeliveryTerminalized = false;
  let postDeliveryCommitError: unknown;
  let lifecycle: ResumeLifecycleContext | undefined = args.lifecycleCorrelation;
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
    status.update(runArgs.initialStatus);

    const replyContext = createResumeReplyContext(runArgs, status);
    const lifecycleCandidate = getResumeLifecycleContext(runArgs, replyContext);
    if (lifecycleCandidate) {
      lifecycle = lifecycleCandidate;
      await runArgs.turnLifecycle!.start({
        ...lifecycleCandidate,
        createdAtMs: Date.now(),
        surface: "slack",
      });
      const pendingDelivery =
        await runArgs.recoverableSlackDelivery?.loadByTurn({
          conversationId: lifecycleCandidate.conversationId,
          turnId: lifecycleCandidate.turnId,
        });
      if (pendingDelivery) {
        let repairedBeforeTerminal = false;
        const recovery = await advanceOwnedSlackDeliveryWithTerminalRepair({
          delivery: runArgs.recoverableSlackDelivery!,
          intent: pendingDelivery,
          beforeRepair: async (input) => {
            if (input.deliveryOutcome === "accepted") {
              await runArgs.onRecoveredSuccess?.();
            } else {
              await runArgs.onFailure?.(
                new Error("Slack rejected the resumed turn reply"),
              );
            }
            repairedBeforeTerminal = true;
          },
        });
        if (recovery.outcome === "pending") {
          throw new ResumeDeliveryPendingError(recovery.retryAtMs);
        }
        if (repairedBeforeTerminal) {
          finalReplyDelivered = recovery.outcome === "accepted";
          recoverableDeliveryTerminalized = true;
          if (
            recovery.outcome === "accepted" &&
            pendingDelivery.command.completion.terminal.outcome === "success"
          ) {
            await scheduleResumeCompletedPluginTasks({
              conversationId: lifecycleCandidate.conversationId,
              sessionId: lifecycleCandidate.turnId,
              schedule:
                runArgs.scheduleSessionCompletedPluginTasks ??
                scheduleSessionCompletedPluginTasks,
              logContext: getResumeLogContext(runArgs, lockKey),
            });
          }
          return true;
        }
      }
      const priorTerminal =
        await runArgs.recoverableSlackDelivery?.loadTerminalOutcome({
          conversationId: lifecycleCandidate.conversationId,
          turnId: lifecycleCandidate.turnId,
          acceptanceEvidence: "visible_assistant",
        });
      if (priorTerminal) {
        if (priorTerminal.deliveryOutcome === "failed") {
          await runArgs.onFailure?.(
            new Error("Slack rejected the resumed turn reply"),
          );
        } else {
          const projection = await loadConversationProjection({
            conversationId: lifecycleCandidate.conversationId,
          });
          await persistCompletedSessionRecord({
            conversationId: lifecycleCandidate.conversationId,
            sessionId: lifecycleCandidate.turnId,
            allMessages: projection.messages,
            modelId: projection.modelId ?? botConfig.modelId,
            destination: replyContext.routing.destination,
            destinationVisibility: replyContext.routing.destinationVisibility,
            source: replyContext.routing.source,
            actor: resumeActor,
            surface: "slack",
            logContext: {
              threadId: replyContext.routing.correlation?.threadId,
              actorId: isUserActor(replyContext.routing.actor)
                ? replyContext.routing.actor.userId
                : undefined,
              channelId: runArgs.channelId,
              runId: replyContext.routing.correlation?.runId,
              assistantUserName: botConfig.userName,
            },
          });
          finalReplyDelivered = true;
          recoverableDeliveryTerminalized = true;
          await runArgs.onRecoveredSuccess?.();
          if (priorTerminal.modelSucceeded) {
            await scheduleResumeCompletedPluginTasks({
              conversationId: lifecycleCandidate.conversationId,
              sessionId: lifecycleCandidate.turnId,
              schedule:
                runArgs.scheduleSessionCompletedPluginTasks ??
                scheduleSessionCompletedPluginTasks,
              logContext: getResumeLogContext(runArgs, lockKey),
            });
          }
        }
        return true;
      }
    }
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
      await status.clear();
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
            lifecycle,
            resumeArgs: runArgs,
          });
        };
      }
    } else {
      const finalized = finalizeFailedTurnReplyWithEvent({
        reply: outcome.result,
        logException,
        context: getResumeLogContext(runArgs, lockKey),
      });
      const reply = finalized.reply;

      await status.clear();
      const footer = buildSlackReplyFooter({
        conversationId: getResumeConversationId(runArgs, lockKey),
      });
      const plannedPosts = planSlackReplyPosts({ reply }).filter(
        (post) => post.text.trim().length > 0,
      );
      if (
        lifecycle &&
        plannedPosts.length > 0 &&
        runArgs.recoverableSlackDelivery
      ) {
        const deliverySource = replyContext.routing.source;
        const deliveryDestination = replyContext.routing.destination;
        if (
          deliverySource.platform !== "slack" ||
          deliveryDestination.platform !== "slack"
        ) {
          throw new TypeError(
            "Slack resume delivery requires Slack coordinates",
          );
        }
        const intent = await runArgs.recoverableSlackDelivery.createIntent({
          conversationId: lifecycle.conversationId,
          turnId: lifecycle.turnId,
          deliveryId: `slack:${lifecycle.turnId}`,
          modelMessages:
            reply.piMessages ?? replyContext.input.piMessages ?? [],
          command: {
            route: {
              channelId: runArgs.channelId,
              threadTs: runArgs.threadTs,
            },
            publicLocator: createSlackDeliveryLocator(),
            session: {
              surface: "slack",
              source: deliverySource,
              destination: deliveryDestination,
              destinationVisibility: replyContext.routing.destinationVisibility,
              actor: resumeActor,
              startedAtMs: Date.now(),
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
              turnId: lifecycle.turnId,
              inputMessageIds: lifecycle.inputMessageIds ?? [],
              assistantMessage: {
                messageId: buildDeterministicAssistantMessageId(
                  lifecycle.turnId,
                ),
                text: reply.text,
                createdAtMs: Date.now(),
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
              sliceId: runArgs.sliceId ?? 1,
              terminal:
                reply.diagnostics.outcome === "success"
                  ? { outcome: "success" as const }
                  : {
                      outcome: "failed" as const,
                      failureCode: "model_execution_failed" as const,
                      ...(finalized.eventId
                        ? { eventId: finalized.eventId }
                        : {}),
                    },
            },
          },
        });
        let repairedBeforeTerminal = false;
        const delivery = await advanceOwnedSlackDeliveryWithTerminalRepair({
          delivery: runArgs.recoverableSlackDelivery,
          intent,
          beforeRepair: async (input) => {
            if (input.deliveryOutcome === "accepted") {
              await runArgs.onSuccess?.(reply);
            } else {
              await runArgs.onFailure?.(
                new Error("Slack rejected the resumed turn reply"),
              );
            }
            repairedBeforeTerminal = true;
          },
        });
        if (delivery.outcome === "pending") {
          throw new ResumeDeliveryPendingError(delivery.retryAtMs);
        }
        recoverableDeliveryTerminalized = true;
        if (delivery.outcome === "failed") {
          if (!repairedBeforeTerminal) {
            await runArgs.onFailure?.(
              new Error("Slack rejected the resumed turn reply"),
            );
          }
          return true;
        }
        if (repairedBeforeTerminal) {
          finalReplyDelivered = true;
          if (reply.diagnostics.outcome === "success") {
            await scheduleResumeCompletedPluginTasks({
              conversationId: lifecycle.conversationId,
              sessionId: lifecycle.turnId,
              schedule:
                runArgs.scheduleSessionCompletedPluginTasks ??
                scheduleSessionCompletedPluginTasks,
              logContext: getResumeLogContext(runArgs, lockKey),
            });
          }
          return true;
        }
      } else {
        await postSlackApiReplyPosts({
          channelId: runArgs.channelId,
          threadTs: runArgs.threadTs,
          posts: plannedPosts,
          footer,
        });
      }
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
      if (lifecycle && !recoverableDeliveryTerminalized) {
        if (reply.diagnostics.outcome === "success") {
          await runArgs.turnLifecycle!.complete({
            conversationId: lifecycle.conversationId,
            turnId: lifecycle.turnId,
            createdAtMs: Date.now(),
            outcome:
              planSlackReplyPosts({ reply }).length === 0
                ? "no_reply"
                : "success",
          });
        } else {
          await runArgs.turnLifecycle!.fail({
            conversationId: lifecycle.conversationId,
            turnId: lifecycle.turnId,
            createdAtMs: Date.now(),
            failureCode: "model_execution_failed",
            ...(finalized.eventId ? { eventId: finalized.eventId } : {}),
          });
        }
      }
      if (
        reply.diagnostics.outcome === "success" &&
        replyContext.routing.correlation?.conversationId &&
        replyContext.routing.correlation.turnId
      ) {
        await scheduleResumeCompletedPluginTasks({
          conversationId: replyContext.routing.correlation.conversationId,
          sessionId: replyContext.routing.correlation.turnId,
          schedule:
            runArgs.scheduleSessionCompletedPluginTasks ??
            scheduleSessionCompletedPluginTasks,
          logContext: getResumeLogContext(runArgs, lockKey),
        });
      }
    }
  } catch (error) {
    await status.clear();

    if (error instanceof ResumeDeliveryPendingError) {
      return true;
    }

    if (
      lifecycle &&
      (await runArgs.recoverableSlackDelivery?.loadByTurn({
        conversationId: lifecycle.conversationId,
        turnId: lifecycle.turnId,
      }))
    ) {
      logException(
        error,
        "slack_resume_delivery_repair_deferred",
        getResumeLogContext(runArgs, lockKey),
        {},
        "Deferred resumed delivery repair to heartbeat",
      );
      return true;
    }

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
      const eventId = logException(
        error,
        "slack_resume_success_handler_failed",
        getResumeLogContext(runArgs, lockKey),
        {},
        "Failed to persist resumed turn state after final reply delivery",
      );
      if (lifecycle && !recoverableDeliveryTerminalized) {
        await runArgs.turnLifecycle!.fail({
          conversationId: lifecycle.conversationId,
          turnId: lifecycle.turnId,
          createdAtMs: Date.now(),
          failureCode: "persistence_failed",
          ...(eventId ? { eventId } : {}),
        });
      }
    } else {
      deferredFailureHandler = async () => {
        await handleResumeFailure({
          body: "Failed to resume Slack turn",
          error,
          eventName: "slack_resume_turn_failed",
          lockKey,
          lifecycle,
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
        lifecycle,
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
  recoverableSlackDelivery?: RecoverableSlackDelivery;
  inputMessageIds?: string[];
  sliceId?: number;
  lifecycleCorrelation?: ResumeLifecycleCorrelation;
  turnLifecycle?: ConversationTurnLifecycle;
  onSuccess?: (reply: AgentRunResult) => Promise<void>;
  onRecoveredSuccess?: () => Promise<void>;
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
    recoverableSlackDelivery: args.recoverableSlackDelivery,
    inputMessageIds: args.inputMessageIds,
    sliceId: args.sliceId,
    lifecycleCorrelation: args.lifecycleCorrelation,
    turnLifecycle: args.turnLifecycle,
    onSuccess: args.onSuccess,
    onRecoveredSuccess: args.onRecoveredSuccess,
    onFailure: args.onFailure,
    onAuthPause: args.onAuthPause,
    onTimeoutPause: args.onTimeoutPause,
    onPostDeliveryCommitFailure: args.onPostDeliveryCommitFailure,
    beforeStart: args.beforeStart,
    replyTimeoutMs: args.replyTimeoutMs,
  });
}
