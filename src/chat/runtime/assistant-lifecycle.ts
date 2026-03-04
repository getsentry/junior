import { ThreadImpl } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import { coerceThreadArtifactsState } from "@/chat/slack-actions/types";
import { mergeArtifactsState, persistThreadState } from "@/chat/runtime/thread-state";

export async function initializeAssistantThread(event: {
  threadId: string;
  channelId: string;
  threadTs: string;
  sourceChannelId?: string;
  getSlackAdapter: () => SlackAdapter;
}): Promise<void> {
  const slack = event.getSlackAdapter();
  await slack.setAssistantTitle(event.channelId, event.threadTs, "Junior");
  await slack.setSuggestedPrompts(event.channelId, event.threadTs, [
    { title: "Summarize thread", message: "Summarize the latest discussion in this thread." },
    { title: "Draft a reply", message: "Draft a concise reply I can send." },
    { title: "Generate image", message: "Generate an image based on this conversation." }
  ]);

  if (!event.sourceChannelId) {
    return;
  }

  const thread = ThreadImpl.fromJSON({
    _type: "chat:Thread",
    adapterName: "slack",
    channelId: event.channelId,
    id: event.threadId,
    isDM: event.channelId.startsWith("D")
  });
  const currentArtifacts = coerceThreadArtifactsState(await thread.state);
  const nextArtifacts = mergeArtifactsState(currentArtifacts, {
    assistantContextChannelId: event.sourceChannelId
  });
  await persistThreadState(thread, {
    artifacts: nextArtifacts
  });
}
