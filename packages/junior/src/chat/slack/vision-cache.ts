import * as z from "zod";
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

// The cache is disposable: drop bad fields and entries instead of failing.
const visionCacheSchema = z.object({
  schemaVersion: z.literal(VISION_CACHE_SCHEMA_VERSION),
  backfillCompletedAtMs: z.number().optional().catch(undefined),
  byFileId: z.record(z.string(), z.unknown()).catch({}),
});

const visionSummarySchema = z.object({
  summary: z.string().refine((summary) => summary.trim() !== ""),
  analyzedAtMs: z.number(),
});

function coerceVisionCache(value: unknown): ConversationVisionState {
  const parsed = visionCacheSchema.safeParse(value);
  if (!parsed.success) {
    return { byFileId: {} };
  }

  const byFileId: Record<string, ConversationVisionSummary> = {};
  for (const [fileId, rawSummary] of Object.entries(parsed.data.byFileId)) {
    if (!fileId.trim()) continue;
    const summary = visionSummarySchema.safeParse(rawSummary);
    if (summary.success) byFileId[fileId] = summary.data;
  }

  return {
    backfillCompletedAtMs: parsed.data.backfillCompletedAtMs,
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
