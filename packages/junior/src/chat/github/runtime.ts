import type { Message, Thread } from "chat";
import { isRetryableTurnError } from "@/chat/runtime/turn";

export interface GitHubReplyHooks {
  beforeFirstResponsePost?: () => Promise<void>;
}

export interface GitHubTurnRuntime {
  handleNewMention: (
    thread: Thread,
    message: Message,
    hooks?: GitHubReplyHooks,
  ) => Promise<void>;
}

export interface GitHubTurnRuntimeDependencies {
  assistantUserName: string;
  getRunId: (thread: Thread, message: Message) => string | undefined;
  getThreadId: (thread: Thread, message: Message) => string | undefined;
  logException: (
    error: unknown,
    eventName: string,
    context?: Record<string, unknown>,
    attributes?: Record<string, unknown>,
    body?: string,
  ) => string | undefined;
  modelId: string;
  replyToThread: (
    thread: Thread,
    message: Message,
    options?: {
      beforeFirstResponsePost?: () => Promise<void>;
      explicitMention?: boolean;
    },
  ) => Promise<void>;
  withSpan: (
    name: string,
    op: string,
    context: Record<string, unknown>,
    callback: () => Promise<void>,
  ) => Promise<void>;
}

export function createGitHubTurnRuntime(
  deps: GitHubTurnRuntimeDependencies,
): GitHubTurnRuntime {
  return {
    async handleNewMention(
      thread: Thread,
      message: Message,
      hooks?: GitHubReplyHooks,
    ): Promise<void> {
      const threadId = deps.getThreadId(thread, message);
      const runId = deps.getRunId(thread, message);
      const conversationId = threadId ?? runId;
      try {
        await deps.withSpan(
          "chat.turn",
          "chat.turn",
          {
            conversationId,
            runId,
            assistantUserName: deps.assistantUserName,
            modelId: deps.modelId,
          },
          async () => {
            await deps.replyToThread(thread, message, {
              explicitMention: true,
              beforeFirstResponsePost: hooks?.beforeFirstResponsePost,
            });
          },
        );
      } catch (error) {
        if (
          isRetryableTurnError(error, "mcp_auth_resume") ||
          isRetryableTurnError(error, "plugin_auth_resume")
        ) {
          deps.logException(
            error,
            "github_mention_handler_auth_pause",
            {
              conversationId,
              runId,
              assistantUserName: deps.assistantUserName,
              modelId: deps.modelId,
            },
            {
              "app.ai.retryable_reason": error.reason,
              "app.surface.platform": "github",
            },
            "GitHub mention handler parked turn for auth resume",
          );
          return;
        }
        deps.logException(
          error,
          "github_mention_handler_failed",
          {
            conversationId,
            runId,
            assistantUserName: deps.assistantUserName,
            modelId: deps.modelId,
          },
          {
            "app.surface.platform": "github",
          },
          "GitHub mention handler failed",
        );
      }
    },
  };
}
