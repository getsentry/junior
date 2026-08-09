import type { Thread } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { toOptionalString } from "@/chat/coerce";
import { createDurableDestinationConfigurationService } from "@/chat/configuration/sql";
import type { DestinationConfigurationService } from "@/chat/configuration/types";
import { getDb } from "@/chat/db";
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

/** Load legacy Redis-backed channel state during the SQL cutover. */
async function getLegacyChannelState(
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

/**
 * Resolve durable destination configuration.
 *
 * Slack still reads the old channel-id Redis bag once during cutover.
 */
export function getDestinationConfigurationService(
  destination: Destination,
): DestinationConfigurationService {
  return createDurableDestinationConfigurationService({
    destination,
    db: getDb(),
    loadLegacy: async () => {
      if (destination.platform !== "slack") {
        return null;
      }
      return await getLegacyChannelState(destination.channelId);
    },
  });
}
