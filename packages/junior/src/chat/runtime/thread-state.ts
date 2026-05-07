import { THREAD_STATE_TTL_MS, type Thread } from "chat";
import { toOptionalString } from "@/chat/coerce";
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

export interface PersistedSandboxState {
  sandboxDependencyProfileHash?: string;
  sandboxId?: string;
}

function threadStateKey(threadId: string): string {
  return `thread-state:${threadId}`;
}

function channelStateKey(channelId: string): string {
  return `channel-state:${channelId}`;
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
  if (patch.sandboxId !== undefined) {
    payload.app_sandbox_id = patch.sandboxId;
  }
  if (patch.sandboxDependencyProfileHash !== undefined) {
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

/** Extract persisted sandbox metadata from thread state payload. */
export function getPersistedSandboxState(
  state: Record<string, unknown>,
): PersistedSandboxState {
  return {
    sandboxId: toOptionalString(state.app_sandbox_id),
    sandboxDependencyProfileHash: toOptionalString(
      state.app_sandbox_dependency_profile_hash,
    ),
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

/** Load the persisted state payload for a channel without constructing a Chat channel. */
export async function getPersistedChannelState(
  channelId: string,
): Promise<Record<string, unknown>> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  return (
    (await stateAdapter.get<Record<string, unknown>>(
      channelStateKey(channelId),
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

/** Resolve a channel configuration service by channel id without a Chat thread. */
export function getChannelConfigurationServiceById(
  channelId: string,
): ChannelConfigurationService {
  return createChannelConfigurationService({
    load: async () => await getPersistedChannelState(channelId),
    save: async (state) => {
      const stateAdapter = getStateAdapter();
      await stateAdapter.connect();
      const key = channelStateKey(channelId);
      const existing =
        (await stateAdapter.get<Record<string, unknown>>(key)) ?? {};
      await stateAdapter.set(
        key,
        { ...existing, configuration: state },
        THREAD_STATE_TTL_MS,
      );
    },
  });
}
