import { Chat } from "chat";
import type { PostableMessage } from "chat";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { botConfig } from "@/chat/config";
import { captureException, toOptionalString, withSpan } from "@/chat/observability";
import { buildSlackOutputMessage } from "@/chat/output";
import { generateAssistantReply } from "@/chat/respond";
import { lookupSlackUser } from "@/chat/slack-user";
import { createStateAdapter } from "@/chat/state";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingBotMention(text: string): string {
  if (!text.trim()) return text;
  const mentionRe = new RegExp(`^\\s*@${escapeRegExp(botConfig.userName)}\\b[\\s,:-]*`, "i");
  return text.replace(mentionRe, "").trim();
}

function getThreadId(thread: unknown, message: unknown): string | undefined {
  return (
    toOptionalString((thread as { id?: unknown }).id) ??
    toOptionalString((message as { threadId?: unknown }).threadId) ??
    toOptionalString((message as { threadTs?: unknown }).threadTs)
  );
}

function getWorkflowRunId(thread: unknown, message: unknown): string | undefined {
  return (
    toOptionalString((thread as { runId?: unknown }).runId) ??
    toOptionalString((message as { runId?: unknown }).runId)
  );
}

function getChannelId(message: unknown): string | undefined {
  return toOptionalString((message as { channelId?: unknown }).channelId);
}

interface ProgressSentMessage {
  delete?: () => Promise<unknown>;
}

interface AssistantThreadMeta {
  channelId: string;
  threadTs: string;
}

function getSlackAdapter(): SlackAdapter {
  return bot.getAdapter("slack") as SlackAdapter;
}

function parseAssistantThreadMeta(threadId: string | undefined): AssistantThreadMeta | null {
  if (!threadId) {
    return null;
  }

  const match = threadId.match(/^slack:([^:]+):(.+)$/);
  if (!match) {
    return null;
  }

  const channelId = match[1];
  const threadTs = match[2];
  if (!channelId || !threadTs) {
    return null;
  }

  return { channelId, threadTs };
}

interface ProgressContext {
  slackThreadId?: string;
  slackUserId?: string;
  slackChannelId?: string;
  workflowRunId?: string;
}

function createProgressReporter(thread: {
  post: (message: string | PostableMessage) => Promise<unknown>;
  startTyping?: (status?: string) => Promise<void>;
  id?: string;
}, context: ProgressContext) {
  const fallbackStatus = "Still working on it...";
  const assistantStatuses = ["Analyzing context...", "Running tools...", "Drafting response..."];
  const startDelayMs = 3500;
  const assistantTickMs = 7000;
  let active = false;
  let assistantIndex = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let statusMessage: ProgressSentMessage | null = null;
  let missingMetaCaptured = false;

  const reportProgressIssue = (reason: string, error?: unknown): void => {
    const payload = error ?? new Error(reason);
    captureException(payload, {
      ...context,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    });
    console.warn("[junior] progress indicator issue", {
      reason,
      error: error instanceof Error ? error.message : error ? String(error) : undefined,
      threadId: context.slackThreadId,
      channelId: context.slackChannelId
    });
  };

  const postFallbackStatus = async (): Promise<void> => {
    try {
      await thread.startTyping?.(fallbackStatus);
      statusMessage = (await thread.post(fallbackStatus)) as ProgressSentMessage;
    } catch (error) {
      reportProgressIssue("fallback_status_post_failed", error);
    }
  };

  const postAssistantStatus = async (text: string): Promise<void> => {
    const threadId = toOptionalString(thread.id);
    const assistantThread = parseAssistantThreadMeta(threadId);
    if (!assistantThread || !threadId) {
      if (!missingMetaCaptured) {
        missingMetaCaptured = true;
        reportProgressIssue("assistant_thread_metadata_missing");
      }
      await postFallbackStatus();
      return;
    }

    try {
      await getSlackAdapter().setAssistantStatus(
        assistantThread.channelId,
        assistantThread.threadTs,
        text,
        assistantStatuses
      );
    } catch (error) {
      reportProgressIssue("assistant_status_update_failed", error);
      await postFallbackStatus();
    }
  };

  return {
    start() {
      active = true;
      timeoutId = setTimeout(async () => {
        if (!active) return;
        await postAssistantStatus(assistantStatuses[assistantIndex]);

        intervalId = setInterval(async () => {
          if (!active) return;
          assistantIndex = (assistantIndex + 1) % assistantStatuses.length;
          await postAssistantStatus(assistantStatuses[assistantIndex]);
        }, assistantTickMs);
      }, startDelayMs);
    },
    async stop() {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
      if (statusMessage?.delete) {
        try {
          await statusMessage.delete();
        } catch (error) {
          reportProgressIssue("fallback_status_delete_failed", error);
        }
      }
    }
  };
}

interface ThreadMessageSnapshot {
  text?: string | null;
  author?: {
    isMe?: boolean;
    userName?: string;
    fullName?: string;
  };
}

function buildChatHistory(recentMessages: ThreadMessageSnapshot[] | undefined, currentUserText: string): string | undefined {
  if (!recentMessages || recentMessages.length === 0) {
    return undefined;
  }

  const items = recentMessages
    .filter((entry) => typeof entry.text === "string" && entry.text.trim().length > 0)
    .map((entry) => {
      const role = entry.author?.isMe ? "assistant" : "user";
      const displayName = entry.author?.fullName || entry.author?.userName || role;
      return {
        role,
        displayName,
        text: (entry.text ?? "").trim()
      };
    });

  if (items.length === 0) {
    return undefined;
  }

  const last = items[items.length - 1];
  if (last && last.role === "user" && last.text === currentUserText.trim()) {
    items.pop();
  }

  const window = items.slice(-12);
  if (window.length === 0) {
    return undefined;
  }

  return window.map((item) => `[${item.role}] ${item.displayName}: ${item.text}`).join("\n");
}

export const bot = new Chat({
  userName: botConfig.userName,
  adapters: {
    slack: createSlackAdapter()
  },
  state: createStateAdapter()
});

async function replyToThread(
  thread: {
    post: (message: string | PostableMessage) => Promise<unknown>;
    startTyping?: (status?: string) => Promise<void>;
    recentMessages?: ThreadMessageSnapshot[];
    id?: string;
  },
  message: {
    author: { isMe: boolean; userId?: string; userName?: string; fullName?: string };
    text?: string | null;
  }
) {
  if (message.author.isMe) {
    return;
  }

  const threadId = getThreadId(thread, message);
  const channelId = getChannelId(message);
  const workflowRunId = getWorkflowRunId(thread, message);

  await withSpan(
    "workflow.reply",
    "workflow.reply",
    {
      slackThreadId: threadId,
      slackUserId: message.author.userId,
      slackChannelId: channelId,
      workflowRunId,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    },
    async () => {
      const userText = stripLeadingBotMention(message.text ?? "");
      const chatHistory = buildChatHistory(thread.recentMessages, userText);
      const fallbackIdentity = await lookupSlackUser(message.author.userId);
      await thread.startTyping?.("Thinking...");
      const progress = createProgressReporter(thread, {
        slackThreadId: threadId,
        slackUserId: message.author.userId,
        slackChannelId: channelId,
        workflowRunId
      });
      progress.start();

      try {
        const reply = await generateAssistantReply(userText, {
          assistant: {
            userId: botConfig.slackBotUserId,
            userName: botConfig.userName
          },
          requester: {
            userId: message.author.userId,
            userName: message.author.userName ?? fallbackIdentity?.userName,
            fullName: message.author.fullName ?? fallbackIdentity?.fullName
          },
          chatHistory,
          correlation: {
            threadId,
            workflowRunId,
            channelId,
            requesterId: message.author.userId
          }
        });

        await thread.post(
          buildSlackOutputMessage(reply.text, {
            files: reply.files
          })
        );
      } finally {
        await progress.stop();
      }
    }
  );
}

async function initializeAssistantThread(event: {
  threadId: string;
  channelId: string;
  threadTs: string;
}): Promise<void> {
  const slack = getSlackAdapter();
  await slack.setAssistantTitle(event.channelId, event.threadTs, "Junior");
  await slack.setSuggestedPrompts(event.channelId, event.threadTs, [
    { title: "Summarize thread", message: "Summarize the latest discussion in this thread." },
    { title: "Draft a reply", message: "Draft a concise reply I can send." },
    { title: "Generate image", message: "Generate an image based on this conversation." }
  ]);
}

bot.onNewMention(async (thread, message) => {
  try {
    const threadId = getThreadId(thread, message);
    const channelId = getChannelId(message);
    const workflowRunId = getWorkflowRunId(thread, message);

    await withSpan(
      "workflow.chat_turn",
      "workflow.chat_turn",
      {
        slackThreadId: threadId,
        slackUserId: message.author.userId,
        slackChannelId: channelId,
        workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      async () => {
        await thread.subscribe();
        await replyToThread(thread, message);
      }
    );
  } catch (error) {
    captureException(error, {
      slackThreadId: getThreadId(thread, message),
      slackUserId: message.author.userId,
      slackChannelId: getChannelId(message),
      workflowRunId: getWorkflowRunId(thread, message),
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    });

    console.error("[junior] onNewMention failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    await thread.post("I hit an internal error and couldn't respond. Please try again.");
  }
});

bot.onSubscribedMessage(async (thread, message) => {
  try {
    const threadId = getThreadId(thread, message);
    const channelId = getChannelId(message);
    const workflowRunId = getWorkflowRunId(thread, message);

    await withSpan(
      "workflow.chat_turn",
      "workflow.chat_turn",
      {
        slackThreadId: threadId,
        slackUserId: message.author.userId,
        slackChannelId: channelId,
        workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      async () => {
        await replyToThread(thread, message);
      }
    );
  } catch (error) {
    captureException(error, {
      slackThreadId: getThreadId(thread, message),
      slackUserId: message.author.userId,
      slackChannelId: getChannelId(message),
      workflowRunId: getWorkflowRunId(thread, message),
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    });

    console.error("[junior] onSubscribedMessage failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    await thread.post("I hit an internal error and couldn't respond. Please try again.");
  }
});

bot.onAssistantThreadStarted(async (event) => {
  try {
    await initializeAssistantThread({
      threadId: event.threadId,
      channelId: event.channelId,
      threadTs: event.threadTs
    });
  } catch (error) {
    captureException(error, {
      slackThreadId: event.threadId,
      slackUserId: event.userId,
      slackChannelId: event.channelId,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    });

    console.error("[junior] onAssistantThreadStarted failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

bot.onAssistantContextChanged(async (event) => {
  try {
    await initializeAssistantThread({
      threadId: event.threadId,
      channelId: event.channelId,
      threadTs: event.threadTs
    });
  } catch (error) {
    captureException(error, {
      slackThreadId: event.threadId,
      slackUserId: event.userId,
      slackChannelId: event.channelId,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    });

    console.error("[junior] onAssistantContextChanged failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
