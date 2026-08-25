/**
 * Slack provider runtime.
 *
 * This module owns inbound Slack routing decisions for mentions, subscribed
 * messages, assistant lifecycle events, and retryable turn pauses. It should
 * normalize text/queued context and decide reply vs silence while keeping
 * Pi/MCP internals and durable session storage behind injected services.
 */
import type { Message, MessageContext, Thread } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import { getSubscribedReplyPreflightDecision } from "@/chat/services/subscribed-decision";
import { isProviderRetryError } from "@/chat/services/provider-error";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { SlackActionError } from "@/chat/slack/client";
import {
  buildDeterministicTurnId,
  getConversationTurnBoundaryError,
  isCooperativeTurnYieldError,
  isTurnInputDeferredError,
  isTurnInputCommitLostError,
} from "@/chat/runtime/turn";
import {
  buildTurnFailureResponse,
  logException,
  logWarn,
  withSpan,
  withLogContext,
} from "@/chat/logging";
import { getSlackErrorObservabilityAttributes } from "@/chat/slack/errors";
import type {
  SubscribedReplyDecision,
  SubscribedReplyPolicy,
} from "@/chat/services/subscribed-reply-policy";
import {
  parseContent,
  replaceTopLevelText,
} from "@/chat/slack/message/content";
import {
  shouldKeepProcessingReactionForToolInvocation,
  startProcessingReaction,
  type ProcessingReaction,
} from "@/chat/providers/slack/processing-reaction";
import {
  getChannelId,
  getMessageTs,
  getRunId,
  getThreadId,
  stripLeadingBotMention,
} from "@/chat/runtime/thread-context";
import { stripLeadingSteeringOverride } from "@/chat/slack/message-control";
import {
  combineTurnText,
  type PrepareTurnStateInput,
  type QueuedTurnMessage,
  type TurnContext,
  type TurnMessageText,
  type TurnToolInvocation,
} from "@/chat/runtime/turn-input";
import { getMessageActorIdentity } from "@/chat/services/message-actor-identity";
import { isResourceEventSlackMessage } from "@/chat/resource-events/actor";
import type { FailConversationTurnInput } from "@/chat/conversations/turn-lifecycle";

export interface AssistantLifecycleEvent {
  channelId: string;
  context?: {
    channelId?: string;
  };
  threadId: string;
  threadTs: string;
  userId?: string;
}

export interface SteeringCandidateMessage {
  inboundMessageId: string;
  message: Message;
}

export interface ReplyHooks {
  beforeFirstResponsePost?: () => Promise<void>;
  drainSteeringMessages?: (
    accept: (
      messages: SteeringCandidateMessage[],
    ) => Promise<readonly string[]>,
  ) => Promise<void>;
  messageContext?: MessageContext;
  ack?: () => Promise<void>;
  onToolInvocation?: (invocation: TurnToolInvocation) => void;
  onTurnStatePersisted?: () => Promise<void>;
  isFinalAttempt?: boolean;
  shouldYield?: () => boolean;
}

interface SteeringDrainContext {
  conversationContext?: string;
}

export interface SlackTurnOptions extends ReplyHooks {
  conversationId?: string;
  destination: Destination;
  publishExternally?: boolean;
}

const THREAD_OPTOUT_ACK =
  "Understood. I'll stay out of this thread unless someone @mentions me again.";

/** Preserve retry/yield control flow for the durable worker boundary. */
function shouldRethrowTurnControlError(error: unknown): boolean {
  return (
    isCooperativeTurnYieldError(error) ||
    isTurnInputCommitLostError(error) ||
    isTurnInputDeferredError(error) ||
    isProviderRetryError(error)
  );
}

type RuntimeLogContext = Record<string, unknown> & {
  assistantUserName: string;
  conversationId?: string;
  destinationName?: string;
  messageConversationId?: string;
  modelId: string;
  runId?: string;
  userId?: string;
  userName?: string;
};

export interface SlackTurnRuntimeDependencies<TPreparedState> {
  assistantUserName: string;
  botUserId?: string;
  cancelEventSubscriptions: (input: {
    conversationId: string;
  }) => Promise<void>;
  getPreparedConversationContext: (
    preparedState: TPreparedState,
  ) => string | undefined;
  initializeAssistantThread: (event: {
    channelId: string;
    sourceChannelId?: string;
    threadId: string;
    threadTs: string;
  }) => Promise<void>;
  failConversationTurn: (input: FailConversationTurnInput) => Promise<void>;
  refreshAssistantThreadContext: (event: {
    channelId: string;
    sourceChannelId?: string;
    threadId: string;
    threadTs: string;
  }) => Promise<void>;
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
  executeSlackTurn: (
    thread: Thread,
    message: Message,
    options: {
      beforeFirstResponsePost?: () => Promise<void>;
      conversationId?: string;
      destination: Destination;
      explicitMention?: boolean;
      ack?: () => Promise<void>;
      onToolInvocation?: (invocation: TurnToolInvocation) => void;
      onTurnCompleted?: () => Promise<void>;
      onTurnStatePersisted?: () => Promise<void>;
      preparedState?: TPreparedState;
      queuedMessages?: QueuedTurnMessage[];
      publishExternally?: boolean;
      drainSteeringMessages?: (
        accept: (messages: QueuedTurnMessage[]) => Promise<void>,
        context?: SteeringDrainContext,
      ) => Promise<QueuedTurnMessage[]>;
      shouldYield?: () => boolean;
    },
  ) => Promise<void>;
  decideSubscribedReply: SubscribedReplyPolicy;
}

/**
 * Convert skipped Slack messages into the same raw/user text pair as the active
 * message so mention detection and prompt text see consistent inputs.
 */
function getQueuedMessages(
  context: MessageContext | undefined,
  options: {
    botUserId?: string;
    explicitMention: boolean;
  },
): QueuedTurnMessage[] {
  return (context?.skipped ?? []).map((message) => {
    const content = parseContent(message);
    const stripped = stripLeadingBotMention(
      stripLeadingSteeringOverride(content.topLevelText),
      {
        botUserId: options.botUserId,
        stripLeadingSlackMentionToken:
          options.explicitMention || Boolean(message.isMention),
      },
    );
    return {
      explicitMention: Boolean(message.isMention),
      message,
      rawText: content.text,
      userText: replaceTopLevelText(content, stripped),
    };
  });
}

function getQueuedMessagesFromSlackMessages(
  messages: Message[],
  options: {
    botUserId?: string;
    explicitMention: boolean;
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
  message: Message;
  text: TurnMessageText;
}

interface SteeringMessageSelection {
  accepted: Array<{
    inboundMessageId: string;
    message: Message;
  }>;
  skipped: SteeringMessageDecision[];
}

/** Drain explicit mailbox interruptions after applying subscribed reply policy. */
function createAcceptedSteeringDrain(
  hooks: ReplyHooks,
  options: {
    botUserId?: string;
    explicitMention: boolean;
    onAcceptedForProcessing?: (messages: Message[]) => Promise<void>;
    onSkipped?: (messages: SteeringMessageDecision[]) => Promise<void>;
    selectMessages: (
      messages: SteeringCandidateMessage[],
      context?: SteeringDrainContext,
    ) => Promise<SteeringMessageSelection>;
  },
):
  | ((
      accept: (messages: QueuedTurnMessage[]) => Promise<void>,
      context?: SteeringDrainContext,
    ) => Promise<QueuedTurnMessage[]>)
  | undefined {
  if (!hooks.drainSteeringMessages) {
    return undefined;
  }

  return async (accept, context) => {
    let interruptedMessages: Message[] | undefined;
    await hooks.drainSteeringMessages!(async (messages) => {
      const selection = await options.selectMessages(messages, context);
      await options.onSkipped?.(selection.skipped);
      const interrupted = selection.accepted.map(
        (accepted) => accepted.message,
      );
      await accept(getQueuedMessagesFromSlackMessages(interrupted, options));
      interruptedMessages = interrupted;
      await options.onAcceptedForProcessing?.(interrupted);
      return [
        ...selection.accepted.map((accepted) => accepted.inboundMessageId),
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
    actorId?: string;
    actorUserName?: string;
    threadId?: string;
    runId?: string;
  },
): RuntimeLogContext {
  return {
    conversationId: args.threadId ?? args.runId,
    messageConversationId: args.threadId,
    userId: args.actorId,
    userName: args.actorUserName,
    destinationName: args.channelId,
    runId: args.runId,
    assistantUserName: deps.assistantUserName,
    modelId: deps.modelId,
  };
}

function actorUserName(message: Message): string | undefined {
  return getMessageActorIdentity(message)?.userName;
}

/** Build the Slack event runtime that routes mentions and subscribed messages. */
/** Slack surfaces publish unless a caller opts out. */
function shouldPublishExternally(publishExternally?: boolean): boolean {
  return publishExternally !== false;
}

export function createSlackTurnRuntime<
  TPreparedState,
  TAssistantEvent extends AssistantLifecycleEvent = AssistantLifecycleEvent,
>(
  deps: SlackTurnRuntimeDependencies<TPreparedState>,
): SlackTurnRuntime<TPreparedState, TAssistantEvent> {
  const logContext = (args: {
    channelId?: string;
    actorId?: string;
    actorUserName?: string;
    threadId?: string;
    runId?: string;
  }): RuntimeLogContext => buildLogContext(deps, args);

  /** Apply a subscribed-thread opt-out decision before any agent work runs. */
  const maybeHandleThreadOptOutDecision = async (args: {
    beforeFirstResponsePost?: () => Promise<void>;
    decision?: { shouldUnsubscribe?: boolean };
    thread: Thread;
  }): Promise<boolean> => {
    if (!args.decision?.shouldUnsubscribe) {
      return false;
    }

    await deps.cancelEventSubscriptions({ conversationId: args.thread.id });
    await args.thread.unsubscribe();
    await args.beforeFirstResponsePost?.();
    await args.thread.post(THREAD_OPTOUT_ACK);
    return true;
  };

  const failConversationTurn = async (args: {
    eventId: string;
    failureCode: FailConversationTurnInput["failureCode"];
    message: Message;
    thread: Thread;
  }): Promise<void> => {
    const conversationId =
      getThreadId(args.thread, args.message) ??
      getRunId(args.thread, args.message);
    if (!conversationId) {
      return;
    }
    await deps.failConversationTurn({
      conversationId,
      createdAtMs: deps.now(),
      eventId: args.eventId,
      failureCode: args.failureCode,
      turnId: buildDeterministicTurnId(args.message.id),
    });
  };

  const createToolInvocationHook = (
    processingReaction: ProcessingReaction,
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
    processingReactions: ProcessingReaction[],
  ): Promise<void> => {
    await Promise.all(processingReactions.map((reaction) => reaction.stop()));
  };

  const completeProcessingReactions = async (
    processingReactions: ProcessingReaction[],
  ): Promise<void> => {
    await Promise.all(
      processingReactions.map((reaction) => reaction.complete()),
    );
  };

  const createProcessingReactionTracker = (thread: Thread) => {
    const processingReactions: ProcessingReaction[] = [];
    const processingReactionByMessage = new Map<string, ProcessingReaction>();

    return {
      start: async (
        context: RuntimeLogContext,
        targetMessage: Message,
      ): Promise<ProcessingReaction> => {
        const channelId = getChannelId(thread, targetMessage);
        const messageTs = getMessageTs(targetMessage);
        const reactionKey =
          channelId && messageTs ? `${channelId}:${messageTs}` : undefined;
        if (reactionKey) {
          const existing = processingReactionByMessage.get(reactionKey);
          if (existing) {
            return existing;
          }
        }

        const started = await startProcessingReaction({
          thread,
          message: targetMessage,
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
    eventId: string;
    postFailureEventName: string;
  }): Promise<void> => {
    try {
      await args.thread.post(buildTurnFailureResponse(args.eventId));
    } catch (postError) {
      logException(postError, args.postFailureEventName, {
        "app.slack.reply_stage": "error_fallback_post",
        "app.error.original_event_id": args.eventId,
        ...getSlackErrorObservabilityAttributes(postError),
      });
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
    text: TurnMessageText;
  }> => {
    const { message } = candidate;
    const context: TurnContext = {
      threadId: getThreadId(thread, message),
      actorId: message.author.userId,
      channelId: getChannelId(thread, message),
      runId: getRunId(thread, message),
    };
    const content = parseContent(message);
    const strippedUserText = stripLeadingBotMention(
      stripLeadingSteeringOverride(content.topLevelText),
      {
        botUserId: deps.botUserId,
        stripLeadingSlackMentionToken: Boolean(message.isMention),
      },
    );
    const text: TurnMessageText = {
      rawText: content.text,
      userText: replaceTopLevelText(content, strippedUserText),
    };
    const decision = await deps.decideSubscribedReply({
      rawText: text.rawText,
      text: text.userText,
      conversationContext,
      hasAttachments: content.hasAttachments,
      isExplicitMention: true,
      context,
    });
    return {
      context,
      decision,
      text,
    };
  };

  const logSkippedSubscribedDecision = (args: {
    context: TurnContext;
    decision: SubscribedReplyDecision;
    message: Message;
  }): void => {
    withLogContext(
      logContext({
        threadId: args.context.threadId,
        actorId: args.context.actorId,
        actorUserName: actorUserName(args.message),
        channelId: args.context.channelId,
        runId: args.context.runId,
      }),
      () => {
        logWarn("subscribed_message.reply.skipped", {
          "app.decision.reason": args.decision.reason,
        });
      },
    );
  };

  /** Persist the skip decision at the same boundary that a reply would update. */
  const skipSubscribedMessage = async (args: {
    thread: Thread;
    message: Message;
    decision: SubscribedReplyDecision;
    context: TurnContext;
    ack?: () => Promise<void>;
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
    await args.ack?.();
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
      withLogContext(args.context, () => {
        logException(error, "agent.turn.steering_flush.failed");
      });
    }
  };

  return {
    async handleNewMention(
      thread: Thread,
      message: Message,
      hooks: SlackTurnOptions,
    ): Promise<void> {
      const processingReactions = createProcessingReactionTracker(thread);
      let processingReaction: ProcessingReaction | undefined;
      const skippedSteeringMessages: SteeringMessageDecision[] = [];
      let completed = false;
      let acked = false;
      const onTurnCompleted = async (): Promise<void> => {
        completed = true;
        await flushSkippedSteeringMessagesBestEffort({
          thread,
          pending: skippedSteeringMessages,
          context: logContext({
            threadId: getThreadId(thread, message),
            actorId: message.author.userId,
            actorUserName: actorUserName(message),
            channelId: getChannelId(thread, message),
            runId: getRunId(thread, message),
          }),
        });
      };
      try {
        const threadId = getThreadId(thread, message);
        const channelId = getChannelId(thread, message);
        const runId = getRunId(thread, message);
        const context = logContext({
          threadId,
          channelId,
          actorId: message.author.userId,
          actorUserName: actorUserName(message),
          runId,
        });
        processingReaction = await processingReactions.start(context, message);
        const toolInvocationHook = createToolInvocationHook(
          processingReaction,
          hooks,
        );

        await withSpan("chat.turn", "chat.turn", context, async () => {
          await thread.subscribe();
          const queuedMessages = getQueuedMessages(hooks.messageContext, {
            botUserId: deps.botUserId,
            explicitMention: true,
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
          const ack = async (): Promise<void> => {
            await hooks.ack?.();
            acked = true;
            await startQueuedProcessingReactions();
          };
          const drainSteeringMessages = createAcceptedSteeringDrain(hooks, {
            botUserId: deps.botUserId,
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
          });
          await deps.executeSlackTurn(thread, message, {
            explicitMention: true,
            beforeFirstResponsePost: hooks.beforeFirstResponsePost,
            conversationId: hooks.conversationId,
            destination: hooks.destination,
            queuedMessages,
            publishExternally: shouldPublishExternally(hooks.publishExternally),
            ack,
            onToolInvocation: toolInvocationHook,
            onTurnCompleted,
            drainSteeringMessages,
            onTurnStatePersisted: hooks.onTurnStatePersisted,
            shouldYield: hooks.shouldYield,
          });
        });
      } catch (error) {
        const failureLogContext = logContext({
          threadId: getThreadId(thread, message),
          actorId: message.author.userId,
          actorUserName: actorUserName(message),
          channelId: getChannelId(thread, message),
          runId: getRunId(thread, message),
        });
        const classifiedFailure = getConversationTurnBoundaryError(error);
        const failureCause = classifiedFailure?.cause ?? error;
        if (shouldRethrowTurnControlError(failureCause)) {
          throw failureCause;
        }
        if (failureCause instanceof AuthorizationFlowDisabledError) {
          return;
        }
        const failureCode =
          classifiedFailure?.failureCode ?? "agent_run_failed";
        if (
          failureCause instanceof SlackActionError &&
          failureCause.code === "read_only_channel"
        ) {
          withLogContext(failureLogContext, () => {
            logWarn("mention.handler.skipped", {
              "app.decision.reason": "read_only_channel",
            });
          });
          return;
        }
        const eventId =
          classifiedFailure?.eventId ??
          withLogContext(failureLogContext, () =>
            logException(failureCause, "mention.handler.failed"),
          );
        if (!acked && hooks.isFinalAttempt === false) {
          // The mailbox redelivers this message; only the final bounded
          // attempt posts the visible failure reply.
          return;
        }
        if (!eventId) {
          throw new Error(
            "Sentry did not return an event ID for mention.handler.failed",
          );
        }
        let lifecycleError: unknown;
        try {
          await failConversationTurn({
            eventId,
            failureCode,
            message,
            thread,
          });
        } catch (error) {
          lifecycleError = error;
        }
        await hooks.beforeFirstResponsePost?.();
        if (shouldPublishExternally(hooks.publishExternally)) {
          await postFallbackErrorReplyWithLogging({
            thread,
            eventId,
            postFailureEventName: "mention.handler.failure_reply_post.failed",
          });
        }
        if (lifecycleError) throw lifecycleError;
      } finally {
        if (completed) {
          await processingReactions.completeAll();
        } else {
          await flushSkippedSteeringMessagesBestEffort({
            thread,
            pending: skippedSteeringMessages,
            context: logContext({
              threadId: getThreadId(thread, message),
              actorId: message.author.userId,
              actorUserName: actorUserName(message),
              channelId: getChannelId(thread, message),
              runId: getRunId(thread, message),
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
      let processingReaction: ProcessingReaction | undefined;
      const skippedSteeringMessages: SteeringMessageDecision[] = [];
      let completed = false;
      let acked = false;
      const onTurnCompleted = async (): Promise<void> => {
        completed = true;
        await flushSkippedSteeringMessagesBestEffort({
          thread,
          pending: skippedSteeringMessages,
          context: logContext({
            threadId: getThreadId(thread, message),
            actorId: message.author.userId,
            actorUserName: actorUserName(message),
            channelId: getChannelId(thread, message),
            runId: getRunId(thread, message),
          }),
        });
      };
      try {
        const threadId = getThreadId(thread, message);
        const channelId = getChannelId(thread, message);
        const runId = getRunId(thread, message);
        const isResourceEventNotification =
          isResourceEventSlackMessage(message);
        const actorId = isResourceEventNotification
          ? undefined
          : message.author.userId;
        const turnContext = logContext({
          threadId,
          actorId,
          actorUserName: actorUserName(message),
          channelId,
          runId,
        });
        await withSpan("chat.turn", "chat.turn", turnContext, async () => {
          // This path can compact context and run router/vision model calls
          // before executeSlackTurn() opens the main reply span.
          const content = parseContent(message);
          const strippedUserText = stripLeadingBotMention(
            stripLeadingSteeringOverride(content.topLevelText),
            {
              botUserId: deps.botUserId,
              stripLeadingSlackMentionToken: Boolean(message.isMention),
            },
          );
          const currentText: TurnMessageText = {
            rawText: content.text,
            userText: replaceTopLevelText(content, strippedUserText),
          };
          const threadContext: TurnContext = {
            threadId,
            actorId,
            channelId,
            runId,
          };
          const queuedMessages = getQueuedMessages(hooks.messageContext, {
            botUserId: deps.botUserId,
            explicitMention: Boolean(message.isMention),
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
              ack: hooks.ack,
              text: combinedText,
            });
            return;
          }

          // When non-mention replies are off, skip prepare and stay quiet unless
          // the decision unsubscribes the thread (!stop).
          if (
            !isResourceEventNotification &&
            !turnIsExplicitMention &&
            !isExperimentalFeatureEnabled("passive-routing")
          ) {
            const decision = await deps.decideSubscribedReply({
              rawText: combinedText.rawText,
              text: combinedText.userText,
              hasAttachments:
                content.hasAttachments ||
                queuedMessages.some(
                  (queued) => queued.message.attachments.length > 0,
                ),
              isExplicitMention: false,
              context: threadContext,
            });
            await maybeHandleThreadOptOutDecision({
              thread,
              decision,
              beforeFirstResponsePost: hooks.beforeFirstResponsePost,
            });
            await skipSubscribedMessage({
              thread,
              message,
              decision,
              context: threadContext,
              ack: hooks.ack,
              text: combinedText,
            });
            return;
          }

          const preparedState = await deps.prepareTurnState({
            thread,
            message,
            text: currentText,
            explicitMention: Boolean(message.isMention),
            destination: hooks.destination,
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
                  content.hasAttachments ||
                  queuedMessages.some(
                    (queued) => queued.message.attachments.length > 0,
                  ),
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
              ack: hooks.ack,
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
              ack: hooks.ack,
              preparedState,
              text: combinedText,
            });
            return;
          }

          const conversationContext =
            deps.getPreparedConversationContext(preparedState);
          const drainSteeringMessages = createAcceptedSteeringDrain(hooks, {
            botUserId: deps.botUserId,
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
          const ack = async (): Promise<void> => {
            await hooks.ack?.();
            acked = true;
            await startQueuedProcessingReactions();
          };
          const toolInvocationHook = createToolInvocationHook(
            processingReaction,
            hooks,
          );

          await deps.executeSlackTurn(thread, message, {
            explicitMention: Boolean(message.isMention),
            conversationId: hooks.conversationId,
            destination: hooks.destination,
            preparedState,
            publishExternally: shouldPublishExternally(hooks.publishExternally),
            beforeFirstResponsePost: hooks.beforeFirstResponsePost,
            queuedMessages,
            ack,
            onToolInvocation: toolInvocationHook,
            onTurnCompleted,
            drainSteeringMessages,
            onTurnStatePersisted: hooks.onTurnStatePersisted,
            shouldYield: hooks.shouldYield,
          });
        });
      } catch (error) {
        const failureLogContext = logContext({
          threadId: getThreadId(thread, message),
          actorId: message.author.userId,
          actorUserName: actorUserName(message),
          channelId: getChannelId(thread, message),
          runId: getRunId(thread, message),
        });
        const classifiedFailure = getConversationTurnBoundaryError(error);
        const failureCause = classifiedFailure?.cause ?? error;
        if (shouldRethrowTurnControlError(failureCause)) {
          throw failureCause;
        }
        if (failureCause instanceof AuthorizationFlowDisabledError) {
          return;
        }
        const failureCode =
          classifiedFailure?.failureCode ?? "agent_run_failed";
        if (
          failureCause instanceof SlackActionError &&
          failureCause.code === "read_only_channel"
        ) {
          withLogContext(failureLogContext, () => {
            logWarn("subscribed_message.handler.skipped", {
              "app.decision.reason": "read_only_channel",
            });
          });
          return;
        }
        const eventId =
          classifiedFailure?.eventId ??
          withLogContext(failureLogContext, () =>
            logException(failureCause, "subscribed_message.handler.failed"),
          );
        if (!acked && hooks.isFinalAttempt === false) {
          // The mailbox redelivers this message; only the final bounded
          // attempt posts the visible failure reply.
          return;
        }
        if (!eventId) {
          throw new Error(
            "Sentry did not return an event ID for subscribed_message.handler.failed",
          );
        }
        let lifecycleError: unknown;
        try {
          await failConversationTurn({
            eventId,
            failureCode,
            message,
            thread,
          });
        } catch (error) {
          lifecycleError = error;
        }
        await hooks.beforeFirstResponsePost?.();
        if (shouldPublishExternally(hooks.publishExternally)) {
          await postFallbackErrorReplyWithLogging({
            thread,
            eventId,
            postFailureEventName:
              "subscribed_message.handler.failure_reply_post.failed",
          });
        }
        if (lifecycleError) throw lifecycleError;
      } finally {
        if (completed) {
          await processingReactions.completeAll();
        } else {
          await flushSkippedSteeringMessagesBestEffort({
            thread,
            pending: skippedSteeringMessages,
            context: logContext({
              threadId: getThreadId(thread, message),
              actorId: message.author.userId,
              actorUserName: actorUserName(message),
              channelId: getChannelId(thread, message),
              runId: getRunId(thread, message),
            }),
          });
          await processingReactions.stopAll();
        }
      }
    },

    async handleAssistantThreadStarted(event: TAssistantEvent): Promise<void> {
      await withLogContext(
        logContext({
          threadId: event.threadId,
          actorId: event.userId,
          channelId: event.channelId,
        }),
        async () => {
          try {
            await deps.initializeAssistantThread({
              threadId: event.threadId,
              channelId: event.channelId,
              threadTs: event.threadTs,
              sourceChannelId: event.context?.channelId,
            });
          } catch (error) {
            logException(error, "assistant.thread.initialization.failed");
          }
        },
      );
    },

    async handleAssistantContextChanged(event: TAssistantEvent): Promise<void> {
      await withLogContext(
        logContext({
          threadId: event.threadId,
          actorId: event.userId,
          channelId: event.channelId,
        }),
        async () => {
          try {
            await deps.refreshAssistantThreadContext({
              threadId: event.threadId,
              channelId: event.channelId,
              threadTs: event.threadTs,
              sourceChannelId: event.context?.channelId,
            });
          } catch (error) {
            logException(error, "assistant.context.refresh.failed");
          }
        },
      );
    },
  };
}
