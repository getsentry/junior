import type { Thread } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { toOptionalString } from "@/chat/coerce";
import { createDurableLocationConfigurationService } from "@/chat/configuration/sql";
import type { LocationConfigurationService } from "@/chat/configuration/types";
import { getDb } from "@/chat/db";
import { buildConversationStatePatch } from "@/chat/state/conversation";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { persistConversationMessages } from "@/chat/conversations/messages";
import {
  buildArtifactStatePatch,
  type ThreadArtifactsState,
} from "@/chat/state/artifacts";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  JUNIOR_PROCESSING_STATE_TTL_MS,
  JUNIOR_SANDBOX_REF_TTL_MS,
  JUNIOR_TERMINAL_PROCESSING_STATE_TTL_MS,
  JUNIOR_THREAD_STATE_TTL_MS,
} from "@/chat/state/ttl";
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

function processingStateKey(threadId: string): string {
  return `thread-processing-state:${threadId}`;
}

function sandboxRefKey(threadId: string): string {
  return `thread-sandbox-ref:${threadId}`;
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
    // TODO(v0.147.0): Remove the legacy app_sandbox_* field masks.
    payload.app_sandbox_id = "";
    payload.app_sandbox_dependency_profile_hash = "";
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

/** Store active processing for 24h and terminal rollout markers for 1h. */
async function persistProcessingState(
  threadId: string,
  processing: ThreadConversationState["processing"],
): Promise<void> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const terminal = Object.values(processing).every(
    (value) => value === undefined,
  );
  // TODO(v0.147.0): Delete terminal markers once legacy processing has aged out.
  await stateAdapter.set(
    processingStateKey(threadId),
    processing,
    terminal
      ? JUNIOR_TERMINAL_PROCESSING_STATE_TTL_MS
      : JUNIOR_PROCESSING_STATE_TTL_MS,
  );
}

/** Store a resumable sandbox reference only for its 30-minute lifetime. */
async function persistSandboxRef(
  threadId: string,
  sandboxRef: SandboxRef | null,
): Promise<void> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const key = sandboxRefKey(threadId);
  if (!sandboxRef) {
    await stateAdapter.delete(key);
    return;
  }
  await stateAdapter.set(key, sandboxRef, JUNIOR_SANDBOX_REF_TTL_MS);
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

/** Extract persisted sandbox metadata from a merged thread-state payload. */
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
  await persistThreadRuntimeStateById(threadId, patch);
}

/** Split one runtime patch across cache, processing, and sandbox records. */
async function persistThreadRuntimeStateById(
  threadId: string,
  patch: ThreadStatePatch,
): Promise<void> {
  await Promise.all([
    mergePersistedState(threadStateKey(threadId), buildThreadStatePayload(patch)),
    ...(patch.conversation
      ? [persistProcessingState(threadId, patch.conversation.processing)]
      : []),
    ...(patch.sandboxRef !== undefined
      ? [persistSandboxRef(threadId, patch.sandboxRef)]
      : []),
  ]);
}

/** Load cache and ephemeral state as one compatibility payload. */
export async function getPersistedThreadState(
  threadId: string,
): Promise<Record<string, unknown>> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const [threadState, processing, sandboxRef] = await Promise.all([
    stateAdapter.get<Record<string, unknown>>(threadStateKey(threadId)),
    stateAdapter.get<ThreadConversationState["processing"]>(
      processingStateKey(threadId),
    ),
    stateAdapter.get<SandboxRef>(sandboxRefKey(threadId)),
  ]);
  const state = threadState ?? {};
  // TODO(v0.147.0): Remove fallback reads of legacy processing and app_sandbox_* fields.
  const conversation =
    state.conversation && typeof state.conversation === "object"
      ? (state.conversation as Record<string, unknown>)
      : {};
  return {
    ...state,
    ...(processing
      ? { conversation: { ...conversation, processing } }
      : {}),
    ...(sandboxRef
      ? {
          app_sandbox_id: sandboxRef.id,
          app_sandbox_dependency_profile_hash: sandboxRef.profileHash ?? "",
        }
      : {}),
  };
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

  await persistThreadRuntimeStateById(threadId, patch);
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
 * Resolve durable location configuration.
 *
 * Slack still reads the old channel-id Redis bag once during cutover.
 */
export function getLocationConfigurationService(
  destination: Destination,
): LocationConfigurationService {
  if (destination.platform !== "slack") {
    throw new Error("Location configuration requires a Slack Location");
  }
  return createDurableLocationConfigurationService({
    destination,
    db: getDb(),
    loadLegacy: async () =>
      await getLegacyChannelState(destination.channelId),
  });
}
