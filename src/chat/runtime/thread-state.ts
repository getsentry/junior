import type { Thread } from "chat";
import { createChannelConfigurationService } from "@/chat/configuration/service";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { buildConversationStatePatch } from "@/chat/conversation-state";
import type { ThreadConversationState } from "@/chat/conversation-state";
import { buildArtifactStatePatch, type ThreadArtifactsState } from "@/chat/slack-actions/types";

export function mergeArtifactsState(
  artifacts: ThreadArtifactsState,
  patch: Partial<ThreadArtifactsState> | undefined
): ThreadArtifactsState {
  if (!patch) {
    return artifacts;
  }

  return {
    ...artifacts,
    ...patch,
    listColumnMap: {
      ...artifacts.listColumnMap,
      ...patch.listColumnMap
    }
  };
}

export async function persistThreadState(
  thread: Thread,
  patch: {
    artifacts?: ThreadArtifactsState;
    conversation?: ThreadConversationState;
    sandboxId?: string;
  }
): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (patch.artifacts) {
    Object.assign(payload, buildArtifactStatePatch(patch.artifacts));
  }
  if (patch.conversation) {
    Object.assign(payload, buildConversationStatePatch(patch.conversation));
  }
  if (patch.sandboxId) {
    payload.app_sandbox_id = patch.sandboxId;
  }

  if (Object.keys(payload).length === 0) {
    return;
  }
  await thread.setState(payload);
}

export function getChannelConfigurationService(thread: Thread): ChannelConfigurationService {
  const channel = thread.channel;
  return createChannelConfigurationService({
    load: async () => channel.state,
    save: async (state) => {
      await channel.setState({
        configuration: state
      });
    }
  });
}
