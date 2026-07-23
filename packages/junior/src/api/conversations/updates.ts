import { decodeStoredConversationEvent } from "@/chat/conversations/history";
import { getDb, getSqlExecutor } from "@/chat/db";
import { readConversationAccessFromSql } from "./access";
import { decodeConversationCursor, encodeConversationCursor } from "./cursor";
import { readConversationReportEventRows } from "./detail";
import { projectConversationReportEventPage } from "./events";
import { readConversationRecordFromSql } from "./list";
import { conversationSummaryFromStoredConversation } from "./projection";
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
  options: { verifiedViewerEmail?: string } = {},
): Promise<ConversationUpdatesReport | undefined> {
  const cursor = decodeConversationCursor({
    conversationId,
    cursor: cursorValue,
    kind: "after",
  });
  if (!cursor) throwApiError(400, "Invalid conversation cursor.");

  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;
  const includeDescendantMetrics = record.rootConversationId === conversationId;
  const [accessByConversation, rows, metricsByRoot] = await Promise.all([
    readConversationAccessFromSql(
      getDb(),
      [conversationId],
      options.verifiedViewerEmail,
    ),
    readConversationReportEventRows(getSqlExecutor(), conversationId, {
      afterSeq: cursor.seq,
    }),
    readRootConversationMetricsFromSql(
      getDb(),
      includeDescendantMetrics ? [conversationId] : [],
    ),
  ]);
  const canonicalEvents = rows.map((row) =>
    decodeStoredConversationEvent({
      schemaVersion: row.schemaVersion,
      seq: row.seq,
      historyVersion: row.historyVersion,
      ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
      createdAtMs: row.createdAt.getTime(),
      type: row.type,
      payload: row.payload,
    }),
  );
  const access = accessByConversation.get(conversationId);
  const canExposePayload = access?.canViewPrivateContent ?? false;
  const projected = projectConversationReportEventPage({
    canExposePayload,
    events:
      record.conversation.transcriptPurgedAtMs === undefined
        ? canonicalEvents
        : [],
    openSubagents: cursor.openSubagents,
  });
  const maxSeq = canonicalEvents.at(-1)?.seq ?? cursor.seq;
  const metrics = metricsByRoot.get(conversationId);
  const transcriptPurgedAtMs = record.conversation.transcriptPurgedAtMs;

  return conversationUpdatesReportSchema.parse({
    ...conversationSummaryFromStoredConversation({
      access,
      conversation: record.conversation,
      durationMs: metrics?.durationMs ?? record.durationMs,
      ...(record.locationId ? { locationId: record.locationId } : {}),
      usage: metrics?.usage ?? record.usage ?? undefined,
    }),
    events: projected.events,
    eventCursor: encodeConversationCursor({
      conversationId,
      kind: "after",
      openSubagents: projected.openSubagents,
      seq: maxSeq,
    }),
    eventHistory:
      transcriptPurgedAtMs !== undefined
        ? {
            status: "expired",
            expiredAt: new Date(transcriptPurgedAtMs).toISOString(),
          }
        : canExposePayload
          ? { status: "available" }
          : { status: "redacted", reason: "non_public_conversation" },
    generatedAt: new Date().toISOString(),
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
    const { cursor } = parseQuery(
      conversationUpdatesQuerySchema,
      c.req.query(),
    );
    const verifiedViewerEmail = c.get("verifiedViewerEmail");
    const report = await readConversationUpdates(
      conversationId,
      cursor,
      verifiedViewerEmail ? { verifiedViewerEmail } : {},
    );
    if (!report) throwApiError(404, "Conversation not found.");
    return report;
  },
});
