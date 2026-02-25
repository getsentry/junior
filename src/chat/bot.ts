import { Chat } from "chat";
import type { PostableMessage } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { botConfig } from "@/chat/config";
import { createStateAdapter } from "@/chat/state";
import { generateAssistantReply } from "@/chat/respond";
import { lookupSlackUser } from "@/chat/slack-user";
import { buildSlackOutputMessage } from "@/chat/output";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingBotMention(text: string): string {
  if (!text.trim()) return text;
  const mentionRe = new RegExp(`^\\s*@${escapeRegExp(botConfig.userName)}\\b[\\s,:-]*`, "i");
  return text.replace(mentionRe, "").trim();
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
    }
  });
  await thread.post(
    buildSlackOutputMessage(reply.text, {
      files: reply.files
    })
  );
}

bot.onNewMention(async (thread, message) => {
  try {
    await thread.subscribe();
    await replyToThread(thread, message);
  } catch (error) {
    console.error("[junior] onNewMention failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    await thread.post("I hit an internal error and couldn't respond. Please try again.");
  }
});

bot.onSubscribedMessage(async (thread, message) => {
  try {
    await replyToThread(thread, message);
  } catch (error) {
    console.error("[junior] onSubscribedMessage failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    await thread.post("I hit an internal error and couldn't respond. Please try again.");
  }
});
