import type { Message, Thread } from "chat";
import { getSubscribedReplyPreflightDecision } from "@/chat/services/subscribed-decision";
import { isRetryableTurnError } from "@/chat/runtime/turn";
import { buildTurnFailureResponse } from "@/chat/logging";
import { getSlackErrorObservabilityAttributes } from "@/chat/slack/errors";
import type { SubscribedReplyDecision } from "@/chat/services/subscribed-reply-policy";

export interface AssistantLifecycleEvent {
  channelId: string;
  context?: {
    channelId?: string;
  };
  threadId: string;
  threadTs: string;
  userId?: string;
}

export interface ThreadContext {
  channelId?: string;
  requesterId?: string;
  threadId?: string;
  runId?: string;
}

export interface ReplyHooks {
  beforeFirstResponsePost?: () => Promise<void>;
}

const THREAD_OPTOUT_ACK =
  "Understood. I'll stay out of this thread unless someone @mentions me again.";
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
    thread: Thread;
    userText: string;
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
  prepareTurnState: (args: {
    context: ThreadContext;
    explicitMention: boolean;
    message: Message;
    thread: Thread;
    userText: string;
  }) => Promise<TPreparedState>;
  replyToThread: (
    thread: Thread,
    message: Message,
    options?: {
      beforeFirstResponsePost?: () => Promise<void>;
      explicitMention?: boolean;
      preparedState?: TPreparedState;
    },
  ) => Promise<void>;
  decideSubscribedReply: (args: {
    context: ThreadContext;
    conversationContext?: string;
    hasAttachments?: boolean;
    isExplicitMention?: boolean;
    rawText: string;
    text: string;
  }) => Promise<SubscribedReplyDecision>;
  stripLeadingBotMention: (
    text: string,
    options: {
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

  const skipSubscribedMessage = async (args: {
    thread: Thread;
    message: Message;
    decision: SubscribedReplyDecision;
    context: ThreadContext;
    preparedState?: TPreparedState;
    userText: string;
  }): Promise<void> => {
    const completedAtMs = deps.now();
    deps.logWarn(
      "subscribed_message_reply_skipped",
      logContext({
        threadId: args.context.threadId,
        requesterId: args.context.requesterId,
        requesterUserName: args.message.author.userName,
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
        userText: args.userText,
      });
    }
  };

  return {
    async handleNewMention(
      thread: Thread,
      message: Message,
      hooks?: ReplyHooks,
    ): Promise<void> {
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(thread, message);
        const runId = deps.getRunId(thread, message);
        const context = logContext({
          threadId,
          channelId,
          requesterId: message.author.userId,
          requesterUserName: message.author.userName,
          runId,
        });

        await deps.withSpan("chat.turn", "chat.turn", context, async () => {
          await thread.subscribe();
          await deps.replyToThread(thread, message, {
            explicitMention: true,
            beforeFirstResponsePost: hooks?.beforeFirstResponsePost,
          });
        });
      } catch (error) {
        const errorContext = logContext({
          threadId: deps.getThreadId(thread, message),
          requesterId: message.author.userId,
          requesterUserName: message.author.userName,
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
      }
    },

    async handleSubscribedMessage(
      thread: Thread,
      message: Message,
      hooks?: ReplyHooks,
    ): Promise<void> {
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(thread, message);
        const runId = deps.getRunId(thread, message);
        await deps.withSpan(
          "chat.turn",
          "chat.turn",
          logContext({
            threadId,
            requesterId: message.author.userId,
            requesterUserName: message.author.userName,
            channelId,
            runId,
          }),
          async () => {
            // This path can compact context and run router/vision model calls
            // before replyToThread() opens the main reply span.
            const rawUserText = message.text;
            const userText = deps.stripLeadingBotMention(rawUserText, {
              stripLeadingSlackMentionToken: Boolean(message.isMention),
            });
            const context: ThreadContext = {
              threadId,
              requesterId: message.author.userId,
              channelId,
              runId,
            };

            const preflightDecision = getSubscribedReplyPreflightDecision({
              botUserName: deps.assistantUserName,
              rawText: rawUserText,
              text: userText,
              isExplicitMention: Boolean(message.isMention),
            });

            if (preflightDecision && !preflightDecision.shouldReply) {
              const reason = preflightDecision.reasonDetail
                ? `${preflightDecision.reason}:${preflightDecision.reasonDetail}`
                : preflightDecision.reason;
              await skipSubscribedMessage({
                thread,
                message,
                decision: { shouldReply: false, reason },
                context,
                userText,
              });
              return;
            }

            const preparedState = await deps.prepareTurnState({
              thread,
              message,
              userText,
              explicitMention: Boolean(message.isMention),
              context,
            });

            await deps.persistPreparedState({
              thread,
              preparedState,
            });

            const decision = await deps.decideSubscribedReply({
              rawText: rawUserText,
              text: userText,
              conversationContext:
                deps.getPreparedConversationContext(preparedState),
              hasAttachments: message.attachments.length > 0,
              isExplicitMention: Boolean(message.isMention),
              context,
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
                context,
                preparedState,
                userText,
              });
              return;
            }

            if (!decision.shouldReply) {
              await skipSubscribedMessage({
                thread,
                message,
                decision,
                context,
                preparedState,
                userText,
              });
              return;
            }

            await deps.replyToThread(thread, message, {
              explicitMention: Boolean(message.isMention),
              preparedState,
              beforeFirstResponsePost: hooks?.beforeFirstResponsePost,
            });
          },
        );
      } catch (error) {
        const errorContext = logContext({
          threadId: deps.getThreadId(thread, message),
          requesterId: message.author.userId,
          requesterUserName: message.author.userName,
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
