/**
 * Slack resume execution boundary.
 *
 * Resumed turns run from persisted request context under the Slack thread lock.
 * Status notices are best effort. Completed assistant replies and auth-pause
 * notices use `sendSlackReply` so footer attachment stays consistent.
 */
import type { ReplyAttribution } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import { standardModelId } from "@/chat/model-profile";
import { configValueSchema } from "@/chat/configuration/types";
import type {
  ConfigValue,
  LocationConfigurationService,
} from "@/chat/configuration/types";
import {
  RetryableDeliveryError,
  type AgentRunRequest,
} from "@/chat/agent/request";
import type { AgentRunResult } from "@/chat/services/turn-result";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
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
  ConversationTurnLifecycleService,
  type ConversationTurnLifecycle,
} from "@/chat/conversations/turn-lifecycle";
import type { ConversationTurnFailureCode } from "@/chat/conversations/history";
import { getConversationEventStore } from "@/chat/db";
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
  startSlackProcessingReactionForMessage,
  type ProcessingReactionSession,
} from "@/chat/runtime/processing-reaction";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import { buildAuthPauseResponse } from "@/chat/services/auth-pause-response";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
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
    // Resume-side status notices should not decide whether the turn succeeds.
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
      throw new Error("Read-only configuration in resumed context");
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

/** Error raised when another worker already owns the resume lock. */
export class ResumeTurnBusyError extends Error {
  constructor(lockKey: string) {
    super(`A turn already owns resume lock "${lockKey}"`);
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
  replyContext?: ResumeReplyContext;
  lockKey?: string;
  /**
   * When true, the caller already holds the conversation work lease.
   * Skip the second resume lock so queue continue is one owner, not two.
   * OAuth and other out-of-band resumes leave this false.
   */
  ownsConversationLease?: boolean;
  initialText?: string;
  initialStatus?: AssistantStatusSpec;
  agentRunner: AgentRunner;
  inputMessageIds?: string[];
  turnLifecycle?: ConversationTurnLifecycle;
  scheduleSessionCompletedPluginTasks?: (params: {
    conversationId: string;
    sessionId: string;
  }) => Promise<void>;
  commitResult?: (result: AgentRunResult) => Promise<void>;
  onFailure?: (error: unknown) => Promise<void>;
  onAuthPause?: (pause: { providerDisplayName: string }) => Promise<void>;
  onSuspend?: (resumeVersion: number) => Promise<void>;
  onPostDeliveryCommitFailure?: (error: unknown) => Promise<void>;
  beforeStart?: () => Promise<ResumePreparedTurn | false | void>;
  replyTimeoutMs?: number;
}

// Resume args carry the user message text, so stored contexts hold only the
// remaining input fields.
type ResumeReplyContext = Omit<
  AgentRunRequest,
  "conversationId" | "turnId" | "runId" | "input" | "delivery"
> & {
  input?: Omit<AgentRunRequest["input"], "messageText">;
};

interface ResumePreparedTurn {
  messageText: string;
  /** Active durable execution slice being resumed. */
  sliceId?: number;
  messageTs?: SlackMessageTs;
  inputMessageIds?: string[];
  initialStatus?: AssistantStatusSpec;
  replyContext: ResumeReplyContext;
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
  const routing = args.replyContext?.routing;
  const actor = routing?.actor;
  return {
    conversationId: args.conversationId,
    messageConversationId: lockKey,
    userId: isUserActor(actor) ? actor.userId : undefined,
    userName: isUserActor(actor) ? actor.userName : undefined,
    destinationName: args.channelId,
    assistantUserName: botConfig.userName,
    modelId: standardModelId(botConfig),
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
  body: string;
  error: unknown;
  eventName: string;
  lockKey: string;
  turnLifecycle: ConversationTurnLifecycle;
  failureCode: ConversationTurnFailureCode;
  resumeArgs: ResumeSlackTurnArgs;
}): Promise<void> {
  const capturedEventId = logException(args.error, args.eventName);
  const eventId = requireTurnFailureEventId(capturedEventId, args.eventName);
  let failureStatePersistError: unknown;
  try {
    await args.resumeArgs.onFailure?.(args.error);
  } catch (persistError) {
    const persistEventId = logException(
      persistError,
      "slack.resume.failure_state_persist.failed",
      { "app.error.original_event_id": eventId },
    );
    try {
      await args.turnLifecycle.fail({
        conversationId: args.resumeArgs.conversationId,
        turnId: args.resumeArgs.turnId,
        createdAtMs: Date.now(),
        failureCode: "persistence_failed",
        ...(persistEventId ? { eventId: persistEventId } : {}),
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
      channelId: args.resumeArgs.channelId,
      threadTs: args.resumeArgs.threadTs,
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
        conversationId: args.resumeArgs.conversationId,
        turnId: args.resumeArgs.turnId,
        createdAtMs: Date.now(),
        failureCode: "delivery_failed",
        ...(deliveryEventId ? { eventId: deliveryEventId } : {}),
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
    conversationId: args.resumeArgs.conversationId,
    turnId: args.resumeArgs.turnId,
    createdAtMs: Date.now(),
    failureCode: args.failureCode,
    eventId,
  });
}

function createResumeReplyContext(
  args: ResumeSlackTurnArgs,
  statusSession: AssistantStatusSession,
  delivery: NonNullable<AgentRunRequest["delivery"]>,
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
  const persistedLocationConfiguration =
    replyContext.policy?.locationConfiguration ??
    (replyContext.policy?.configuration
      ? createReadOnlyConfigService(replyContext.policy.configuration)
      : undefined);

  return {
    conversationId: args.conversationId,
    turnId: args.turnId,
    input: {
      ...(replyContext.input ?? {}),
      messageText: args.messageText,
    },
    routing: {
      ...replyContext.routing,
      source:
        source.platform === "slack"
          ? {
              ...source,
              channelId: args.channelId,
              ...(args.threadTs ? { threadTs: args.threadTs } : {}),
            }
          : source,
    },
    policy: {
      ...replyContext.policy,
      turnDeadlineAtMs:
        replyContext.policy?.turnDeadlineAtMs ?? requestDeadline?.deadlineAtMs,
      locationConfiguration: persistedLocationConfiguration,
    },
    state: replyContext.state,
    observers: {
      ...replyContext.observers,
      onStatus: async (nextStatus) => {
        statusSession.update(nextStatus);
        await replyContext.observers?.onStatus?.(nextStatus);
      },
    },
    delivery,
    durability: {
      ...replyContext.durability,
      onSandboxRefChanged: async (sandboxRef) => {
        await persistThreadStateById(threadId, {
          sandboxRef,
        });
        await replyContext.durability?.onSandboxRefChanged?.(sandboxRef);
      },
    },
  };
}

/**
 * Resume a paused Slack turn.
 *
 * Queue continues pass `ownsConversationLease` and skip the second lock
 * (worker lease is already held). OAuth and other out-of-band resumes still
 * take the thread lock. Started resumes own their completion side effects.
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
  // Worker continue already holds the conversation lease. Taking a second
  // active lock here was a dual-machine leftover (lease + resume lock).
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
  let processingReaction: ProcessingReactionSession | undefined;
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
  let postDeliveryCommitError: unknown;
  const turnLifecycle =
    args.turnLifecycle ??
    new ConversationTurnLifecycleService(getConversationEventStore());
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
          ...(userMessageId ? { userMessageId } : {}),
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
        ...(userMessageId ? { userMessageId } : {}),
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
      let slackMessageTs: string[];
      try {
        slackMessageTs = await sendSlackReply({
          channelId: runArgs.channelId,
          conversationId: runArgs.conversationId,
          replyAttribution:
            runArgs.replyContext?.routing.dispatch?.replyAttribution,
          text,
          threadTs: runArgs.threadTs,
        });
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
        text,
        userMessageId: deliveryState.userMessageId,
      });
      if (messageTs) {
        markConversationMessage(deliveryState.conversation, recordedMessageId, {
          slackTs: messageTs,
        });
      }
      try {
        const routing = runArgs.replyContext?.routing;
        const destination = routing?.destination;
        const providerConversationIds = runArgs.threadTs
          ? [runArgs.threadTs]
          : slackMessageTs;
        await persistWithRetry(() =>
          commitAcceptedReply({
            ...(message ? { agentMessage: message } : {}),
            conversation: deliveryState.conversation,
            conversationMessageId: recordedMessageId,
            conversationId,
            ...(routing?.dispatch &&
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
              : {}),
          }),
        );
      } catch (error) {
        logException(
          new Error("Accepted assistant message persistence failed"),
          "slack.resume.assistant_message_post_delivery_persist.failed",
          { "error.type": error instanceof Error ? error.name : typeof error },
        );
      }
      const routing = runArgs.replyContext?.routing;
      const dispatchId = routing?.dispatch?.id;
      if (messageTs && dispatchId && routing) {
        try {
          await persistWithRetry(() =>
            recordTurnSummary({
              conversationId: runArgs.conversationId,
              destination: routing.destination,
              destinationVisibility: routing.destinationVisibility,
              dispatchId,
              resultMessageId: messageTs,
              turnId: runArgs.turnId,
              sliceId: runArgs.sliceId ?? 1,
              source: routing.source,
              state: "running",
              surface: routing.surface ?? "slack",
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
    const replyContext = createResumeReplyContext(
      runArgs,
      status,
      deliverAssistantMessage,
    );
    if (runArgs.inputMessageIds?.length) {
      await turnLifecycle.start({
        conversationId: runArgs.conversationId,
        turnId: runArgs.turnId,
        createdAtMs: Date.now(),
        inputMessageIds: [...new Set(runArgs.inputMessageIds)],
        surface: "slack",
      });
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
      const onSuspend = runArgs.onSuspend;
      if (outcome.status === "awaiting_auth" && onAuthPause) {
        deferredAuthInfo = {
          providerDisplayName: outcome.providerDisplayName,
          actorId: isUserActor(resumeActor) ? resumeActor.userId : undefined,
          ...(outcome.requestText ? { requestText: outcome.requestText } : {}),
        };
        deferredPauseHandler = async () => {
          await onAuthPause({
            providerDisplayName: outcome.providerDisplayName,
          });
        };
      } else if (outcome.status === "suspended" && onSuspend) {
        deferredPauseHandler = async () => {
          await onSuspend(outcome.resumeVersion);
        };
      } else {
        deferredFailureHandler = async () => {
          await handleResumeFailure({
            body: "Failed to resume Slack turn",
            error: new Error(
              `Resumed run ended ${outcome.status} without a pause handler`,
            ),
            eventName: "slack.resume.turn.failed",
            failureCode: "agent_run_failed",
            turnLifecycle,
            lockKey,
            resumeArgs: runArgs,
          });
        };
      }
    } else {
      const finalized = finalizeFailedTurnReplyWithEvent({
        reply: outcome.result,
        logException,
      });
      const reply = finalized.reply;
      const dispatchErrorMessage =
        replyContext.routing.dispatch && reply.diagnostics.outcome !== "success"
          ? (reply.diagnostics.errorMessage ??
            `Agent turn ended with ${reply.diagnostics.outcome}.`)
          : undefined;
      if (reply.diagnostics.outcome !== "success") {
        await deliverAssistantMessage(reply.text);
      }
      runResultHandled = true;

      await status.clear();
      failureCode = "persistence_failed";
      // Output handling is the completion boundary: only now commit the
      // completed session record. Persistence is retried and any remaining
      // failure reaches this runtime boundary instead of being mistaken for a
      // completed durable turn.
      if (reply.piMessages?.length) {
        await saveTurnCheckpoint({
          mode: "completed",
          conversationId: runArgs.conversationId,
          turnId: runArgs.turnId,
          messages: reply.piMessages,
          durationMs: reply.diagnostics.durationMs,
          usage: reply.diagnostics.usage,
          destination: replyContext.routing.destination,
          destinationVisibility: replyContext.routing.destinationVisibility,
          dispatchId: replyContext.routing.dispatch?.id,
          dispatchOutcome:
            reply.diagnostics.outcome === "success" ? "completed" : "failed",
          ...(dispatchErrorMessage
            ? { errorMessage: dispatchErrorMessage }
            : {}),
          ...(acceptedDeliveryId
            ? { resultMessageId: acceptedDeliveryId }
            : {}),
          source: replyContext.routing.source,
          actor: resumeActor,
          surface: replyContext.routing.surface ?? "slack",
          sliceId: runArgs.sliceId,
        });
      } else if (replyContext.routing.dispatch?.id) {
        await recordTurnSummary({
          conversationId: runArgs.conversationId,
          destination: replyContext.routing.destination,
          destinationVisibility: replyContext.routing.destinationVisibility,
          dispatchId: replyContext.routing.dispatch?.id,
          dispatchOutcome:
            reply.diagnostics.outcome === "success" ? "completed" : "failed",
          ...(acceptedDeliveryId
            ? { resultMessageId: acceptedDeliveryId }
            : {}),
          turnId: runArgs.turnId,
          sliceId: runArgs.sliceId ?? 1,
          source: replyContext.routing.source,
          state:
            reply.diagnostics.outcome === "success" ? "completed" : "failed",
          surface: replyContext.routing.surface ?? "slack",
        });
      }
      await runArgs.commitResult?.(reply);
      if (reply.diagnostics.outcome === "success") {
        await turnLifecycle.complete({
          conversationId: runArgs.conversationId,
          turnId: runArgs.turnId,
          createdAtMs: Date.now(),
          outcome: assistantMessageDelivered ? "success" : "no_reply",
        });
      } else {
        await turnLifecycle.fail({
          conversationId: runArgs.conversationId,
          turnId: runArgs.turnId,
          createdAtMs: Date.now(),
          failureCode: "model_execution_failed",
          ...(finalized.eventId ? { eventId: finalized.eventId } : {}),
        });
      }
      if (reply.diagnostics.outcome === "success") {
        try {
          const params = {
            conversationId: runArgs.conversationId,
            sessionId: runArgs.turnId,
          };
          if (runArgs.scheduleSessionCompletedPluginTasks) {
            await runArgs.scheduleSessionCompletedPluginTasks(params);
          } else {
            await scheduleSessionCompletedPluginTasks(params);
          }
        } catch (scheduleError) {
          logException(
            scheduleError,
            "plugin.session.completed_task_schedule.failed",
          );
        }
      }
    }
  } catch (error) {
    await status.clear();

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
          body: "Failed to resume Slack turn",
          error,
          eventName: "slack.resume.turn.failed",
          failureCode,
          turnLifecycle,
          lockKey,
          resumeArgs: runArgs,
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
      ...(eventId ? { eventId } : {}),
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
          runArgs.replyContext?.routing.dispatch?.replyAttribution,
        );
      }
      return true;
    } catch (pauseError) {
      await handleResumeFailure({
        body: "Failed to handle resumed turn pause",
        error: pauseError,
        eventName: "slack.resume.pause_handler.failed",
        failureCode: "persistence_failed",
        turnLifecycle,
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
