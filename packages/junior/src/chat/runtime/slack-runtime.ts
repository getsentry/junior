/**
 * Slack event runtime.
 *
 * This module owns inbound Slack routing decisions for mentions, subscribed
 * messages, assistant lifecycle events, and retryable turn pauses. It should
 * normalize text/queued context and decide reply vs silence while keeping
 * Pi/MCP internals and durable session storage behind injected services.
 */
import type { Message, MessageContext, Thread } from "chat";
import { getSubscribedReplyPreflightDecision } from "@/chat/services/subscribed-decision";
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

export interface ReplyHooks {
  beforeFirstResponsePost?: () => Promise<void>;
  drainSteeringMessages?: (
    inject: (messages: Message[]) => Promise<void>,
  ) => Promise<Message[]>;
  messageContext?: MessageContext;
  onInputCommitted?: () => Promise<void>;
  onToolInvocation?: (invocation: TurnToolInvocation) => void;
  onTurnStatePersisted?: () => Promise<void>;
  shouldYield?: () => boolean;
}

const THREAD_OPTOUT_ACK =
  "Understood. I'll stay out of this thread unless someone @mentions me again.";
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
  recordSkippedSubscribedMessage: (args: {
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
    preparedState?: TPreparedState;
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
    options?: {
      beforeFirstResponsePost?: () => Promise<void>;
      explicitMention?: boolean;
      onInputCommitted?: () => Promise<void>;
      onToolInvocation?: (invocation: TurnToolInvocation) => void;
      onTurnCompleted?: () => Promise<void>;
      onTurnStatePersisted?: () => Promise<void>;
      preparedState?: TPreparedState;
      queuedMessages?: QueuedTurnMessage[];
      drainSteeringMessages?: (
        inject: (messages: QueuedTurnMessage[]) => Promise<void>,
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

function createSteeringMessageDrain(
  hooks: ReplyHooks | undefined,
  options: {
    explicitMention: boolean;
    onMessagesAccepted?: (messages: Message[]) => Promise<void>;
    stripLeadingBotMention: SlackTurnRuntimeDependencies<unknown>["stripLeadingBotMention"];
  },
):
  | ((
      inject: (messages: QueuedTurnMessage[]) => Promise<void>,
    ) => Promise<QueuedTurnMessage[]>)
  | undefined {
  if (!hooks?.drainSteeringMessages) {
    return undefined;
  }

  return async (inject) => {
    let acceptedMessages: Message[] | undefined;
    const drained = await hooks.drainSteeringMessages!(async (messages) => {
      await inject(getQueuedMessagesFromSlackMessages(messages, options));
      acceptedMessages = messages;
      await options.onMessagesAccepted?.(messages);
    });
    if (!acceptedMessages) {
      await options.onMessagesAccepted?.(drained);
    }
    return getQueuedMessagesFromSlackMessages(drained, options);
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
    hooks?: ReplyHooks,
  ) => Promise<void>;
  handleSubscribedMessage: (
    thread: Thread,
    message: Message,
    hooks?: ReplyHooks,
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
    hooks: ReplyHooks | undefined,
  ) => {
    return (invocation: TurnToolInvocation): void => {
      if (shouldKeepProcessingReactionForToolInvocation(invocation)) {
        processingReaction.keep();
      }
      hooks?.onToolInvocation?.(invocation);
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

  /** Persist the skip decision at the same boundary that a reply would update. */
  const skipSubscribedMessage = async (args: {
    thread: Thread;
    message: Message;
    decision: SubscribedReplyDecision;
    context: TurnContext;
    preparedState?: TPreparedState;
    text: TurnMessageText;
  }): Promise<void> => {
    const completedAtMs = deps.now();
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
    await deps.onSubscribedMessageSkipped({
      thread: args.thread,
      message: args.message,
      preparedState: args.preparedState,
      decision: args.decision,
      completedAtMs,
    });
    if (!args.preparedState) {
      await deps.recordSkippedSubscribedMessage({
        thread: args.thread,
        message: args.message,
        decision: args.decision,
        completedAtMs,
        text: args.text,
      });
    }
  };

  return {
    async handleNewMention(
      thread: Thread,
      message: Message,
      hooks?: ReplyHooks,
    ): Promise<void> {
      const processingReactions = createProcessingReactionTracker(thread);
      let processingReaction: ProcessingReactionSession | undefined;
      let completed = false;
      const onTurnCompleted = async (): Promise<void> => {
        completed = true;
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
          const queuedMessages = getQueuedMessages(hooks?.messageContext, {
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
            await hooks?.onInputCommitted?.();
            await startQueuedProcessingReactions();
          };
          const drainSteeringMessages = createSteeringMessageDrain(hooks, {
            explicitMention: true,
            onMessagesAccepted: async (messages) => {
              await Promise.all(
                messages.map((drainedMessage) =>
                  processingReactions.start(context, drainedMessage),
                ),
              );
            },
            stripLeadingBotMention: deps.stripLeadingBotMention,
          });
          await deps.replyToThread(thread, message, {
            explicitMention: true,
            beforeFirstResponsePost: hooks?.beforeFirstResponsePost,
            queuedMessages,
            onInputCommitted,
            onToolInvocation: toolInvocationHook,
            onTurnCompleted,
            drainSteeringMessages,
            onTurnStatePersisted: hooks?.onTurnStatePersisted,
            shouldYield: hooks?.shouldYield,
          });
        });
      } catch (error) {
        if (
          isCooperativeTurnYieldError(error) ||
          isTurnInputCommitLostError(error)
        ) {
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
        await hooks?.beforeFirstResponsePost?.();
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
          await processingReactions.stopAll();
        }
      }
    },

    async handleSubscribedMessage(
      thread: Thread,
      message: Message,
      hooks?: ReplyHooks,
    ): Promise<void> {
      const processingReactions = createProcessingReactionTracker(thread);
      let processingReaction: ProcessingReactionSession | undefined;
      let completed = false;
      const onTurnCompleted = async (): Promise<void> => {
        completed = true;
      };
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(thread, message);
        const runId = deps.getRunId(thread, message);
        const turnContext = logContext({
          threadId,
          requesterId: message.author.userId,
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
            requesterId: message.author.userId,
            channelId,
            runId,
          };
          const queuedMessages = getQueuedMessages(hooks?.messageContext, {
            explicitMention: Boolean(message.isMention),
            stripLeadingBotMention: deps.stripLeadingBotMention,
          });
          const drainSteeringMessages = createSteeringMessageDrain(hooks, {
            explicitMention: Boolean(message.isMention),
            onMessagesAccepted: async (messages) => {
              await Promise.all(
                messages.map((drainedMessage) =>
                  processingReactions.start(turnContext, drainedMessage),
                ),
              );
            },
            stripLeadingBotMention: deps.stripLeadingBotMention,
          });
          const combinedText = combineTurnText(queuedMessages, currentText);
          const turnIsExplicitMention =
            Boolean(message.isMention) ||
            queuedMessages.some((queued) => queued.explicitMention);

          const preflightDecision = getSubscribedReplyPreflightDecision({
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

          const decision = await deps.decideSubscribedReply({
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
              beforeFirstResponsePost: hooks?.beforeFirstResponsePost,
            })
          ) {
            await skipSubscribedMessage({
              thread,
              message,
              decision,
              context: threadContext,
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
              preparedState,
              text: combinedText,
            });
            return;
          }

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
            await hooks?.onInputCommitted?.();
            await startQueuedProcessingReactions();
          };
          const toolInvocationHook = createToolInvocationHook(
            processingReaction,
            hooks,
          );

          await deps.replyToThread(thread, message, {
            explicitMention: Boolean(message.isMention),
            preparedState,
            beforeFirstResponsePost: hooks?.beforeFirstResponsePost,
            queuedMessages,
            onInputCommitted,
            onToolInvocation: toolInvocationHook,
            onTurnCompleted,
            drainSteeringMessages,
            onTurnStatePersisted: hooks?.onTurnStatePersisted,
            shouldYield: hooks?.shouldYield,
          });
        });
      } catch (error) {
        if (
          isCooperativeTurnYieldError(error) ||
          isTurnInputCommitLostError(error)
        ) {
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
        await hooks?.beforeFirstResponsePost?.();
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
