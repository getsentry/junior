/**
 * Slack event runtime.
 *
 * This module owns inbound Slack routing decisions for mentions, subscribed
 * messages, assistant lifecycle events, and retryable turn pauses. It should
 * normalize text/queued context and decide reply vs silence while keeping
 * Pi/MCP internals and durable session storage behind injected services.
 */
import type { Message, MessageContext, Thread } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { getSubscribedReplyPreflightDecision } from "@/chat/services/subscribed-decision";
import { isProviderRetryError } from "@/chat/services/provider-retry";
import {
  isCooperativeTurnYieldError,
  isTurnInputCommitLostError,
  isRetryableTurnError,
} from "@/chat/runtime/turn";
import { buildTurnFailureResponse } from "@/chat/logging";
import { getSlackErrorObservabilityAttributes } from "@/chat/slack/errors";
import type {
  SubscribedReplyDecision,
  SubscribedReplyPolicy,
} from "@/chat/services/subscribed-reply-policy";
import {
  appendSlackLegacyAttachmentText,
  renderSlackLegacyAttachmentText,
} from "@/chat/slack/legacy-attachments";
import {
  shouldKeepProcessingReactionForToolInvocation,
  startSlackProcessingReaction,
  type ProcessingReactionSession,
} from "@/chat/runtime/processing-reaction";
import { getMessageTs } from "@/chat/runtime/thread-context";
import {
  combineTurnText,
  type PrepareTurnStateInput,
  type QueuedTurnMessage,
  type TurnContext,
  type TurnMessageText,
  type TurnToolInvocation,
} from "@/chat/runtime/turn-input";
import { getMessageActorIdentity } from "@/chat/services/message-actor-identity";

export interface AssistantLifecycleEvent {
  channelId: string;
  context?: {
    channelId?: string;
  };
  threadId: string;
  threadTs: string;
  userId?: string;
}

type SteeringMode = "defer" | "interrupt";

export interface SteeringCandidateMessage {
  activeRequest: boolean;
  inboundMessageId: string;
  message: Message;
}

export interface ReplyHooks {
  beforeFirstResponsePost?: () => Promise<void>;
  drainSteeringMessages?: (
    inject: (
      messages: SteeringCandidateMessage[],
    ) => Promise<readonly string[] | void>,
  ) => Promise<void>;
  messageContext?: MessageContext;
  onInputCommitted?: () => Promise<void>;
  onToolInvocation?: (invocation: TurnToolInvocation) => void;
  onTurnStatePersisted?: () => Promise<void>;
  shouldYield?: () => boolean;
}

interface SteeringDrainContext {
  conversationContext?: string;
}

export interface SlackTurnOptions extends ReplyHooks {
  destination: Destination;
}

const THREAD_OPTOUT_ACK =
  "Understood. I'll stay out of this thread unless someone @mentions me again.";

/** Preserve retry/yield control flow for the durable worker boundary. */
function shouldRethrowTurnControlError(error: unknown): boolean {
  return (
    isCooperativeTurnYieldError(error) ||
    isTurnInputCommitLostError(error) ||
    isProviderRetryError(error)
  );
}

/** Apply a subscribed-thread opt-out decision before any agent work runs. */
async function maybeHandleThreadOptOutDecision(args: {
  beforeFirstResponsePost?: () => Promise<void>;
  decision?: { shouldUnsubscribe?: boolean };
  thread: Thread;
}): Promise<boolean> {
  if (!args.decision?.shouldUnsubscribe) {
    return false;
  }

  await args.thread.unsubscribe();
  await args.beforeFirstResponsePost?.();
  await args.thread.post(THREAD_OPTOUT_ACK);
  return true;
}

type RuntimeLogContext = Record<string, unknown> & {
  assistantUserName: string;
  conversationId?: string;
  modelId: string;
  slackChannelId?: string;
  slackThreadId?: string;
  slackUserId?: string;
  slackUserName?: string;
  runId?: string;
};

export interface SlackTurnRuntimeDependencies<TPreparedState> {
  assistantUserName: string;
  getChannelId: (thread: Thread, message: Message) => string | undefined;
  getPreparedConversationContext: (
    preparedState: TPreparedState,
  ) => string | undefined;
  getThreadId: (thread: Thread, message: Message) => string | undefined;
  getRunId: (thread: Thread, message: Message) => string | undefined;
  initializeAssistantThread: (event: {
    channelId: string;
    sourceChannelId?: string;
    threadId: string;
    threadTs: string;
  }) => Promise<void>;
  refreshAssistantThreadContext: (event: {
    channelId: string;
    sourceChannelId?: string;
    threadId: string;
    threadTs: string;
  }) => Promise<void>;
  logException: (
    error: unknown,
    eventName: string,
    context?: Record<string, unknown>,
    attributes?: Record<string, unknown>,
    body?: string,
  ) => string | undefined;
  logWarn: (
    eventName: string,
    context?: Record<string, unknown>,
    attributes?: Record<string, unknown>,
    body?: string,
  ) => void;
  modelId: string;
  now: () => number;
  recordSkippedSteeringMessage: (args: {
    decision: SubscribedReplyDecision;
    message: Message;
    text: TurnMessageText;
    thread: Thread;
  }) => Promise<void>;
  recordSkippedSubscribedTurn: (args: {
    completedAtMs: number;
    decision: SubscribedReplyDecision;
    message: Message;
    text: TurnMessageText;
    thread: Thread;
  }) => Promise<void>;
  onSubscribedMessageSkipped: (args: {
    completedAtMs: number;
    decision: SubscribedReplyDecision;
    message: Message;
    preparedState: TPreparedState;
    thread: Thread;
  }) => Promise<void>;
  persistPreparedState: (args: {
    preparedState: TPreparedState;
    thread: Thread;
  }) => Promise<void>;
  prepareTurnState: (args: PrepareTurnStateInput) => Promise<TPreparedState>;
  replyToThread: (
    thread: Thread,
    message: Message,
    options: {
      beforeFirstResponsePost?: () => Promise<void>;
      destination: Destination;
      explicitMention?: boolean;
      onInputCommitted?: () => Promise<void>;
      onToolInvocation?: (invocation: TurnToolInvocation) => void;
      onTurnCompleted?: () => Promise<void>;
      onTurnStatePersisted?: () => Promise<void>;
      preparedState?: TPreparedState;
      queuedMessages?: QueuedTurnMessage[];
      drainSteeringMessages?: (
        inject: (messages: QueuedTurnMessage[]) => Promise<void>,
        context?: SteeringDrainContext,
      ) => Promise<QueuedTurnMessage[]>;
      shouldYield?: () => boolean;
    },
  ) => Promise<void>;
  decideSubscribedReply: SubscribedReplyPolicy;
  stripLeadingBotMention: (
    text: string,
    options: {
      botUserId?: string;
      stripLeadingSlackMentionToken?: boolean;
    },
  ) => string;
  withSpan: (
    name: string,
    op: string,
    context: Record<string, unknown>,
    callback: () => Promise<void>,
  ) => Promise<void>;
}

/**
 * Convert skipped Slack messages into the same raw/user text pair as the active
 * message so mention detection and prompt text see consistent inputs.
 */
function getQueuedMessages(
  context: MessageContext | undefined,
  options: {
    explicitMention: boolean;
    stripLeadingBotMention: SlackTurnRuntimeDependencies<unknown>["stripLeadingBotMention"];
  },
): QueuedTurnMessage[] {
  return (context?.skipped ?? []).map((message) => {
    const stripped = options.stripLeadingBotMention(message.text, {
      stripLeadingSlackMentionToken:
        options.explicitMention || Boolean(message.isMention),
    });
    return {
      explicitMention: options.explicitMention || Boolean(message.isMention),
      message,
      rawText: appendSlackLegacyAttachmentText(message.text, message.raw),
      userText: appendSlackLegacyAttachmentText(stripped, message.raw),
    };
  });
}

function getQueuedMessagesFromSlackMessages(
  messages: Message[],
  options: {
    explicitMention: boolean;
    stripLeadingBotMention: SlackTurnRuntimeDependencies<unknown>["stripLeadingBotMention"];
  },
): QueuedTurnMessage[] {
  return getQueuedMessages(
    { skipped: messages, totalSinceLastHandler: messages.length },
    options,
  );
}

interface SteeringMessageDecision {
  context: TurnContext;
  decision: SubscribedReplyDecision;
  inboundMessageId: string;
  mode: SteeringMode;
  message: Message;
  text: TurnMessageText;
}

interface SteeringMessageSelection {
  accepted: Array<{
    inboundMessageId: string;
    message: Message;
    mode: SteeringMode;
  }>;
  skipped: SteeringMessageDecision[];
}

/** Drain mailbox steering messages after classifying interrupt, defer, and skip. */
function createAcceptedSteeringDrain(
  hooks: ReplyHooks,
  options: {
    explicitMention: boolean;
    onAcceptedForProcessing?: (messages: Message[]) => Promise<void>;
    onSkipped?: (messages: SteeringMessageDecision[]) => Promise<void>;
    selectMessages: (
      messages: SteeringCandidateMessage[],
      context?: SteeringDrainContext,
    ) => Promise<SteeringMessageSelection>;
    stripLeadingBotMention: SlackTurnRuntimeDependencies<unknown>["stripLeadingBotMention"];
  },
):
  | ((
      inject: (messages: QueuedTurnMessage[]) => Promise<void>,
      context?: SteeringDrainContext,
    ) => Promise<QueuedTurnMessage[]>)
  | undefined {
  if (!hooks.drainSteeringMessages) {
    return undefined;
  }

  return async (inject, context) => {
    let interruptedMessages: Message[] | undefined;
    await hooks.drainSteeringMessages!(async (messages) => {
      const selection = await options.selectMessages(messages, context);
      await options.onSkipped?.(selection.skipped);
      // Deferred accepted messages stay pending so a later worker slice handles
      // them after the active answer is delivered.
      const interrupted = selection.accepted
        .filter((accepted) => accepted.mode === "interrupt")
        .map((accepted) => accepted.message);
      await inject(getQueuedMessagesFromSlackMessages(interrupted, options));
      interruptedMessages = interrupted;
      await options.onAcceptedForProcessing?.(interrupted);
      return [
        ...selection.accepted
          .filter((accepted) => accepted.mode === "interrupt")
          .map((accepted) => accepted.inboundMessageId),
        ...selection.skipped.map((skipped) => skipped.inboundMessageId),
      ];
    });
    return getQueuedMessagesFromSlackMessages(
      interruptedMessages ?? [],
      options,
    );
  };
}

export interface SlackTurnRuntime<
  _TPreparedState,
  TAssistantEvent extends AssistantLifecycleEvent = AssistantLifecycleEvent,
> {
  handleAssistantContextChanged: (event: TAssistantEvent) => Promise<void>;
  handleAssistantThreadStarted: (event: TAssistantEvent) => Promise<void>;
  handleNewMention: (
    thread: Thread,
    message: Message,
    hooks: SlackTurnOptions,
  ) => Promise<void>;
  handleSubscribedMessage: (
    thread: Thread,
    message: Message,
    hooks: SlackTurnOptions,
  ) => Promise<void>;
}

function buildLogContext(
  deps: Pick<
    SlackTurnRuntimeDependencies<unknown>,
    "assistantUserName" | "modelId"
  >,
  args: {
    channelId?: string;
    requesterId?: string;
    requesterUserName?: string;
    threadId?: string;
    runId?: string;
  },
): RuntimeLogContext {
  return {
    conversationId: args.threadId ?? args.runId,
    slackThreadId: args.threadId,
    slackUserId: args.requesterId,
    slackUserName: args.requesterUserName,
    slackChannelId: args.channelId,
    runId: args.runId,
    assistantUserName: deps.assistantUserName,
    modelId: deps.modelId,
  };
}

function requesterUserName(message: Message): string | undefined {
  return getMessageActorIdentity(message)?.userName;
}

function isResourceEventNotificationMessage(message: Message): boolean {
  const raw =
    message.raw && typeof message.raw === "object"
      ? (message.raw as Record<string, unknown>)
      : undefined;
  return raw?.event_type === "resource_event";
}

/** Build the Slack event runtime that routes mentions and subscribed messages. */
export function createSlackTurnRuntime<
  TPreparedState,
  TAssistantEvent extends AssistantLifecycleEvent = AssistantLifecycleEvent,
>(
  deps: SlackTurnRuntimeDependencies<TPreparedState>,
): SlackTurnRuntime<TPreparedState, TAssistantEvent> {
  const logContext = (args: {
    channelId?: string;
    requesterId?: string;
    requesterUserName?: string;
    threadId?: string;
    runId?: string;
  }): RuntimeLogContext => buildLogContext(deps, args);

  const createToolInvocationHook = (
    processingReaction: ProcessingReactionSession,
    hooks: ReplyHooks,
  ) => {
    return (invocation: TurnToolInvocation): void => {
      if (shouldKeepProcessingReactionForToolInvocation(invocation)) {
        processingReaction.keep();
      }
      hooks.onToolInvocation?.(invocation);
    };
  };

  const stopProcessingReactions = async (
    processingReactions: ProcessingReactionSession[],
  ): Promise<void> => {
    await Promise.all(processingReactions.map((reaction) => reaction.stop()));
  };

  const completeProcessingReactions = async (
    processingReactions: ProcessingReactionSession[],
  ): Promise<void> => {
    await Promise.all(
      processingReactions.map((reaction) => reaction.complete()),
    );
  };

  const createProcessingReactionTracker = (thread: Thread) => {
    const processingReactions: ProcessingReactionSession[] = [];
    const processingReactionByMessage = new Map<
      string,
      ProcessingReactionSession
    >();

    return {
      start: async (
        context: RuntimeLogContext,
        targetMessage: Message,
      ): Promise<ProcessingReactionSession> => {
        const channelId = deps.getChannelId(thread, targetMessage);
        const messageTs = getMessageTs(targetMessage);
        const reactionKey =
          channelId && messageTs ? `${channelId}:${messageTs}` : undefined;
        if (reactionKey) {
          const existing = processingReactionByMessage.get(reactionKey);
          if (existing) {
            return existing;
          }
        }

        const started = await startSlackProcessingReaction({
          thread,
          message: targetMessage,
          logException: deps.logException,
          logContext: context,
        });
        processingReactions.push(started);
        if (reactionKey) {
          processingReactionByMessage.set(reactionKey, started);
        }
        return started;
      },
      completeAll: () => completeProcessingReactions(processingReactions),
      stopAll: () => stopProcessingReactions(processingReactions),
    };
  };

  const postFallbackErrorReplyWithLogging = async (args: {
    thread: Thread;
    errorContext: RuntimeLogContext;
    eventId: string;
    postFailureEventName: string;
    postFailureBody: string;
  }): Promise<void> => {
    try {
      await args.thread.post(buildTurnFailureResponse(args.eventId));
    } catch (postError) {
      deps.logException(
        postError,
        args.postFailureEventName,
        args.errorContext,
        {
          "app.slack.reply_stage": "error_fallback_post",
          "app.error.original_event_id": args.eventId,
          ...getSlackErrorObservabilityAttributes(postError),
        },
        args.postFailureBody,
      );
      throw postError;
    }
  };

  const decideSteeringMessage = async (
    thread: Thread,
    candidate: SteeringCandidateMessage,
    conversationContext: string | undefined,
  ): Promise<{
    context: TurnContext;
    decision: SubscribedReplyDecision;
    mode: SteeringMode;
    text: TurnMessageText;
  }> => {
    const { message } = candidate;
    const context: TurnContext = {
      threadId: deps.getThreadId(thread, message),
      requesterId: message.author.userId,
      channelId: deps.getChannelId(thread, message),
      runId: deps.getRunId(thread, message),
    };
    const legacyAttachmentText = renderSlackLegacyAttachmentText(message.raw);
    const strippedUserText = deps.stripLeadingBotMention(message.text, {
      stripLeadingSlackMentionToken: Boolean(message.isMention),
    });
    const text: TurnMessageText = {
      rawText: appendSlackLegacyAttachmentText(message.text, message.raw),
      userText: appendSlackLegacyAttachmentText(strippedUserText, message.raw),
    };
    const isActiveRequest =
      candidate.activeRequest || Boolean(message.isMention);

    const decision = await deps.decideSubscribedReply({
      rawText: text.rawText,
      text: text.userText,
      conversationContext,
      hasAttachments:
        message.attachments.length > 0 || legacyAttachmentText !== "",
      isExplicitMention: isActiveRequest,
      context,
    });
    return {
      context,
      decision,
      mode: isActiveRequest ? "interrupt" : "defer",
      text,
    };
  };

  const logSkippedSubscribedDecision = (args: {
    context: TurnContext;
    decision: SubscribedReplyDecision;
    message: Message;
  }): void => {
    deps.logWarn(
      "subscribed_message_reply_skipped",
      logContext({
        threadId: args.context.threadId,
        requesterId: args.context.requesterId,
        requesterUserName: requesterUserName(args.message),
        channelId: args.context.channelId,
        runId: args.context.runId,
      }),
      {
        "app.decision.reason": args.decision.reason,
      },
      "Skipping subscribed message reply",
    );
  };

  /** Persist the skip decision at the same boundary that a reply would update. */
  const skipSubscribedMessage = async (args: {
    thread: Thread;
    message: Message;
    decision: SubscribedReplyDecision;
    context: TurnContext;
    onInputCommitted?: () => Promise<void>;
    preparedState?: TPreparedState;
    text: TurnMessageText;
  }): Promise<void> => {
    const completedAtMs = deps.now();
    logSkippedSubscribedDecision(args);
    if (args.preparedState) {
      await deps.onSubscribedMessageSkipped({
        thread: args.thread,
        message: args.message,
        decision: args.decision,
        preparedState: args.preparedState,
        completedAtMs,
      });
    } else {
      await deps.recordSkippedSubscribedTurn({
        thread: args.thread,
        message: args.message,
        decision: args.decision,
        text: args.text,
        completedAtMs,
      });
    }
    // Mark the inbound mailbox messages as consumed even though we are not
    // replying. Without this, completeConversationWork sees pendingMessages > 0
    // and re-enqueues indefinitely — an infinite loop for every skipped message.
    await args.onInputCommitted?.();
  };

  const selectAcceptedSteeringMessages = async (args: {
    conversationContext: string | undefined;
    messages: SteeringCandidateMessage[];
    thread: Thread;
  }): Promise<SteeringMessageSelection> => {
    const selected: SteeringMessageDecision[] = [];
    for (const candidate of args.messages) {
      const decision = await decideSteeringMessage(
        args.thread,
        candidate,
        args.conversationContext,
      );
      selected.push({
        context: decision.context,
        decision: decision.decision,
        inboundMessageId: candidate.inboundMessageId,
        mode: decision.mode,
        message: candidate.message,
        text: decision.text,
      });
    }
    if (selected.some((message) => message.decision.shouldUnsubscribe)) {
      return {
        accepted: [],
        skipped: selected.map((message) =>
          message.decision.shouldReply
            ? {
                ...message,
                decision: {
                  shouldReply: false,
                  reason: "thread_opt_out:batch opt-out",
                },
              }
            : message,
        ),
      };
    }
    return {
      accepted: selected
        .filter((message) => message.decision.shouldReply)
        .map((message) => ({
          inboundMessageId: message.inboundMessageId,
          message: message.message,
          mode: message.mode,
        })),
      skipped: selected.filter((message) => !message.decision.shouldReply),
    };
  };

  /** Persist skipped steering before mailbox commit, without reactions or injection. */
  const handleSkippedSteeringMessages = async (args: {
    beforeFirstResponsePost?: () => Promise<void>;
    pending: SteeringMessageDecision[];
    skipped: SteeringMessageDecision[];
    thread: Thread;
  }): Promise<void> => {
    for (const skipped of args.skipped) {
      await maybeHandleThreadOptOutDecision({
        thread: args.thread,
        decision: skipped.decision,
        beforeFirstResponsePost: args.beforeFirstResponsePost,
      });
      logSkippedSubscribedDecision(skipped);
      await deps.recordSkippedSteeringMessage({
        thread: args.thread,
        message: skipped.message,
        decision: skipped.decision,
        text: skipped.text,
      });
      args.pending.push(skipped);
    }
  };

  /** Reapply skipped steering after final turn persistence so replayed state keeps skipped context. */
  const flushSkippedSteeringMessagesBestEffort = async (args: {
    context: RuntimeLogContext;
    pending: SteeringMessageDecision[];
    thread: Thread;
  }): Promise<void> => {
    try {
      while (args.pending.length > 0) {
        const skipped = args.pending.shift()!;
        await deps.recordSkippedSteeringMessage({
          thread: args.thread,
          message: skipped.message,
          decision: skipped.decision,
          text: skipped.text,
        });
      }
    } catch (error) {
      deps.logException(
        error,
        "skipped_steering_flush_failed",
        args.context,
        {},
        "Failed to reapply skipped steering message records",
      );
    }
  };

  return {
    async handleNewMention(
      thread: Thread,
      message: Message,
      hooks: SlackTurnOptions,
    ): Promise<void> {
      const processingReactions = createProcessingReactionTracker(thread);
      let processingReaction: ProcessingReactionSession | undefined;
      const skippedSteeringMessages: SteeringMessageDecision[] = [];
      let completed = false;
      const onTurnCompleted = async (): Promise<void> => {
        completed = true;
        await flushSkippedSteeringMessagesBestEffort({
          thread,
          pending: skippedSteeringMessages,
          context: logContext({
            threadId: deps.getThreadId(thread, message),
            requesterId: message.author.userId,
            requesterUserName: requesterUserName(message),
            channelId: deps.getChannelId(thread, message),
            runId: deps.getRunId(thread, message),
          }),
        });
      };
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(thread, message);
        const runId = deps.getRunId(thread, message);
        const context = logContext({
          threadId,
          channelId,
          requesterId: message.author.userId,
          requesterUserName: requesterUserName(message),
          runId,
        });
        processingReaction = await processingReactions.start(context, message);
        const toolInvocationHook = createToolInvocationHook(
          processingReaction,
          hooks,
        );

        await deps.withSpan("chat.turn", "chat.turn", context, async () => {
          await thread.subscribe();
          const queuedMessages = getQueuedMessages(hooks.messageContext, {
            explicitMention: true,
            stripLeadingBotMention: deps.stripLeadingBotMention,
          });
          let queuedProcessingReactionsStarted = false;
          const startQueuedProcessingReactions = async (): Promise<void> => {
            if (queuedProcessingReactionsStarted) {
              return;
            }
            queuedProcessingReactionsStarted = true;
            await Promise.all(
              queuedMessages.map((queued) =>
                processingReactions.start(context, queued.message),
              ),
            );
          };
          const onInputCommitted = async (): Promise<void> => {
            await hooks.onInputCommitted?.();
            await startQueuedProcessingReactions();
          };
          const drainSteeringMessages = createAcceptedSteeringDrain(hooks, {
            explicitMention: true,
            onAcceptedForProcessing: async (messages) => {
              await Promise.all(
                messages.map((drainedMessage) =>
                  processingReactions.start(context, drainedMessage),
                ),
              );
            },
            onSkipped: (skipped) =>
              handleSkippedSteeringMessages({
                beforeFirstResponsePost: hooks.beforeFirstResponsePost,
                pending: skippedSteeringMessages,
                skipped,
                thread,
              }),
            selectMessages: (messages, drainContext) =>
              selectAcceptedSteeringMessages({
                conversationContext: drainContext?.conversationContext,
                messages,
                thread,
              }),
            stripLeadingBotMention: deps.stripLeadingBotMention,
          });
          await deps.replyToThread(thread, message, {
            explicitMention: true,
            beforeFirstResponsePost: hooks.beforeFirstResponsePost,
            destination: hooks.destination,
            queuedMessages,
            onInputCommitted,
            onToolInvocation: toolInvocationHook,
            onTurnCompleted,
            drainSteeringMessages,
            onTurnStatePersisted: hooks.onTurnStatePersisted,
            shouldYield: hooks.shouldYield,
          });
        });
      } catch (error) {
        if (shouldRethrowTurnControlError(error)) {
          throw error;
        }
        const errorContext = logContext({
          threadId: deps.getThreadId(thread, message),
          requesterId: message.author.userId,
          requesterUserName: requesterUserName(message),
          channelId: deps.getChannelId(thread, message),
          runId: deps.getRunId(thread, message),
        });
        if (
          isRetryableTurnError(error, "mcp_auth_resume") ||
          isRetryableTurnError(error, "plugin_auth_resume")
        ) {
          deps.logException(
            error,
            "mention_handler_auth_pause",
            errorContext,
            { "app.ai.retryable_reason": error.reason },
            "onNewMention parked turn for auth resume",
          );
          return;
        }
        const eventId = deps.logException(
          error,
          "mention_handler_failed",
          errorContext,
          {},
          "onNewMention failed",
        );
        if (!eventId) {
          throw new Error(
            "Sentry did not return an event ID for mention_handler_failed",
          );
        }
        await hooks.beforeFirstResponsePost?.();
        await postFallbackErrorReplyWithLogging({
          thread,
          errorContext,
          eventId,
          postFailureEventName: "mention_handler_failure_reply_post_failed",
          postFailureBody:
            "Failed to post fallback error reply for mention handler",
        });
      } finally {
        if (completed) {
          await processingReactions.completeAll();
        } else {
          await flushSkippedSteeringMessagesBestEffort({
            thread,
            pending: skippedSteeringMessages,
            context: logContext({
              threadId: deps.getThreadId(thread, message),
              requesterId: message.author.userId,
              requesterUserName: requesterUserName(message),
              channelId: deps.getChannelId(thread, message),
              runId: deps.getRunId(thread, message),
            }),
          });
          await processingReactions.stopAll();
        }
      }
    },

    async handleSubscribedMessage(
      thread: Thread,
      message: Message,
      hooks: SlackTurnOptions,
    ): Promise<void> {
      const processingReactions = createProcessingReactionTracker(thread);
      let processingReaction: ProcessingReactionSession | undefined;
      const skippedSteeringMessages: SteeringMessageDecision[] = [];
      let completed = false;
      const onTurnCompleted = async (): Promise<void> => {
        completed = true;
        await flushSkippedSteeringMessagesBestEffort({
          thread,
          pending: skippedSteeringMessages,
          context: logContext({
            threadId: deps.getThreadId(thread, message),
            requesterId: message.author.userId,
            requesterUserName: requesterUserName(message),
            channelId: deps.getChannelId(thread, message),
            runId: deps.getRunId(thread, message),
          }),
        });
      };
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(thread, message);
        const runId = deps.getRunId(thread, message);
        const isResourceEventNotification =
          isResourceEventNotificationMessage(message);
        const requesterId = isResourceEventNotification
          ? undefined
          : message.author.userId;
        const turnContext = logContext({
          threadId,
          requesterId,
          requesterUserName: requesterUserName(message),
          channelId,
          runId,
        });
        await deps.withSpan("chat.turn", "chat.turn", turnContext, async () => {
          // This path can compact context and run router/vision model calls
          // before replyToThread() opens the main reply span.
          const legacyAttachmentText = renderSlackLegacyAttachmentText(
            message.raw,
          );
          const strippedUserText = deps.stripLeadingBotMention(message.text, {
            stripLeadingSlackMentionToken: Boolean(message.isMention),
          });
          const currentText: TurnMessageText = {
            rawText: appendSlackLegacyAttachmentText(message.text, message.raw),
            userText: appendSlackLegacyAttachmentText(
              strippedUserText,
              message.raw,
            ),
          };
          const threadContext: TurnContext = {
            threadId,
            requesterId,
            channelId,
            runId,
          };
          const queuedMessages = getQueuedMessages(hooks.messageContext, {
            explicitMention: Boolean(message.isMention),
            stripLeadingBotMention: deps.stripLeadingBotMention,
          });
          const combinedText = combineTurnText(queuedMessages, currentText);
          const turnIsExplicitMention =
            Boolean(message.isMention) ||
            queuedMessages.some((queued) => queued.explicitMention);
          const preflightDecision = isResourceEventNotification
            ? undefined
            : getSubscribedReplyPreflightDecision({
                botUserName: deps.assistantUserName,
                rawText: combinedText.rawText,
                text: combinedText.userText,
                isExplicitMention: turnIsExplicitMention,
              });

          if (preflightDecision && !preflightDecision.shouldReply) {
            const reason = preflightDecision.reasonDetail
              ? `${preflightDecision.reason}:${preflightDecision.reasonDetail}`
              : preflightDecision.reason;
            await skipSubscribedMessage({
              thread,
              message,
              decision: { shouldReply: false, reason },
              context: threadContext,
              onInputCommitted: hooks.onInputCommitted,
              text: combinedText,
            });
            return;
          }

          const preparedState = await deps.prepareTurnState({
            thread,
            message,
            text: currentText,
            explicitMention: Boolean(message.isMention),
            context: threadContext,
            queuedMessages,
          });

          await deps.persistPreparedState({
            thread,
            preparedState,
          });

          const decision: SubscribedReplyDecision = isResourceEventNotification
            ? { shouldReply: true, reason: "resource_event" }
            : await deps.decideSubscribedReply({
                rawText: combinedText.rawText,
                text: combinedText.userText,
                conversationContext:
                  deps.getPreparedConversationContext(preparedState),
                hasAttachments:
                  message.attachments.length > 0 ||
                  queuedMessages.some(
                    (queued) => queued.message.attachments.length > 0,
                  ) ||
                  legacyAttachmentText !== "",
                isExplicitMention: turnIsExplicitMention,
                context: threadContext,
              });

          if (
            await maybeHandleThreadOptOutDecision({
              thread,
              decision,
              beforeFirstResponsePost: hooks.beforeFirstResponsePost,
            })
          ) {
            await skipSubscribedMessage({
              thread,
              message,
              decision,
              context: threadContext,
              onInputCommitted: hooks.onInputCommitted,
              preparedState,
              text: combinedText,
            });
            return;
          }

          if (!decision.shouldReply) {
            await skipSubscribedMessage({
              thread,
              message,
              decision,
              context: threadContext,
              onInputCommitted: hooks.onInputCommitted,
              preparedState,
              text: combinedText,
            });
            return;
          }

          const conversationContext =
            deps.getPreparedConversationContext(preparedState);
          const drainSteeringMessages = createAcceptedSteeringDrain(hooks, {
            explicitMention: Boolean(message.isMention),
            onAcceptedForProcessing: async (messages) => {
              await Promise.all(
                messages.map((drainedMessage) =>
                  processingReactions.start(turnContext, drainedMessage),
                ),
              );
            },
            onSkipped: (skipped) =>
              handleSkippedSteeringMessages({
                beforeFirstResponsePost: hooks.beforeFirstResponsePost,
                pending: skippedSteeringMessages,
                skipped,
                thread,
              }),
            selectMessages: (messages, drainContext) =>
              selectAcceptedSteeringMessages({
                conversationContext:
                  drainContext?.conversationContext ?? conversationContext,
                messages,
                thread,
              }),
            stripLeadingBotMention: deps.stripLeadingBotMention,
          });
          processingReaction = await processingReactions.start(
            turnContext,
            message,
          );
          let queuedProcessingReactionsStarted = false;
          const startQueuedProcessingReactions = async (): Promise<void> => {
            if (queuedProcessingReactionsStarted) {
              return;
            }
            queuedProcessingReactionsStarted = true;
            await Promise.all(
              queuedMessages.map((queued) =>
                processingReactions.start(turnContext, queued.message),
              ),
            );
          };
          const onInputCommitted = async (): Promise<void> => {
            await hooks.onInputCommitted?.();
            await startQueuedProcessingReactions();
          };
          const toolInvocationHook = createToolInvocationHook(
            processingReaction,
            hooks,
          );

          await deps.replyToThread(thread, message, {
            explicitMention: Boolean(message.isMention),
            destination: hooks.destination,
            preparedState,
            beforeFirstResponsePost: hooks.beforeFirstResponsePost,
            queuedMessages,
            onInputCommitted,
            onToolInvocation: toolInvocationHook,
            onTurnCompleted,
            drainSteeringMessages,
            onTurnStatePersisted: hooks.onTurnStatePersisted,
            shouldYield: hooks.shouldYield,
          });
        });
      } catch (error) {
        if (shouldRethrowTurnControlError(error)) {
          throw error;
        }
        const errorContext = logContext({
          threadId: deps.getThreadId(thread, message),
          requesterId: message.author.userId,
          requesterUserName: requesterUserName(message),
          channelId: deps.getChannelId(thread, message),
          runId: deps.getRunId(thread, message),
        });
        if (
          isRetryableTurnError(error, "mcp_auth_resume") ||
          isRetryableTurnError(error, "plugin_auth_resume")
        ) {
          deps.logException(
            error,
            "subscribed_message_handler_auth_pause",
            errorContext,
            { "app.ai.retryable_reason": error.reason },
            "onSubscribedMessage parked turn for auth resume",
          );
          return;
        }
        const eventId = deps.logException(
          error,
          "subscribed_message_handler_failed",
          errorContext,
          {},
          "onSubscribedMessage failed",
        );
        if (!eventId) {
          throw new Error(
            "Sentry did not return an event ID for subscribed_message_handler_failed",
          );
        }
        await hooks.beforeFirstResponsePost?.();
        await postFallbackErrorReplyWithLogging({
          thread,
          errorContext,
          eventId,
          postFailureEventName:
            "subscribed_message_handler_failure_reply_post_failed",
          postFailureBody:
            "Failed to post fallback error reply for subscribed message handler",
        });
      } finally {
        if (completed) {
          await processingReactions.completeAll();
        } else {
          await flushSkippedSteeringMessagesBestEffort({
            thread,
            pending: skippedSteeringMessages,
            context: logContext({
              threadId: deps.getThreadId(thread, message),
              requesterId: message.author.userId,
              requesterUserName: requesterUserName(message),
              channelId: deps.getChannelId(thread, message),
              runId: deps.getRunId(thread, message),
            }),
          });
          await processingReactions.stopAll();
        }
      }
    },

    async handleAssistantThreadStarted(event: TAssistantEvent): Promise<void> {
      try {
        await deps.initializeAssistantThread({
          threadId: event.threadId,
          channelId: event.channelId,
          threadTs: event.threadTs,
          sourceChannelId: event.context?.channelId,
        });
      } catch (error) {
        deps.logException(
          error,
          "assistant_thread_started_handler_failed",
          {
            slackThreadId: event.threadId,
            slackUserId: event.userId,
            slackChannelId: event.channelId,
            assistantUserName: deps.assistantUserName,
            modelId: deps.modelId,
          },
          {},
          "onAssistantThreadStarted failed",
        );
      }
    },

    async handleAssistantContextChanged(event: TAssistantEvent): Promise<void> {
      try {
        await deps.refreshAssistantThreadContext({
          threadId: event.threadId,
          channelId: event.channelId,
          threadTs: event.threadTs,
          sourceChannelId: event.context?.channelId,
        });
      } catch (error) {
        deps.logException(
          error,
          "assistant_context_changed_handler_failed",
          {
            slackThreadId: event.threadId,
            slackUserId: event.userId,
            slackChannelId: event.channelId,
            assistantUserName: deps.assistantUserName,
            modelId: deps.modelId,
          },
          {},
          "onAssistantContextChanged failed",
        );
      }
    },
  };
}
