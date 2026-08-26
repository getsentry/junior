/**
 * Resume a Slack Turn from saved Run state.
 *
 * Resumed Turns load their saved Run while holding the Slack thread lock.
 * Status notices are best effort. Completed assistant replies and
 * authorization pause notices use `sendSlackReply` so the footer stays
 * consistent.
 */
import type { ReplyAttribution } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import { defaultModelId } from "@/chat/model-profile";
import { configValueSchema } from "@/chat/configuration/types";
import type {
  ConfigValue,
  LocationConfigurationService,
} from "@/chat/configuration/types";
import {
  RetryableDeliveryError,
  type AgentDelivery,
  type AgentRun,
} from "@/chat/agent/types";
import type { AgentRunResult } from "@/chat/services/turn-result";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentRunError, type ExecuteTurn } from "@/chat/runtime/turn-execution";
import { scheduleSessionCompletedPluginTasks } from "@/chat/plugins/task-runner";
import {
  buildTurnFailureResponse,
  logException,
  setTags,
  withLogContext,
  type LogContext,
} from "@/chat/logging";
import {
  finalizeFailedTurnReplyWithEvent,
  requireTurnFailureEventId,
} from "@/chat/services/turn-failure-response";
import {
  getTurnLifecycle,
  type ConversationTurnLifecycle,
} from "@/chat/conversations/turn-lifecycle";
import type { ConversationTurnFailureCode } from "@/chat/conversations/history";
import {
  recordTurnSummary,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import {
  createSlackWebApiAssistantStatusSession,
  type AssistantStatusSession,
  type AssistantStatusSpec,
} from "@/chat/slack/assistant-thread/status";
import { sendSlackReply } from "@/chat/slack/reply";
import { isUserActor, type Actor } from "@/chat/actor";
import { postSlackMessage as postSlackApiMessage } from "@/chat/slack/outbound";
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import {
  startProcessingReactionForMessage,
  type ProcessingReaction,
} from "@/chat/providers/slack/processing-reaction";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import { buildAuthPauseResponse } from "@/chat/services/auth-pause-response";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import {
  CooperativeTurnYieldError,
  isCooperativeTurnYieldError,
} from "@/chat/runtime/turn";
import {
  TurnSliceLimitExceededError,
  buildTurnLimitResponse,
} from "@/chat/services/turn-limit";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { commitAcceptedReply } from "@/chat/conversations/projection";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { getTurnUserMessage } from "@/chat/runtime/turn-user-message";
import {
  markConversationMessage,
  recordDeliveredAssistantMessage,
  turnHasReply,
} from "@/chat/services/conversation-memory";
import { persistWithRetry } from "@/chat/services/persist-retry";
import { isRetryableSlackPostError } from "@/chat/slack/errors";

function resolveReplyTimeoutMs(): number | undefined {
  const raw = process.env.EVAL_AGENT_REPLY_TIMEOUT_MS?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function postSlackMessageBestEffort(
  channelId: string,
  threadTs: string | undefined,
  text: string,
  conversationId?: string,
  replyAttribution?: ReplyAttribution,
): Promise<void> {
  try {
    if (conversationId) {
      await sendSlackReply({
        channelId,
        conversationId,
        replyAttribution,
        text,
        threadTs,
      });
      return;
    }

    await postSlackApiMessage({ channelId, threadTs, text });
  } catch {
    // Status notices do not decide whether the Turn succeeds.
  }
}

/** Create a read-only configuration service from persisted values. */
function createReadOnlyConfigService(
  rawValues: Record<string, unknown>,
): LocationConfigurationService {
  const values: Record<string, ConfigValue> = Object.fromEntries(
    Object.entries(rawValues).map(([key, value]) => [
      key,
      configValueSchema.parse(value),
    ]),
  );
  const entries = Object.entries(values).map(([key, value]) => ({
    key,
    value,
    scope: "location" as const,
    updatedAt: new Date().toISOString(),
  }));

  return {
    get: async (key) => entries.find((entry) => entry.key === key),
    set: async () => {
      throw new Error("Configuration is read-only for a resumed Run");
    },
    unset: async () => false,
    list: async ({ prefix } = {}) =>
      entries.filter((entry) => !prefix || entry.key.startsWith(prefix)),
    resolve: async (key) => values[key],
    resolveValues: async ({ keys, prefix } = {}) => {
      const filtered: Record<string, ConfigValue> = {};
      for (const [key, value] of Object.entries(values)) {
        if (prefix && !key.startsWith(prefix)) continue;
        if (keys && !keys.includes(key)) continue;
        filtered[key] = value;
      }
      return filtered;
    },
  };
}

/** Error raised when another worker is already resuming the Slack Turn. */
export class ResumeTurnBusyError extends Error {
  constructor(lockKey: string) {
    super(`Another worker is already resuming Slack Turn "${lockKey}"`);
    this.name = "ResumeTurnBusyError";
  }
}

interface ResumeSlackTurnArgs {
  messageText: string;
  conversationId: string;
  turnId: string;
  /** Active durable execution slice being resumed. */
  sliceId?: number;
  channelId: string;
  threadTs?: string;
  messageTs?: SlackMessageTs;
  /** Saved Run fields. `beforeStart` may supply them after stale-work checks. */
  run?: ResumeRun;
  lockKey?: string;
  /**
   * When true, the caller already holds the conversation work lease.
   * Skip the second resume lock so the queue continuation has one owner.
   * Authorization callbacks and other independent resumes leave this false.
   */
  ownsConversationLease?: boolean;
  initialText?: string;
  initialStatus?: AssistantStatusSpec;
  executeTurn: ExecuteTurn;
  inputMessageIds?: string[];
  scheduleSessionCompletedPluginTasks?: typeof scheduleSessionCompletedPluginTasks;
  commitResult?: (result: AgentRunResult) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (pause: { providerDisplayName: string }) => Promise<void>;
  onSuspend?: (resumeVersion: number) => Promise<void>;
  onPostDeliveryCommitFailure?: (error: unknown) => Promise<void>;
  beforeStart?: () => Promise<ResumePreparedTurn | false | void>;
}

// Resume input carries the instruction text separately from the saved Run.
type ResumeRun = Omit<
  AgentRun,
  "conversationId" | "turnId" | "runId" | "instruction" | "delivery"
> & {
  instruction?: Omit<AgentRun["instruction"], "text">;
};

interface ResumePreparedTurn {
  messageText: string;
  /** Active durable execution slice being resumed. */
  sliceId?: number;
  messageTs?: SlackMessageTs;
  inputMessageIds?: string[];
  initialStatus?: AssistantStatusSpec;
  run: ResumeRun;
  commitResult?: (result: AgentRunResult) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (pause: { providerDisplayName: string }) => Promise<void>;
  onSuspend?: (resumeVersion: number) => Promise<void>;
  onPostDeliveryCommitFailure?: (error: unknown) => Promise<void>;
}

function getDefaultLockKey(
  channelId: string,
  threadTs: string | undefined,
): string {
  return threadTs ? `slack:${channelId}:${threadTs}` : `slack:${channelId}`;
}

function getResumeLogContext(
  args: ResumeSlackTurnArgs,
  lockKey: string,
): LogContext {
  const actor = args.run?.actor;
  return {
    conversationId: args.conversationId,
    messageConversationId: lockKey,
    userId: isUserActor(actor) ? actor.userId : undefined,
    userName: isUserActor(actor) ? actor.userName : undefined,
    destinationName: args.channelId,
    assistantUserName: botConfig.userName,
    modelId: defaultModelId(botConfig),
  };
}

async function postResumeFailureReply(args: {
  channelId: string;
  threadTs?: string;
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

async function handleResumeFailure(args: {
  error: unknown;
  eventName: string;
  turnLifecycle: ConversationTurnLifecycle;
  failureCode: ConversationTurnFailureCode;
  resume: ResumeSlackTurnArgs;
}): Promise<void> {
  const capturedEventId = logException(args.error, args.eventName);
  const eventId = requireTurnFailureEventId(capturedEventId, args.eventName);
  let failureStatePersistError: unknown;
  try {
    await args.resume.onFailure?.(args.error);
  } catch (persistError) {
    const persistEventId = logException(
      persistError,
      "slack.resume.failure_state_persist.failed",
      { "app.error.original_event_id": eventId },
    );
    try {
      await args.turnLifecycle.fail({
        conversationId: args.resume.conversationId,
        turnId: args.resume.turnId,
        createdAtMs: Date.now(),
        failureCode: "persistence_failed",
        ...(persistEventId ? { eventId: persistEventId } : undefined),
      });
    } catch (lifecycleError) {
      logException(
        lifecycleError,
        "slack.resume.failure_lifecycle_persist.failed",
        { "app.error.original_event_id": eventId },
      );
    }
    failureStatePersistError = persistError;
  }
  try {
    await postResumeFailureReply({
      channelId: args.resume.channelId,
      threadTs: args.resume.threadTs,
      eventId,
      error: args.error,
    });
  } catch (deliveryError) {
    const deliveryEventId = logException(
      deliveryError,
      "slack.resume.failure_delivery.failed",
      { "app.error.original_event_id": eventId },
    );
    try {
      await args.turnLifecycle.fail({
        conversationId: args.resume.conversationId,
        turnId: args.resume.turnId,
        createdAtMs: Date.now(),
        failureCode: "delivery_failed",
        ...(deliveryEventId ? { eventId: deliveryEventId } : undefined),
      });
    } catch (lifecycleError) {
      logException(
        lifecycleError,
        "slack.resume.failure_lifecycle_persist.failed",
        { "app.error.original_event_id": eventId },
      );
    }
    throw deliveryError;
  }
  if (failureStatePersistError) {
    throw failureStatePersistError;
  }
  await args.turnLifecycle.fail({
    conversationId: args.resume.conversationId,
    turnId: args.resume.turnId,
    createdAtMs: Date.now(),
    failureCode: args.failureCode,
    eventId,
  });
}

function buildResumedRun(
  args: ResumeSlackTurnArgs,
  statusSession: AssistantStatusSession,
  delivery: AgentDelivery,
): AgentRun {
  const savedRun = args.run;
  if (!savedRun) {
    throw new TypeError("Slack resume requires a saved Run");
  }
  if (!savedRun.source) {
    throw new TypeError("Slack resume requires a Run Source");
  }
  const source = savedRun.source;
  if (savedRun.destination.platform !== "slack") {
    throw new TypeError("Slack resume requires a Slack Destination");
  }
  const requestDeadline = getTurnRequestDeadline();
  const threadId =
    args.lockKey ?? getDefaultLockKey(args.channelId, args.threadTs);
  const persistedLocationConfiguration =
    savedRun.environment?.locationConfiguration ??
    (savedRun.environment?.configuration
      ? createReadOnlyConfigService(savedRun.environment.configuration)
      : undefined);
  const priorOnEvent = savedRun.onEvent;

  return {
    ...savedRun,
    conversationId: args.conversationId,
    turnId: args.turnId,
    instruction: {
      ...(savedRun.instruction ?? { text: args.messageText }),
      text: args.messageText,
    },
    source:
      source.platform === "slack"
        ? {
            ...source,
            channelId: args.channelId,
            ...(args.threadTs ? { threadTs: args.threadTs } : undefined),
          }
        : source,
    deadlineAtMs: savedRun.deadlineAtMs ?? requestDeadline?.deadlineAtMs,
    environment: {
      ...savedRun.environment,
      locationConfiguration: persistedLocationConfiguration,
    },
    onEvent: async (event) => {
      if (event.type === "status") {
        statusSession.update({ text: event.text });
      }
      await priorOnEvent?.(event);
    },
    delivery,
    durability: {
      ...savedRun.durability,
      onSandboxRefChanged: async (sandboxRef) => {
        await persistThreadStateById(threadId, {
          sandboxRef,
        });
        await savedRun.durability?.onSandboxRefChanged?.(sandboxRef);
      },
    },
  };
}

/**
 * Resume a paused Slack Turn.
 *
 * Queue continuations pass `ownsConversationLease` and skip the second lock
 * because the worker lease is already held. Authorization callbacks and other
 * independent resumes still take the thread lock. A started resume owns its
 * completion work.
 * Returns false only when `beforeStart` proves the resume is stale before
 * generation begins.
 */
export async function resumeSlackTurn(
  args: ResumeSlackTurnArgs,
): Promise<boolean> {
  const lockKey =
    args.lockKey ?? getDefaultLockKey(args.channelId, args.threadTs);
  return withLogContext(getResumeLogContext(args, lockKey), () =>
    resumeSlackTurnInContext(args),
  );
}

async function resumeSlackTurnInContext(
  args: ResumeSlackTurnArgs,
): Promise<boolean> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const lockKey =
    args.lockKey ?? getDefaultLockKey(args.channelId, args.threadTs);
  // A worker continuation already holds the Conversation lease. Do not take
  // another lock for the same work.
  const lock = args.ownsConversationLease
    ? undefined
    : await acquireActiveLock(stateAdapter, lockKey);
  if (!args.ownsConversationLease && !lock) {
    throw new ResumeTurnBusyError(lockKey);
  }

  const status = createSlackWebApiAssistantStatusSession({
    channelId: args.channelId,
    threadTs: args.threadTs,
  });
  let processingReaction: ProcessingReaction | undefined;
  let deferredAuthInfo:
    | {
        providerDisplayName: string;
        actorId: string | undefined;
        requestText?: string;
      }
    | undefined;
  let deferredPauseHandler: (() => Promise<void>) | undefined;
  let deferredFailureHandler: (() => Promise<void>) | undefined;
  let runResultHandled = false;
  let assistantMessageDelivered = false;
  let shouldScheduleCompletedPluginTasks = false;
  let postDeliveryCommitError: unknown;
  const turnLifecycle = getTurnLifecycle();
  let failureCode: ConversationTurnFailureCode = "agent_run_failed";
  let runArgs = args;
  try {
    const preparedArgs = await args.beforeStart?.();
    if (preparedArgs === false) {
      return false;
    }
    if (preparedArgs) {
      runArgs = { ...args, ...preparedArgs };
    }
    setTags(getResumeLogContext(runArgs, lockKey));

    const savedRun = runArgs.run;
    if (!savedRun) {
      throw new Error("Resumed Turn requires a saved Run");
    }
    const credentialContext = savedRun.credentialContext;
    if (!credentialContext) {
      throw new Error("Resumed Run requires a credential context");
    }
    const routingActor = savedRun.actor;
    let resumeActor: Actor;
    if ("type" in credentialContext.actor) {
      if (
        !isUserActor(routingActor) ||
        credentialContext.actor.userId !== routingActor.userId
      ) {
        throw new Error("Resumed Run credential actor must match its Actor");
      }
      resumeActor = routingActor;
    } else {
      if (
        routingActor &&
        (routingActor.platform !== "system" ||
          routingActor.name !== credentialContext.actor.name)
      ) {
        throw new Error(
          "Resumed Run system credential actor must match its Actor",
        );
      }
      resumeActor = credentialContext.actor;
    }

    if (runArgs.messageTs) {
      processingReaction = await startProcessingReactionForMessage({
        channelId: runArgs.channelId,
        timestamp: runArgs.messageTs,
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

    const conversationId = runArgs.conversationId;
    const visibleConversationId = lockKey;
    const sessionId = runArgs.turnId;
    let deliveryConversation:
      | ReturnType<typeof coerceThreadConversationState>
      | undefined;
    let acceptedDeliveryId: string | undefined;
    /** Load the resumed conversation once for ordered delivery recording. */
    const getDeliveryConversation = async () => {
      if (deliveryConversation) {
        const userMessageId = getTurnUserMessage(
          deliveryConversation,
          sessionId,
        )?.id;
        return {
          conversation: deliveryConversation,
          sessionId,
          ...(userMessageId ? { userMessageId } : undefined),
        };
      }
      const persistedState = await getPersistedThreadState(
        visibleConversationId,
      );
      const conversation = coerceThreadConversationState(persistedState);
      await hydrateConversationMessages({
        conversation,
        conversationId,
      });
      deliveryConversation = conversation;
      const userMessageId = getTurnUserMessage(conversation, sessionId)?.id;
      return {
        conversation,
        sessionId,
        ...(userMessageId ? { userMessageId } : undefined),
      };
    };
    /** Post and record one completed assistant message for the resumed turn. */
    const deliverAssistantMessage = async (
      reply: AssistantMessage | string,
    ): Promise<void> => {
      const message = typeof reply === "string" ? undefined : reply;
      const text =
        typeof reply === "string" ? reply : getAssistantReplyText(reply);
      if (!text?.trim()) {
        return;
      }
      failureCode = "delivery_failed";
      const deliveryState = await getDeliveryConversation();
      let slackMessageTs: string[] = [];
      try {
        if (runArgs.run?.publishExternally !== false) {
          slackMessageTs = await sendSlackReply({
            channelId: runArgs.channelId,
            conversationId: runArgs.conversationId,
            replyAttribution: runArgs.run?.dispatch?.replyAttribution,
            text,
            threadTs: runArgs.threadTs,
          });
        }
      } catch (error) {
        if (isRetryableSlackPostError(error)) {
          throw new RetryableDeliveryError(error);
        }
        throw error;
      }
      const messageTs = slackMessageTs.at(-1);
      assistantMessageDelivered = true;
      acceptedDeliveryId = messageTs;
      const recordedMessageId = recordDeliveredAssistantMessage({
        conversation: deliveryState.conversation,
        sessionId: deliveryState.sessionId,
        source: "slack",
        text,
        userMessageId: deliveryState.userMessageId,
      });
      if (messageTs) {
        markConversationMessage(deliveryState.conversation, recordedMessageId, {
          slackTs: messageTs,
        });
      }
      try {
        const destination = runArgs.run?.destination;
        const providerConversationIds = runArgs.threadTs
          ? [runArgs.threadTs]
          : slackMessageTs;
        await persistWithRetry(() =>
          commitAcceptedReply({
            ...(message ? { agentMessage: message } : undefined),
            conversation: deliveryState.conversation,
            conversationMessageId: recordedMessageId,
            conversationId,
            ...(runArgs.run?.dispatch &&
            destination?.platform === "slack" &&
            providerConversationIds.length > 0
              ? {
                  providerConversationBindings: providerConversationIds.map(
                    (providerConversationId) => ({
                      provider: "slack",
                      providerDestinationId: destination.channelId,
                      providerTenantId: destination.teamId,
                      providerConversationId,
                    }),
                  ),
                }
              : undefined),
          }),
        );
      } catch (error) {
        logException(
          new Error("Accepted assistant message persistence failed"),
          "slack.resume.assistant_message_post_delivery_persist.failed",
          { "error.type": error instanceof Error ? error.name : typeof error },
        );
      }
      const dispatchId = savedRun.dispatch?.id;
      if (messageTs && dispatchId) {
        try {
          await persistWithRetry(() =>
            recordTurnSummary({
              conversationId: runArgs.conversationId,
              destination: savedRun.destination,
              destinationVisibility: savedRun.destinationVisibility,
              dispatchId,
              resultMessageId: messageTs,
              turnId: runArgs.turnId,
              sliceId: runArgs.sliceId ?? 1,
              source: savedRun.source,
              state: "running",
              surface: savedRun.surface ?? "slack",
            }),
          );
        } catch (error) {
          logException(error, "agent.turn.delivery_receipt_persist.failed");
        }
      }
      failureCode = "agent_run_failed";
    };
    const deliveryState = await getDeliveryConversation();
    assistantMessageDelivered = turnHasReply(
      deliveryState.conversation,
      sessionId,
    );
    const run = buildResumedRun(runArgs, status, deliverAssistantMessage);
    if (runArgs.inputMessageIds?.length) {
      await turnLifecycle.start({
        conversationId: runArgs.conversationId,
        turnId: runArgs.turnId,
        createdAtMs: Date.now(),
        inputMessageIds: [...new Set(runArgs.inputMessageIds)],
        surface: "slack",
      });
    }
    const replyTimeoutMs = resolveReplyTimeoutMs();
    const outcome = await runArgs.executeTurn(
      run,
      async (result) => {
        const finalized = finalizeFailedTurnReplyWithEvent({
          reply: result,
          logException,
        });
        const reply = finalized.reply;
        const dispatchErrorMessage =
          run.dispatch && reply.diagnostics.outcome !== "success"
            ? (reply.diagnostics.errorMessage ??
              `Agent turn ended with ${reply.diagnostics.outcome}.`)
            : undefined;
        if (reply.diagnostics.outcome !== "success") {
          await deliverAssistantMessage(reply.text);
        }
        runResultHandled = true;

        await status.clear();
        failureCode = "persistence_failed";
        // Save the completed Turn only after delivery. A remaining write
        // failure must reach this provider instead of completing durable work.
        if (reply.piMessages?.length) {
          await saveTurnCheckpoint({
            mode: "completed",
            conversationId: runArgs.conversationId,
            turnId: runArgs.turnId,
            messages: reply.piMessages,
            durationMs: reply.diagnostics.durationMs,
            usage: reply.diagnostics.usage,
            destination: run.destination,
            destinationVisibility: run.destinationVisibility,
            dispatchId: run.dispatch?.id,
            dispatchOutcome:
              reply.diagnostics.outcome === "success" ? "completed" : "failed",
            ...(dispatchErrorMessage
              ? { errorMessage: dispatchErrorMessage }
              : undefined),
            ...(acceptedDeliveryId
              ? { resultMessageId: acceptedDeliveryId }
              : undefined),
            source: run.source,
            actor: resumeActor,
            surface: run.surface ?? "slack",
            sliceId: runArgs.sliceId,
          });
        } else if (run.dispatch?.id) {
          await recordTurnSummary({
            conversationId: runArgs.conversationId,
            destination: run.destination,
            destinationVisibility: run.destinationVisibility,
            dispatchId: run.dispatch?.id,
            dispatchOutcome:
              reply.diagnostics.outcome === "success" ? "completed" : "failed",
            ...(acceptedDeliveryId
              ? { resultMessageId: acceptedDeliveryId }
              : undefined),
            turnId: runArgs.turnId,
            sliceId: runArgs.sliceId ?? 1,
            source: run.source,
            state:
              reply.diagnostics.outcome === "success" ? "completed" : "failed",
            surface: run.surface ?? "slack",
          });
        }
        await runArgs.commitResult?.(reply);
        if (reply.diagnostics.outcome === "success") {
          shouldScheduleCompletedPluginTasks = true;
          return {
            outcome: assistantMessageDelivered ? "success" : "no_reply",
          };
        }

        return {
          outcome: "failed",
          failureCode: "model_execution_failed",
          ...(finalized.eventId ? { eventId: finalized.eventId } : undefined),
          ...(finalized.failureReason
            ? { failureReason: finalized.failureReason }
            : undefined),
        };
      },
      replyTimeoutMs,
    );
    if (outcome.status !== "completed") {
      // Expected pauses defer their handlers until the lock is released,
      // mirroring the failure path below.
      await status.clear();
      const onAuthPause = runArgs.onAuthPause;
      const onSuspend = runArgs.onSuspend;
      if (outcome.status === "awaiting_auth" && onAuthPause) {
        deferredAuthInfo = {
          providerDisplayName: outcome.providerDisplayName,
          actorId: isUserActor(resumeActor) ? resumeActor.userId : undefined,
          ...(outcome.requestText
            ? { requestText: outcome.requestText }
            : undefined),
        };
        deferredPauseHandler = async () => {
          await onAuthPause({
            providerDisplayName: outcome.providerDisplayName,
          });
        };
      } else if (outcome.status === "suspended") {
        // Queue continue already owns the lease. After a hard timeout, return
        // the lease so the next wake starts with a full request budget.
        if (
          runArgs.ownsConversationLease &&
          (outcome.reason === "timeout" || savedRun.durability?.shouldYield?.())
        ) {
          throw new CooperativeTurnYieldError();
        }
        if (onSuspend) {
          deferredPauseHandler = async () => {
            await onSuspend(outcome.resumeVersion);
          };
        } else {
          deferredFailureHandler = async () => {
            await handleResumeFailure({
              error: new Error("Resumed Run ended suspended without onSuspend"),
              eventName: "slack.resume.turn.failed",
              failureCode: "agent_run_failed",
              turnLifecycle,
              resume: runArgs,
            });
          };
        }
      } else {
        deferredFailureHandler = async () => {
          await handleResumeFailure({
            error: new Error(
              `Resumed Run ended ${outcome.status} without its required callback`,
            ),
            eventName: "slack.resume.turn.failed",
            failureCode: "agent_run_failed",
            turnLifecycle,
            resume: runArgs,
          });
        };
      }
    }
    if (shouldScheduleCompletedPluginTasks) {
      try {
        const params = {
          conversationId: runArgs.conversationId,
          sessionId: runArgs.turnId,
        };
        await (
          runArgs.scheduleSessionCompletedPluginTasks ??
          scheduleSessionCompletedPluginTasks
        )(params);
      } catch (scheduleError) {
        logException(
          scheduleError,
          "plugin.session.completed_task_schedule.failed",
        );
      }
    }
  } catch (error) {
    await status.clear();

    const runError = error instanceof AgentRunError ? error.cause : error;

    // Lease owner must requeue after a hard timeout park. Do not convert this
    // into a user-visible resume failure.
    if (isCooperativeTurnYieldError(runError)) {
      if (lock) {
        await stateAdapter.releaseLock(lock);
      }
      await processingReaction?.stop();
      throw runError;
    }

    if (runResultHandled) {
      postDeliveryCommitError = error;
      try {
        await runArgs.onPostDeliveryCommitFailure?.(error);
      } catch (terminalizeError) {
        logException(
          terminalizeError,
          "slack.resume.post_delivery_terminalize.failed",
        );
      }
    } else {
      deferredFailureHandler = async () => {
        await handleResumeFailure({
          error: runError,
          eventName: "slack.resume.turn.failed",
          failureCode,
          turnLifecycle,
          resume: runArgs,
        });
      };
    }
  } finally {
    if (runResultHandled) {
      await processingReaction?.complete();
    } else {
      await processingReaction?.stop();
    }
    if (lock) {
      await stateAdapter.releaseLock(lock);
    }
  }

  if (postDeliveryCommitError) {
    const eventId = logException(
      postDeliveryCommitError,
      "slack.resume.success_handler.failed",
    );
    await turnLifecycle.fail({
      conversationId: runArgs.conversationId,
      turnId: runArgs.turnId,
      createdAtMs: Date.now(),
      failureCode: "persistence_failed",
      ...(eventId ? { eventId } : undefined),
    });
    throw postDeliveryCommitError;
  }

  if (deferredPauseHandler) {
    try {
      await deferredPauseHandler();
      if (deferredAuthInfo) {
        await postSlackMessageBestEffort(
          runArgs.channelId,
          runArgs.threadTs,
          buildAuthPauseResponse(
            deferredAuthInfo.actorId,
            deferredAuthInfo.providerDisplayName,
            deferredAuthInfo.requestText,
          ),
          runArgs.conversationId,
          runArgs.run?.dispatch?.replyAttribution,
        );
      }
      return true;
    } catch (pauseError) {
      await handleResumeFailure({
        error: pauseError,
        eventName: "slack.resume.pause_handler.failed",
        failureCode: "persistence_failed",
        turnLifecycle,
        resume: runArgs,
      });
      return true;
    }
  }

  if (deferredFailureHandler) {
    await deferredFailureHandler();
  }

  return true;
}
