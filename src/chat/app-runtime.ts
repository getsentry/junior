import type { Attachment } from "chat";

export interface AppRuntimeMessageAuthor {
  fullName?: string;
  isBot?: boolean | "unknown";
  isMe: boolean;
  userId?: string;
  userName?: string;
}

export interface AppRuntimeIncomingMessage {
  attachments?: Attachment[];
  author: AppRuntimeMessageAuthor;
  id?: string;
  isMention?: boolean;
  metadata?: {
    dateSent?: Date;
  };
  text?: string | null;
  threadId?: string;
  threadTs?: string;
  channelId?: string;
  runId?: string;
}

export interface AppRuntimeThreadHandle {
  id: string;
  runId?: string;
  post: (message: any) => Promise<unknown>;
  refresh?: () => Promise<void>;
  recentMessages?: unknown[];
  setState?: (state: Record<string, unknown>, options?: { replace?: boolean }) => Promise<void>;
  state?: Promise<unknown | null>;
  subscribe?: () => Promise<void>;
}

export interface AppRuntimeAssistantLifecycleEvent {
  channelId: string;
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

type AppRuntimeLogContext = Record<string, unknown> & {
  assistantUserName: string;
  modelId: string;
  slackChannelId?: string;
  slackThreadId?: string;
  slackUserId?: string;
  workflowRunId?: string;
};

export interface AppSlackRuntimeDependencies<
  TPreparedState,
  TThread extends AppRuntimeThreadHandle,
  TMessage extends AppRuntimeIncomingMessage
> {
  assistantUserName: string;
  getChannelId: (message: TMessage) => string | undefined;
  getPreparedConversationContext: (preparedState: TPreparedState) => string | undefined;
  getThreadId: (thread: TThread, message: TMessage) => string | undefined;
  getWorkflowRunId: (thread: TThread, message: TMessage) => string | undefined;
  initializeAssistantThread: (event: {
    channelId: string;
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
    message: TMessage;
    preparedState: TPreparedState;
    thread: TThread;
  }) => Promise<void>;
  persistPreparedState: (args: {
    preparedState: TPreparedState;
    thread: TThread;
  }) => Promise<void>;
  prepareTurnState: (args: {
    context: AppRuntimeThreadContext;
    explicitMention: boolean;
    message: TMessage;
    thread: TThread;
    userText: string;
  }) => Promise<TPreparedState>;
  replyToThread: (
    thread: TThread,
    message: TMessage,
    options?: {
      explicitMention?: boolean;
      preparedState?: TPreparedState;
    }
  ) => Promise<void>;
  shouldReplyInSubscribedThread: (args: {
    context: AppRuntimeThreadContext;
    conversationContext?: string;
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
  TThread extends AppRuntimeThreadHandle,
  TMessage extends AppRuntimeIncomingMessage,
  TAssistantEvent extends AppRuntimeAssistantLifecycleEvent = AppRuntimeAssistantLifecycleEvent
> {
  handleAssistantContextChanged: (event: TAssistantEvent) => Promise<void>;
  handleAssistantThreadStarted: (event: TAssistantEvent) => Promise<void>;
  handleNewMention: (thread: TThread, message: TMessage) => Promise<void>;
  handleSubscribedMessage: (thread: TThread, message: TMessage) => Promise<void>;
}

function buildLogContext(
  deps: AppSlackRuntimeDependencies<unknown, AppRuntimeThreadHandle, AppRuntimeIncomingMessage>,
  args: {
    channelId?: string;
    requesterId?: string;
    threadId?: string;
    workflowRunId?: string;
  }
): AppRuntimeLogContext {
  return {
    slackThreadId: args.threadId,
    slackUserId: args.requesterId,
    slackChannelId: args.channelId,
    workflowRunId: args.workflowRunId,
    assistantUserName: deps.assistantUserName,
    modelId: deps.modelId
  };
}

export function createAppSlackRuntime<
  TPreparedState,
  TThread extends AppRuntimeThreadHandle = AppRuntimeThreadHandle,
  TMessage extends AppRuntimeIncomingMessage = AppRuntimeIncomingMessage,
  TAssistantEvent extends AppRuntimeAssistantLifecycleEvent = AppRuntimeAssistantLifecycleEvent
>(
  deps: AppSlackRuntimeDependencies<TPreparedState, TThread, TMessage>
): AppSlackRuntime<TPreparedState, TThread, TMessage, TAssistantEvent> {
  const logContext = (args: {
    channelId?: string;
    requesterId?: string;
    threadId?: string;
    workflowRunId?: string;
  }): AppRuntimeLogContext =>
    buildLogContext(
      deps as AppSlackRuntimeDependencies<unknown, AppRuntimeThreadHandle, AppRuntimeIncomingMessage>,
      args
    );

  return {
    async handleNewMention(thread: TThread, message: TMessage): Promise<void> {
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(message);
        const workflowRunId = deps.getWorkflowRunId(thread, message);
        const context = logContext({
          threadId,
          channelId,
          requesterId: message.author.userId,
          workflowRunId
        });

        await deps.withSpan(
          "workflow.chat_turn",
          "workflow.chat_turn",
          context,
          async () => {
            await thread.subscribe?.();
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
            channelId: deps.getChannelId(message),
            workflowRunId: deps.getWorkflowRunId(thread, message)
          }),
          {},
          "onNewMention failed"
        );
        const errorMessage = error instanceof Error ? error.message : String(error);
        await thread.post(`Error: ${errorMessage}`);
      }
    },

    async handleSubscribedMessage(thread: TThread, message: TMessage): Promise<void> {
      try {
        const threadId = deps.getThreadId(thread, message);
        const channelId = deps.getChannelId(message);
        const workflowRunId = deps.getWorkflowRunId(thread, message);
        const rawUserText = message.text ?? "";
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
          isExplicitMention: Boolean(message.isMention),
          context
        });

        if (!decision.shouldReply) {
          deps.logWarn(
            "subscribed_message_reply_skipped",
            logContext({
              threadId,
              requesterId: message.author.userId,
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
            channelId,
            workflowRunId
          }),
          async () => {
            await deps.replyToThread(thread, message, {
              explicitMention: decision.reason === "explicit mention",
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
            channelId: deps.getChannelId(message),
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
          threadTs: event.threadTs
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
          threadTs: event.threadTs
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
