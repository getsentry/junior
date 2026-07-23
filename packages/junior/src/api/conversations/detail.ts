import { and, asc, eq, getTableColumns, gt, lt, sql } from "drizzle-orm";
import {
  decodeStoredConversationEvent,
  type ConversationEvent,
} from "@/chat/conversations/history";
import type { Conversation } from "@/chat/conversations/store";
import { getDb, getSqlExecutor } from "@/chat/db";
import { buildSentryConversationUrl } from "@/chat/sentry-links";
import { readConversationModelUsageFromSql } from "@/chat/pi/sql-model-usage";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";
import { projectConversationReportEventPage } from "./events";
import { decodeConversationCursor, encodeConversationCursor } from "./cursor";
import { readConversationRecordFromSql } from "./list";
import { conversationSummaryFromStoredConversation } from "./projection";
import {
  readConversationAccessFromSql,
  type ConversationAccess,
} from "./access";
import { readRootConversationMetricsFromSql } from "./usage";
import {
  conversationDetailQuerySchema,
  conversationDetailReportSchema,
} from "../schema/conversation";
import type { ConversationDetailReport } from "../schema/conversation";
import { defineApiRoute } from "../route";
import { parseParams, parseQuery, throwApiError } from "../http";
import { conversationParamsSchema } from "../schema/conversation";

const conversationEventColumns = getTableColumns(juniorConversationEvents);

export async function readConversationReportEventRows(
  executor: JuniorSqlDatabase,
  conversationId: string,
  bounds: { afterSeq?: number; beforeSeq?: number } = {},
) {
  return executor
    .db()
    .select({
      ...conversationEventColumns,
      // Replacement history is model context, never dashboard report data.
      payload: sql<Record<string, unknown>>`case
        when ${juniorConversationEvents.type} in ('compaction', 'handoff')
        then jsonb_set(
          ${juniorConversationEvents.payload},
          '{replacementHistory}',
          '[]'::jsonb
        )
        else ${juniorConversationEvents.payload}
      end`,
    })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        bounds.afterSeq === undefined
          ? undefined
          : gt(juniorConversationEvents.seq, bounds.afterSeq),
        bounds.beforeSeq === undefined
          ? undefined
          : lt(juniorConversationEvents.seq, bounds.beforeSeq),
      ),
    )
    .orderBy(asc(juniorConversationEvents.seq));
}

function projectConversationDetail(args: {
  access?: ConversationAccess;
  conversation: Conversation;
  durationMs: number;
  events: ConversationEvent[];
  locationId?: string;
  modelUsage: NonNullable<ConversationDetailReport["modelUsage"]>;
  usage: ConversationDetailReport["cumulativeUsage"];
  limit: number;
}): ConversationDetailReport {
  const { conversation } = args;
  const conversationId = conversation.conversationId;
  const transcriptPurgedAtMs = conversation.transcriptPurgedAtMs;
  const canExposePayload = args.access?.canViewPrivateContent ?? false;
  const canonicalEvents = transcriptPurgedAtMs === undefined ? args.events : [];
  const modelUsage = transcriptPurgedAtMs === undefined ? args.modelUsage : [];
  const projected = projectConversationReportEventPage({
    canExposePayload,
    events: canonicalEvents,
  });
  const events = projected.events.slice(-args.limit);
  const maxSeq = canonicalEvents.at(-1)?.seq ?? 0;
  const firstSeq = events[0]?.seq;
  const sentryConversationUrl = buildSentryConversationUrl(conversationId);

  return {
    ...conversationSummaryFromStoredConversation({
      access: args.access,
      conversation,
      durationMs: args.durationMs,
      ...(args.locationId ? { locationId: args.locationId } : {}),
      usage: args.usage,
    }),
    events,
    eventCursor: encodeConversationCursor({
      conversationId,
      kind: "after",
      openSubagents: projected.openSubagents,
      seq: maxSeq,
    }),
    ...(firstSeq !== undefined && projected.events.length > events.length
      ? {
          previousCursor: encodeConversationCursor({
            conversationId,
            kind: "before",
            openSubagents: [],
            seq: firstSeq,
          }),
        }
      : {}),
    ...(modelUsage.length > 0 ? { modelUsage } : {}),
    eventHistory:
      transcriptPurgedAtMs !== undefined
        ? {
            status: "expired",
            expiredAt: new Date(transcriptPurgedAtMs).toISOString(),
          }
        : canExposePayload
          ? { status: "available" }
          : {
              status: "redacted",
              reason: "non_public_conversation",
            },
    generatedAt: new Date().toISOString(),
    ...(sentryConversationUrl ? { sentryConversationUrl } : {}),
  };
}

async function readConversationDetailFromSql(
  conversationId: string,
  options: {
    before?: string;
    limit: number;
    verifiedViewerEmail?: string;
  },
): Promise<ConversationDetailReport | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;

  const executor = getSqlExecutor();
  const before = options.before
    ? decodeConversationCursor({
        conversationId,
        cursor: options.before,
        kind: "before",
      })
    : undefined;
  if (options.before && !before)
    throwApiError(400, "Invalid conversation cursor.");
  const includeDescendantMetrics = record.rootConversationId === conversationId;
  const [accessByConversation, eventRows, modelUsage, metricsByRoot] =
    await Promise.all([
      readConversationAccessFromSql(
        getDb(),
        [conversationId],
        options.verifiedViewerEmail,
      ),
      readConversationReportEventRows(
        executor,
        conversationId,
        before ? { beforeSeq: before.seq } : {},
      ),
      record.conversation.transcriptPurgedAtMs === undefined
        ? readConversationModelUsageFromSql(executor, {
            conversationId,
            includeDescendants: includeDescendantMetrics,
          })
        : Promise.resolve([]),
      readRootConversationMetricsFromSql(
        getDb(),
        includeDescendantMetrics ? [conversationId] : [],
      ),
    ]);
  const events = eventRows.map((row) =>
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
  const metrics = metricsByRoot.get(conversationId);
  return projectConversationDetail({
    ...record,
    access: accessByConversation.get(conversationId),
    durationMs: metrics?.durationMs ?? record.durationMs,
    events,
    modelUsage,
    usage: metrics?.usage ?? record.usage ?? undefined,
    limit: options.limit,
  });
}

/** Load one conversation from its canonical event history. */
export async function readConversationDetail(
  conversationId: string,
  options: {
    before?: string;
    limit?: number;
    verifiedViewerEmail?: string;
  } = {},
): Promise<ConversationDetailReport | undefined> {
  const report = await readConversationDetailFromSql(conversationId, {
    ...options,
    limit: options.limit ?? 500,
  });
  return report ? conversationDetailReportSchema.parse(report) : undefined;
}

/** Serve one conversation detail endpoint. */
export default defineApiRoute({
  method: "get",
  path: "/:conversationId",
  responseSchema: conversationDetailReportSchema,
  handler: async (c) => {
    const { conversationId } = parseParams(
      conversationParamsSchema,
      c.req.param(),
    );
    const query = parseQuery(conversationDetailQuerySchema, c.req.query());
    const verifiedViewerEmail = c.get("verifiedViewerEmail");
    const report = await readConversationDetail(conversationId, {
      ...query,
      ...(verifiedViewerEmail ? { verifiedViewerEmail } : {}),
    });
    if (!report) throwApiError(404, "Conversation not found.");
    return report;
  },
});
