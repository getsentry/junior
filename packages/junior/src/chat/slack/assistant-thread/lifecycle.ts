import type { SlackAdapter } from "@chat-adapter/slack";
import { normalizeSlackConversationId } from "@/chat/slack/client";

interface AssistantThreadLifecycleEvent {
  channelId: string;
  threadTs: string;
  sourceChannelId?: string;
  getSlackAdapter: () => SlackAdapter;
  onContextChannelResolved: (sourceChannelId: string) => Promise<void>;
}

async function syncAssistantThreadContext(
  event: AssistantThreadLifecycleEvent,
  options: { setInitialTitle: boolean },
): Promise<void> {
  const channelId = normalizeSlackConversationId(event.channelId);
  if (!channelId) {
    throw new Error("Assistant thread initialization requires a channel ID");
  }
  const sourceChannelId = event.sourceChannelId
    ? normalizeSlackConversationId(event.sourceChannelId)
    : undefined;
  const slack = event.getSlackAdapter();
  if (options.setInitialTitle) {
    await slack.setAssistantTitle(channelId, event.threadTs, "Junior");
  }
  await slack.setSuggestedPrompts(channelId, event.threadTs, [
    {
      title: "Summarize thread",
      message: "Summarize the latest discussion in this thread.",
    },
    { title: "Draft a reply", message: "Draft a concise reply I can send." },
    {
      title: "Generate image",
      message: "Generate an image based on this conversation.",
    },
  ]);

  if (!sourceChannelId) {
    return;
  }

  await event.onContextChannelResolved(sourceChannelId);
}

/** Initialize a newly started Slack assistant thread. */
export async function initializeAssistantThread(
  event: AssistantThreadLifecycleEvent,
): Promise<void> {
  await syncAssistantThreadContext(event, { setInitialTitle: true });
}

/** Refresh Slack assistant thread context without resetting the thread title. */
export async function refreshAssistantThreadContext(
  event: AssistantThreadLifecycleEvent,
): Promise<void> {
  await syncAssistantThreadContext(event, { setInitialTitle: false });
}
