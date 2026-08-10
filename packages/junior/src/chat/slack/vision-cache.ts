import { isRecord, toOptionalNumber, toOptionalString } from "@/chat/coerce";
import { getStateAdapter } from "@/chat/state/adapter";
import type {
  ConversationVisionState,
  ConversationVisionSummary,
} from "@/chat/state/conversation";

const VISION_CACHE_SCHEMA_VERSION = 1;
const VISION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function visionCacheKey(conversationId: string): string {
  return `vision-cache:v${VISION_CACHE_SCHEMA_VERSION}:${conversationId}`;
}

function coerceVisionCache(value: unknown): ConversationVisionState {
  if (!isRecord(value) || value.schemaVersion !== VISION_CACHE_SCHEMA_VERSION) {
    return { byFileId: {} };
  }

  const rawByFileId = isRecord(value.byFileId) ? value.byFileId : {};
  const byFileId: Record<string, ConversationVisionSummary> = {};
  for (const [fileId, rawSummary] of Object.entries(rawByFileId)) {
    if (!fileId.trim() || !isRecord(rawSummary)) continue;
    const summary = toOptionalString(rawSummary.summary);
    const analyzedAtMs = toOptionalNumber(rawSummary.analyzedAtMs);
    if (!summary || analyzedAtMs === undefined) continue;
    byFileId[fileId] = { summary, analyzedAtMs };
  }

  return {
    backfillCompletedAtMs: toOptionalNumber(value.backfillCompletedAtMs),
    byFileId,
  };
}

/** Load the disposable image-analysis cache for one conversation. */
export async function loadConversationVisionCache(
  conversationId: string,
): Promise<ConversationVisionState> {
  const state = getStateAdapter();
  await state.connect();
  return coerceVisionCache(await state.get(visionCacheKey(conversationId)));
}

/** Replace the disposable image-analysis cache with a bounded snapshot. */
export async function persistConversationVisionCache(
  conversationId: string,
  vision: ConversationVisionState,
): Promise<void> {
  const state = getStateAdapter();
  await state.connect();
  await state.set(
    visionCacheKey(conversationId),
    {
      schemaVersion: VISION_CACHE_SCHEMA_VERSION,
      backfillCompletedAtMs: vision.backfillCompletedAtMs,
      byFileId: vision.byFileId,
    },
    VISION_CACHE_TTL_MS,
  );
}
