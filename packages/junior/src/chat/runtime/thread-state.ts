import type { Thread } from "chat";
import { toOptionalString } from "@/chat/coerce";
import { createChannelConfigurationService } from "@/chat/configuration/service";
import {
  loadChannelConfiguration,
  saveChannelConfiguration,
} from "@/chat/configuration/store";
import type {
  ChannelConfigState,
  ChannelConfigurationService,
} from "@/chat/configuration/types";
import { buildConversationStatePatch } from "@/chat/state/conversation";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { persistConversationMessages } from "@/chat/conversations/messages";
import {
  buildArtifactStatePatch,
  type ThreadArtifactsState,
} from "@/chat/state/artifacts";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import type { SandboxRef } from "@/chat/sandbox/ref";
import { logWarn } from "@/chat/logging";

export interface ThreadStatePatch {
  artifacts?: ThreadArtifactsState;
  conversation?: ThreadConversationState;
  sandboxRef?: SandboxRef | null;
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
  if (patch.sandboxRef !== undefined) {
    payload.app_sandbox_id = patch.sandboxRef?.id ?? "";
    payload.app_sandbox_dependency_profile_hash =
      patch.sandboxRef?.profileHash ?? "";
  }
  return payload;
}

/**
 * Merge a payload into thread scratch with Junior's TTL.
 *
 * Chat SDK state writes hardcode a 30-day TTL. This boundary owns Junior's
 * shorter retention policy for the same scratch keys.
 */
async function mergePersistedState(
  key: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(payload).length === 0) {
    return;
  }

  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const existing = (await stateAdapter.get<Record<string, unknown>>(key)) ?? {};
  await stateAdapter.set(
    key,
    { ...existing, ...payload },
    JUNIOR_THREAD_STATE_TTL_MS,
  );
}

/** Merge an artifact patch while preserving per-list column mappings. */
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
): SandboxRef | undefined {
  const id = toOptionalString(state.app_sandbox_id);
  if (!id) {
    return undefined;
  }
  const profileHash = toOptionalString(
    state.app_sandbox_dependency_profile_hash,
  );
  return {
    id,
    ...(profileHash ? { profileHash } : {}),
  };
}

/** Persist a thread-state patch for a Chat thread handle. */
export async function persistThreadState(
  thread: Thread,
  patch: ThreadStatePatch,
): Promise<void> {
  // The visible transcript is durable in SQL, keyed by the conversation id —
  // which is the thread's own id here (its thread-state key), the same way
  // persistThreadStateById treats its thread id. Sync it at this persist
  // boundary so scratch and transcript stay symmetric with the id-based
  // boundary and never diverge.
  if (patch.conversation) {
    await persistConversationMessages({
      conversation: patch.conversation,
      conversationId:
        toOptionalString(thread.id) ??
        toOptionalString((thread as { runId?: unknown }).runId),
    });
  }

  await persistThreadRuntimeState(thread, patch);
}

/** Persist only the Redis-backed runtime scratch in a thread-state patch. */
export async function persistThreadRuntimeState(
  thread: Thread,
  patch: ThreadStatePatch,
): Promise<void> {
  const threadId =
    toOptionalString(thread.id) ??
    toOptionalString((thread as { runId?: unknown }).runId);
  if (!threadId) {
    throw new Error("thread id is required to persist runtime scratch");
  }
  await mergePersistedState(
    threadStateKey(threadId),
    buildThreadStatePayload(patch),
  );
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

/**
 * Load legacy Redis channel scratch.
 *
 * Channel configuration no longer lives here. Callers that still need the
 * scratch bag for migration or harness seeding can use this helper.
 */
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
  // The visible transcript is durable in SQL, keyed by the conversation id
  // (which is the thread id here); keep it in sync at this id-based persist
  // boundary so scratch and transcript never diverge.
  if (patch.conversation) {
    await persistConversationMessages({
      conversation: patch.conversation,
      conversationId: threadId,
    });
  }

  await mergePersistedState(
    threadStateKey(threadId),
    buildThreadStatePayload(patch),
  );
}

/**
 * One-shot adopt of legacy Redis channel configuration into SQL.
 *
 * SQL is the authority after cutover. If SQL is empty and Redis still has a
 * configuration bag, copy it once and drop the Redis key so the 7-day TTL cannot
 * keep a second source of truth alive.
 */
async function adoptLegacyChannelConfiguration(
  channelId: string,
): Promise<ChannelConfigState | null> {
  const existing = await loadChannelConfiguration(channelId);
  if (existing) {
    return existing;
  }

  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const legacyKey = channelStateKey(channelId);
  const legacy = await stateAdapter.get<Record<string, unknown>>(legacyKey);
  if (!legacy || typeof legacy !== "object") {
    return null;
  }

  const configuration = legacy.configuration;
  if (!configuration || typeof configuration !== "object") {
    return null;
  }

  // The service coercer owns entry validation; store the bag as-is under the
  // shared ChannelConfigState envelope.
  const state: ChannelConfigState = {
    schemaVersion: 1,
    entries:
      "entries" in configuration &&
      configuration.entries &&
      typeof configuration.entries === "object" &&
      !Array.isArray(configuration.entries)
        ? (configuration.entries as ChannelConfigState["entries"])
        : {},
  };

  try {
    await saveChannelConfiguration(channelId, state);
  } catch (error) {
    logWarn("channel_configuration.legacy_adopt_failed", {
      "app.channel.id": channelId,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  try {
    // Drop only the configuration key from the scratch bag. Leave unrelated
    // channel scratch alone if anything else still lives there.
    const { configuration: _configuration, ...remainder } = legacy;
    if (Object.keys(remainder).length === 0) {
      await stateAdapter.delete(legacyKey);
    } else {
      await stateAdapter.set(legacyKey, remainder, JUNIOR_THREAD_STATE_TTL_MS);
    }
  } catch (error) {
    logWarn("channel_configuration.legacy_cleanup_failed", {
      "app.channel.id": channelId,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }

  return state;
}

function createSqlChannelConfigurationService(
  channelId: string,
): ChannelConfigurationService {
  return createChannelConfigurationService({
    load: async () => {
      const adopted = await adoptLegacyChannelConfiguration(channelId);
      if (adopted) {
        return { configuration: adopted };
      }
      const loaded = await loadChannelConfiguration(channelId);
      return loaded ? { configuration: loaded } : null;
    },
    save: async (state) => {
      await saveChannelConfiguration(channelId, state);
    },
  });
}

/** Resolve channel configuration from a Chat thread through durable SQL storage. */
export function getChannelConfigurationService(
  thread: Thread,
): ChannelConfigurationService {
  const channel = thread.channel;
  const channelId =
    toOptionalString(thread.channelId) ?? toOptionalString(channel.id);
  if (!channelId) {
    throw new Error("channel id is required to load channel configuration");
  }
  return createSqlChannelConfigurationService(channelId);
}

/** Resolve channel configuration by channel id through durable SQL storage. */
export function getChannelConfigurationServiceById(
  channelId: string,
): ChannelConfigurationService {
  return createSqlChannelConfigurationService(channelId);
}
