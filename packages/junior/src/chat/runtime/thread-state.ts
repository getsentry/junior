import { THREAD_STATE_TTL_MS, type Thread } from "chat";
import { createChannelConfigurationService } from "@/chat/configuration/service";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { buildConversationStatePatch } from "@/chat/state/conversation";
import type { ThreadConversationState } from "@/chat/state/conversation";
import {
  buildArtifactStatePatch,
  type ThreadArtifactsState,
} from "@/chat/state/artifacts";
import { getStateAdapter } from "@/chat/state/adapter";

export interface ThreadStatePatch {
  artifacts?: ThreadArtifactsState;
  conversation?: ThreadConversationState;
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
}

function threadStateKey(threadId: string): string {
  return `thread-state:${threadId}`;
}

function buildThreadStatePayload(
  patch: ThreadStatePatch,
): Record<string, unknown> {
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
  if (patch.sandboxDependencyProfileHash) {
    payload.app_sandbox_dependency_profile_hash =
      patch.sandboxDependencyProfileHash;
  }
  return payload;
}

export function mergeArtifactsState(
  artifacts: ThreadArtifactsState,
  patch: Partial<ThreadArtifactsState> | undefined,
): ThreadArtifactsState {
  if (!patch) {
    return artifacts;
  }

  return {
    ...artifacts,
    ...patch,
    listColumnMap: {
      ...artifacts.listColumnMap,
      ...patch.listColumnMap,
    },
  };
}

/** Persist a thread-state patch through the Chat SDK thread interface. */
export async function persistThreadState(
  thread: Thread,
  patch: ThreadStatePatch,
): Promise<void> {
  const payload = buildThreadStatePayload(patch);
  if (Object.keys(payload).length === 0) {
    return;
  }
  await thread.setState(payload);
}

/** Load the persisted state payload for a thread without requiring a Chat singleton. */
export async function getPersistedThreadState(
  threadId: string,
): Promise<Record<string, unknown>> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  return (
    (await stateAdapter.get<Record<string, unknown>>(
      threadStateKey(threadId),
    )) ?? {}
  );
}

/** Persist a thread-state patch by thread id without constructing a Chat thread. */
export async function persistThreadStateById(
  threadId: string,
  patch: ThreadStatePatch,
): Promise<void> {
  const payload = buildThreadStatePayload(patch);
  if (Object.keys(payload).length === 0) {
    return;
  }

  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const key = threadStateKey(threadId);
  const existing = (await stateAdapter.get<Record<string, unknown>>(key)) ?? {};
  await stateAdapter.set(key, { ...existing, ...payload }, THREAD_STATE_TTL_MS);
}

export function getChannelConfigurationService(
  thread: Thread,
): ChannelConfigurationService {
  const channel = thread.channel;
  return createChannelConfigurationService({
    load: async () => channel.state,
    save: async (state) => {
      await channel.setState({
        configuration: state,
      });
    },
  });
}
