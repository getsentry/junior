import type { Message, Thread } from "chat";

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
  workflowRunId?: string;
}

export interface AppRuntimeReplyDecision {
  reason: string;
  shouldReply: boolean;
}

function isExplicitMentionDecision(reason: string): boolean {
  return reason === "explicit mention" || reason === "explicit_mention" || reason.startsWith("explicit_mention:");
}

type AppRuntimeLogContext = Record<string, unknown> & {
  assistantUserName: string;
  modelId: string;
  slackChannelId?: string;
  slackThreadId?: string;
  slackUserId?: string;
  slackUserName?: string;
  workflowRunId?: string;
};

export interface AppSlackRuntimeDependencies<TPreparedState> {
  assistantUserName: string;
  getChannelId: (thread: Thread, message: Message) => string | undefined;
  getPreparedConversationContext: (preparedState: TPreparedState) => string | undefined;
  getThreadId: (thread: Thread, message: Message) => string | undefined;
  getWorkflowRunId: (thread: Thread, message: Message) => string | undefined;
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
    body?: string
  ) => void;
  logWarn: (
    eventName: string,
    context?: Record<string, unknown>,
    attributes?: Record<string, unknown>,
    body?: string
  ) => void;
  modelId: string;
  now: () => number;
  onSubscribedMessageSkipped: (args: {
    completedAtMs: number;
    decision: AppRuntimeReplyDecision;
    message: Message;
    preparedState: TPreparedState;
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
      explicitMention?: boolean;
      preparedState?: TPreparedState;
    }
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
    }
  ) => string;
  withSpan: (
    name: string,
    op: string,
    context: Record<string, unknown>,
    callback: () => Promise<void>
  ) => Promise<void>;
}

export interface AppSlackRuntime<
  TPreparedState,
  TAssistantEvent extends AppRuntimeAssistantLifecycleEvent = AppRuntimeAssistantLifecycleEvent
> {
  handleAssistantContextChanged: (event: TAssistantEvent) => Promise<void>;
  handleAssistantThreadStarted: (event: TAssistantEvent) => Promise<void>;
  handleNewMention: (thread: Thread, message: Message) => Promise<void>;
  handleSubscribedMessage: (thread: Thread, message: Message) => Promise<void>;
}

function buildLogContext(
  deps: Pick<AppSlackRuntimeDependencies<unknown>, "assistantUserName" | "modelId">,
  args: {
    channelId?: string;
    requesterId?: string;
    requesterUserName?: string;
    threadId?: string;
    workflowRunId?: string;
  }
): AppRuntimeLogContext {
  return {
    slackThreadId: args.threadId,
    slackUserId: args.requesterId,
    slackUserName: args.requesterUserName,
    slackChannelId: args.channelId,
    workflowRunId: args.workflowRunId,
    assistantUserName: deps.assistantUserName,
    modelId: deps.modelId
  };
}

export function createAppSlackRuntime<
  TPreparedState,
  TAssistantEvent extends AppRuntimeAssistantLifecycleEvent = AppRuntimeAssistantLifecycleEvent
>(
  deps: AppSlackRuntimeDependencies<TPreparedState>
): AppSlackRuntime<TPreparedState, TAssistantEvent> {
  const logContext = (args: {
    channelId?: string;
    requesterId?: string;
    requesterUserName?: string;
    threadId?: string;
    workflowRunId?: string;
  }): AppRuntimeLogContext =>
    buildLogContext(deps, args);

  return {
    async handleNewMention(thread: Thread, message: Message): Promise<void> {
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(thread, message);
        const workflowRunId = deps.getWorkflowRunId(thread, message);
        const context = logContext({
          threadId,
          channelId,
          requesterId: message.author.userId,
          requesterUserName: message.author.userName,
          workflowRunId
        });

        await deps.withSpan(
          "workflow.chat_turn",
          "workflow.chat_turn",
          context,
          async () => {
            await thread.subscribe();
            await deps.replyToThread(thread, message, {
              explicitMention: true
            });
          }
        );
      } catch (error) {
        deps.logException(
          error,
          "mention_handler_failed",
          logContext({
            threadId: deps.getThreadId(thread, message),
            requesterId: message.author.userId,
            requesterUserName: message.author.userName,
            channelId: deps.getChannelId(thread, message),
            workflowRunId: deps.getWorkflowRunId(thread, message)
          }),
          {},
          "onNewMention failed"
        );
        const errorMessage = error instanceof Error ? error.message : String(error);
        await thread.post(`Error: ${errorMessage}`);
      }
    },

    async handleSubscribedMessage(thread: Thread, message: Message): Promise<void> {
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(thread, message);
        const workflowRunId = deps.getWorkflowRunId(thread, message);
        const rawUserText = message.text;
        const userText = deps.stripLeadingBotMention(rawUserText, {
          stripLeadingSlackMentionToken: Boolean(message.isMention)
        });
        const context: AppRuntimeThreadContext = {
          threadId,
          requesterId: message.author.userId,
          channelId,
          workflowRunId
        };

        const preparedState = await deps.prepareTurnState({
          thread,
          message,
          userText,
          explicitMention: Boolean(message.isMention),
          context
        });

        await deps.persistPreparedState({
          thread,
          preparedState
        });

        const decision = await deps.shouldReplyInSubscribedThread({
          rawText: rawUserText,
          text: userText,
          conversationContext: deps.getPreparedConversationContext(preparedState),
          hasAttachments: message.attachments.length > 0,
          isExplicitMention: Boolean(message.isMention),
          context
        });

        if (!decision.shouldReply) {
          deps.logWarn(
            "subscribed_message_reply_skipped",
            logContext({
              threadId,
              requesterId: message.author.userId,
              requesterUserName: message.author.userName,
              channelId,
              workflowRunId
            }),
            {
              "app.decision.reason": decision.reason
            },
            "Skipping subscribed message reply"
          );
          await deps.onSubscribedMessageSkipped({
            thread,
            message,
            preparedState,
            decision,
            completedAtMs: deps.now()
          });
          return;
        }

        await deps.withSpan(
          "workflow.chat_turn",
          "workflow.chat_turn",
          logContext({
            threadId,
            requesterId: message.author.userId,
            requesterUserName: message.author.userName,
            channelId,
            workflowRunId
          }),
          async () => {
            await deps.replyToThread(thread, message, {
              explicitMention: isExplicitMentionDecision(decision.reason),
              preparedState
            });
          }
        );
      } catch (error) {
        deps.logException(
          error,
          "subscribed_message_handler_failed",
          logContext({
            threadId: deps.getThreadId(thread, message),
            requesterId: message.author.userId,
            requesterUserName: message.author.userName,
            channelId: deps.getChannelId(thread, message),
            workflowRunId: deps.getWorkflowRunId(thread, message)
          }),
          {},
          "onSubscribedMessage failed"
        );
        const errorMessage = error instanceof Error ? error.message : String(error);
        await thread.post(`Error: ${errorMessage}`);
      }
    },

    async handleAssistantThreadStarted(event: TAssistantEvent): Promise<void> {
      try {
        await deps.initializeAssistantThread({
          threadId: event.threadId,
          channelId: event.channelId,
          threadTs: event.threadTs,
          sourceChannelId: event.context?.channelId
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
            modelId: deps.modelId
          },
          {},
          "onAssistantThreadStarted failed"
        );
      }
    },

    async handleAssistantContextChanged(event: TAssistantEvent): Promise<void> {
      try {
        await deps.initializeAssistantThread({
          threadId: event.threadId,
          channelId: event.channelId,
          threadTs: event.threadTs,
          sourceChannelId: event.context?.channelId
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
            modelId: deps.modelId
          },
          {},
          "onAssistantContextChanged failed"
        );
      }
    }
  };
}
