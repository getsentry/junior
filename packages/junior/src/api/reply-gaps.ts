import {
  GAP_SEGMENTS,
  gapHistogramReport,
  MIN_GAP_SAMPLES,
} from "@/chat/cache-warming/model";
import { segmentGapsKey } from "@/chat/cache-warming/warmup";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  replyGapSegmentsReportSchema,
  type ReplyGapSegmentsReport,
} from "./schema/reply-gaps";

/**
 * Read the gap list that the cache warming planner reads for each segment.
 * The lists hold only gap lengths, so the report names no person or
 * Conversation.
 */
export async function readReplyGapSegments(): Promise<ReplyGapSegmentsReport> {
  const state = getStateAdapter();
  await state.connect();
  const segments = await Promise.all(
    GAP_SEGMENTS.map(async (segment) => ({
      histogram: gapHistogramReport(
        await state.getList<number>(segmentGapsKey(segment)),
      ),
      segment,
    })),
  );
  return replyGapSegmentsReportSchema.parse({
    generatedAt: new Date().toISOString(),
    minSamples: MIN_GAP_SAMPLES,
    segments,
  });
}
