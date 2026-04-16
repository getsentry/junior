import { ThreadImpl } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import {
  mergeArtifactsState,
  persistThreadState,
} from "@/chat/runtime/thread-state";
import { normalizeSlackConversationId } from "@/chat/slack/client";

interface AssistantThreadLifecycleEvent {
  threadId: string;
  channelId: string;
  threadTs: string;
  sourceChannelId?: string;
  getSlackAdapter: () => SlackAdapter;
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

  const thread = ThreadImpl.fromJSON({
    _type: "chat:Thread",
    adapterName: "slack",
    channelId,
    id: event.threadId,
    isDM: channelId.startsWith("D"),
  });
  const currentArtifacts = coerceThreadArtifactsState(await thread.state);
  const nextArtifacts = mergeArtifactsState(currentArtifacts, {
    assistantContextChannelId: sourceChannelId,
  });
  await persistThreadState(thread, {
    artifacts: nextArtifacts,
  });
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
