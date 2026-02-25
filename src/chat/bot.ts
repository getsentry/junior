import { Chat } from "chat";
import type { PostableMessage } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
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
      const fallbackIdentity = await lookupSlackUser(message.author.userId);
      await thread.startTyping?.("Thinking...");

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
    }
  );
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
