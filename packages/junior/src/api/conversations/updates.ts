import { getDb, getSqlExecutor } from "@/chat/db";
import { readConversationAccessFromSql } from "./access";
import { decodeConversationCursor, encodeConversationCursor } from "./cursor";
import {
  readConversationEventHighWaterSeq,
  readConversationEventUpdates,
} from "./event-page";
import { readConversationRecordFromSql } from "./list";
import {
  conversationEventHistory,
  conversationSummaryFromStoredConversation,
} from "./projection";
import { readRootConversationMetricsFromSql } from "./usage";
import { parseParams, parseQuery, throwApiError } from "../http";
import { defineApiRoute } from "../route";
import {
  conversationParamsSchema,
  conversationUpdatesQuerySchema,
  conversationUpdatesReportSchema,
  type ConversationUpdatesReport,
} from "../schema/conversation";

/** Read canonical events after a signed cursor and refresh mutable summary fields. */
export async function readConversationUpdates(
  conversationId: string,
  cursorValue: string,
  options: {
    limit?: number;
    verifiedViewerEmail?: string;
  } = {},
): Promise<ConversationUpdatesReport | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;

  const cursor = decodeConversationCursor({
    conversationId,
    cursor: cursorValue,
    kind: "after",
  });
  if (!cursor) throwApiError(400, "Invalid conversation cursor.");

  const includeDescendantMetrics = record.rootConversationId === conversationId;
  const [accessByConversation, highWaterSeq, metricsByRoot] = await Promise.all(
    [
      readConversationAccessFromSql(
        getDb(),
        [conversationId],
        options.verifiedViewerEmail,
      ),
      readConversationEventHighWaterSeq(getSqlExecutor(), conversationId),
      readRootConversationMetricsFromSql(
        getDb(),
        includeDescendantMetrics ? [conversationId] : [],
      ),
    ],
  );
  const access = accessByConversation.get(conversationId);
  const canExposePayload = access?.canViewPrivateContent ?? false;
  const transcriptPurgedAtMs = record.conversation.transcriptPurgedAtMs;
  const page =
    transcriptPurgedAtMs === undefined
      ? await readConversationEventUpdates(getSqlExecutor(), {
          afterSeq: cursor.seq,
          canExposePayload,
          conversationId,
          limit: options.limit ?? 500,
          throughSeq: highWaterSeq,
        })
      : {
          cursorSeq: highWaterSeq,
          events: [],
          hasMore: false,
        };
  const metrics = metricsByRoot.get(conversationId);

  return conversationUpdatesReportSchema.parse({
    ...conversationSummaryFromStoredConversation({
      access,
      conversation: record.conversation,
      durationMs: metrics?.durationMs ?? record.durationMs,
      ...(record.locationId ? { locationId: record.locationId } : {}),
      usage: metrics?.usage ?? record.usage ?? undefined,
    }),
    events: page.events,
    eventCursor: encodeConversationCursor({
      conversationId,
      kind: "after",
      seq: page.cursorSeq,
    }),
    eventHistory: conversationEventHistory({
      canExposePayload,
      ...(transcriptPurgedAtMs === undefined ? {} : { transcriptPurgedAtMs }),
    }),
    generatedAt: new Date().toISOString(),
    hasMore: page.hasMore,
  });
}

export default defineApiRoute({
  method: "get",
  path: "/:conversationId/updates",
  responseSchema: conversationUpdatesReportSchema,
  handler: async (c) => {
    const { conversationId } = parseParams(
      conversationParamsSchema,
      c.req.param(),
    );
    const { cursor, limit } = parseQuery(
      conversationUpdatesQuerySchema,
      c.req.query(),
    );
    const verifiedViewerEmail = c.get("verifiedViewerEmail");
    const report = await readConversationUpdates(conversationId, cursor, {
      limit,
      ...(verifiedViewerEmail ? { verifiedViewerEmail } : {}),
    });
    if (!report) throwApiError(404, "Conversation not found.");
    return report;
  },
});
