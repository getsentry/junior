import type { Message, Thread } from "chat";
import { getSubscribedReplyPreflightDecision } from "@/chat/routing/subscribed-decision";
import { isRetryableTurnError } from "@/chat/turn/errors";
import type { ErrorReference } from "@/chat/observability";
import { getSlackErrorObservabilityAttributes } from "@/chat/runtime/thread-context";

export interface AppRuntimeAssistantLifecycleEvent {
  channelId: string;
  context?: {
    channelId?: string;
  };
  threadId: string;
  threadTs: string;
  userId?: string;
}

export interface AppRuntimeThreadContext {
  channelId?: string;
  requesterId?: string;
  threadId?: string;
  runId?: string;
}

export interface AppRuntimeReplyDecision {
  reason: string;
  shouldReply: boolean;
  shouldUnsubscribe?: boolean;
}

export interface AppRuntimeReplyHooks {
  beforeFirstResponsePost?: () => Promise<void>;
  preApprovedReply?: boolean;
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

type AppRuntimeLogContext = Record<string, unknown> & {
  assistantUserName: string;
  modelId: string;
  slackChannelId?: string;
  slackThreadId?: string;
  slackUserId?: string;
  slackUserName?: string;
  runId?: string;
};

export interface AppSlackRuntimeDependencies<TPreparedState> {
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
  getErrorReference: (eventId?: string) => ErrorReference | null;
  recordSkippedSubscribedMessage: (args: {
    completedAtMs: number;
    decision: AppRuntimeReplyDecision;
    message: Message;
    thread: Thread;
    userText: string;
  }) => Promise<void>;
  onSubscribedMessageSkipped: (args: {
    completedAtMs: number;
    decision: AppRuntimeReplyDecision;
    message: Message;
    preparedState?: TPreparedState;
    thread: Thread;
  }) => Promise<void>;
  persistPreparedState: (args: {
    preparedState: TPreparedState;
    thread: Thread;
  }) => Promise<void>;
  prepareTurnState: (args: {
    context: AppRuntimeThreadContext;
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
  shouldReplyInSubscribedThread: (args: {
    context: AppRuntimeThreadContext;
    conversationContext?: string;
    hasAttachments?: boolean;
    isExplicitMention?: boolean;
    rawText: string;
    text: string;
  }) => Promise<AppRuntimeReplyDecision>;
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

function buildFailureMessage(reference: ErrorReference | null): string {
  if (!reference) {
    return "I ran into an internal error while processing that. Please try again.";
  }
  if (reference.eventId) {
    return `I ran into an internal error while processing that. Reference: \`event_id=${reference.eventId} trace_id=${reference.traceId}\`.`;
  }
  return `I ran into an internal error while processing that. Reference: \`trace_id=${reference.traceId}\`.`;
}

export interface AppSlackRuntime<
  TPreparedState,
  TAssistantEvent extends AppRuntimeAssistantLifecycleEvent =
    AppRuntimeAssistantLifecycleEvent,
> {
  handleAssistantContextChanged: (event: TAssistantEvent) => Promise<void>;
  handleAssistantThreadStarted: (event: TAssistantEvent) => Promise<void>;
  handleNewMention: (
    thread: Thread,
    message: Message,
    hooks?: AppRuntimeReplyHooks,
  ) => Promise<void>;
  handleSubscribedMessage: (
    thread: Thread,
    message: Message,
    hooks?: AppRuntimeReplyHooks,
  ) => Promise<void>;
}

function buildLogContext(
  deps: Pick<
    AppSlackRuntimeDependencies<unknown>,
    "assistantUserName" | "modelId"
  >,
  args: {
    channelId?: string;
    requesterId?: string;
    requesterUserName?: string;
    threadId?: string;
    runId?: string;
  },
): AppRuntimeLogContext {
  return {
    slackThreadId: args.threadId,
    slackUserId: args.requesterId,
    slackUserName: args.requesterUserName,
    slackChannelId: args.channelId,
    runId: args.runId,
    assistantUserName: deps.assistantUserName,
    modelId: deps.modelId,
  };
}

export function createAppSlackRuntime<
  TPreparedState,
  TAssistantEvent extends AppRuntimeAssistantLifecycleEvent =
    AppRuntimeAssistantLifecycleEvent,
>(
  deps: AppSlackRuntimeDependencies<TPreparedState>,
): AppSlackRuntime<TPreparedState, TAssistantEvent> {
  const logContext = (args: {
    channelId?: string;
    requesterId?: string;
    requesterUserName?: string;
    threadId?: string;
    runId?: string;
  }): AppRuntimeLogContext => buildLogContext(deps, args);

  const postFallbackErrorReplyWithLogging = async (args: {
    thread: Thread;
    reference: ErrorReference | null;
    errorContext: AppRuntimeLogContext;
    eventId?: string;
    postFailureEventName: string;
    postFailureBody: string;
  }): Promise<void> => {
    try {
      await args.thread.post(buildFailureMessage(args.reference));
    } catch (postError) {
      deps.logException(
        postError,
        args.postFailureEventName,
        args.errorContext,
        {
          "app.slack.reply_stage": "error_fallback_post",
          ...(args.eventId
            ? { "app.error.original_event_id": args.eventId }
            : {}),
          ...getSlackErrorObservabilityAttributes(postError),
        },
        args.postFailureBody,
      );
      throw postError;
    }
  };

  return {
    async handleNewMention(
      thread: Thread,
      message: Message,
      hooks?: AppRuntimeReplyHooks,
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
        if (isRetryableTurnError(error, "mcp_auth_resume")) {
          deps.logException(
            error,
            "mention_handler_auth_pause",
            errorContext,
            { "app.turn.retryable_reason": error.reason },
            "onNewMention parked turn for MCP auth resume",
          );
          return;
        }
        if (isRetryableTurnError(error)) {
          deps.logException(
            error,
            "mention_handler_retryable_failure",
            errorContext,
            { "app.turn.retryable_reason": error.reason },
            "onNewMention failed with retryable error",
          );
          throw error;
        }
        const eventId = deps.logException(
          error,
          "mention_handler_failed",
          errorContext,
          {},
          "onNewMention failed",
        );
        await hooks?.beforeFirstResponsePost?.();
        const reference = deps.getErrorReference(eventId);
        await postFallbackErrorReplyWithLogging({
          thread,
          reference,
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
      hooks?: AppRuntimeReplyHooks,
    ): Promise<void> {
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(thread, message);
        const runId = deps.getRunId(thread, message);
        const rawUserText = message.text;
        const userText = deps.stripLeadingBotMention(rawUserText, {
          stripLeadingSlackMentionToken: Boolean(message.isMention),
        });
        const context: AppRuntimeThreadContext = {
          threadId,
          requesterId: message.author.userId,
          channelId,
          runId,
        };

        const preflightDecision = hooks?.preApprovedReply
          ? undefined
          : getSubscribedReplyPreflightDecision({
              botUserName: deps.assistantUserName,
              rawText: rawUserText,
              text: userText,
              isExplicitMention: Boolean(message.isMention),
            });

        if (preflightDecision && !preflightDecision.shouldReply) {
          const completedAtMs = deps.now();
          const reason = preflightDecision.reasonDetail
            ? `${preflightDecision.reason}:${preflightDecision.reasonDetail}`
            : preflightDecision.reason;
          deps.logWarn(
            "subscribed_message_reply_skipped",
            logContext({
              threadId,
              requesterId: message.author.userId,
              requesterUserName: message.author.userName,
              channelId,
              runId,
            }),
            {
              "app.decision.reason": reason,
            },
            "Skipping subscribed message reply",
          );
          await deps.onSubscribedMessageSkipped({
            thread,
            message,
            decision: { shouldReply: false, reason },
            completedAtMs,
            preparedState: undefined,
          });
          await deps.recordSkippedSubscribedMessage({
            thread,
            message,
            decision: { shouldReply: false, reason },
            completedAtMs,
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

        const decision = hooks?.preApprovedReply
          ? {
              shouldReply: true,
              reason: "pre_approved_reply",
            }
          : await deps.shouldReplyInSubscribedThread({
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
          deps.logWarn(
            "subscribed_message_reply_skipped",
            logContext({
              threadId,
              requesterId: message.author.userId,
              requesterUserName: message.author.userName,
              channelId,
              runId,
            }),
            {
              "app.decision.reason": decision.reason,
            },
            "Skipping subscribed message reply",
          );
          await deps.onSubscribedMessageSkipped({
            thread,
            message,
            preparedState,
            decision,
            completedAtMs: deps.now(),
          });
          return;
        }

        if (!decision.shouldReply) {
          deps.logWarn(
            "subscribed_message_reply_skipped",
            logContext({
              threadId,
              requesterId: message.author.userId,
              requesterUserName: message.author.userName,
              channelId,
              runId,
            }),
            {
              "app.decision.reason": decision.reason,
            },
            "Skipping subscribed message reply",
          );
          await deps.onSubscribedMessageSkipped({
            thread,
            message,
            preparedState,
            decision,
            completedAtMs: deps.now(),
          });
          return;
        }

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
        if (isRetryableTurnError(error, "mcp_auth_resume")) {
          deps.logException(
            error,
            "subscribed_message_handler_auth_pause",
            errorContext,
            { "app.turn.retryable_reason": error.reason },
            "onSubscribedMessage parked turn for MCP auth resume",
          );
          return;
        }
        if (isRetryableTurnError(error)) {
          deps.logException(
            error,
            "subscribed_message_handler_retryable_failure",
            errorContext,
            { "app.turn.retryable_reason": error.reason },
            "onSubscribedMessage failed with retryable error",
          );
          throw error;
        }
        const eventId = deps.logException(
          error,
          "subscribed_message_handler_failed",
          errorContext,
          {},
          "onSubscribedMessage failed",
        );
        await hooks?.beforeFirstResponsePost?.();
        const reference = deps.getErrorReference(eventId);
        await postFallbackErrorReplyWithLogging({
          thread,
          reference,
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
        await deps.initializeAssistantThread({
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
