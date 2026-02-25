import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { botConfig } from "@/chat/config";
import { createStateAdapter } from "@/chat/state";
import { generateAssistantReply } from "@/chat/respond";

export const bot = new Chat({
  userName: botConfig.userName,
  adapters: {
    slack: createSlackAdapter()
  },
  state: createStateAdapter()
});

async function replyToThread(
  thread: { post: (text: string) => Promise<unknown> },
  message: { author: { isMe: boolean }; text?: string | null }
) {
  if (message.author.isMe) {
    return;
  }

  const text = await generateAssistantReply(message.text ?? "");
  await thread.post(text);
}

bot.onNewMention(async (thread, message) => {
  try {
    await thread.subscribe();
    await replyToThread(thread, message);
  } catch (error) {
    console.error("[shim] onNewMention failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    await thread.post("I hit an internal error and couldn't respond. Please try again.");
  }
});

bot.onSubscribedMessage(async (thread, message) => {
  try {
    await replyToThread(thread, message);
  } catch (error) {
    console.error("[shim] onSubscribedMessage failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    await thread.post("I hit an internal error and couldn't respond. Please try again.");
  }
});
