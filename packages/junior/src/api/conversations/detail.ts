import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
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
import {
  conversationReportSourceEventTypes,
  projectConversationReportEvents,
} from "./events";
import { readConversationRecordFromSql } from "./list";
import { conversationSummaryFromStoredConversation } from "./projection";
import {
  readConversationAccessFromSql,
  type ConversationAccess,
} from "./access";
import { readRootConversationMetricsFromSql } from "./usage";
import { conversationDetailReportSchema } from "../schema/conversation";
import type { ConversationDetailReport } from "../schema/conversation";
import { defineApiRoute } from "../route";
import { parseParams, throwApiError } from "../http";
import { conversationParamsSchema } from "../schema/conversation";

const conversationEventColumns = getTableColumns(juniorConversationEvents);

async function readConversationReportEventRows(
  executor: JuniorSqlDatabase,
  conversationId: string,
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
        inArray(juniorConversationEvents.type, [
          ...conversationReportSourceEventTypes,
        ]),
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
}): ConversationDetailReport {
  const { conversation } = args;
  const conversationId = conversation.conversationId;
  const transcriptPurgedAtMs = conversation.transcriptPurgedAtMs;
  const canExposePayload = args.access?.canViewPrivateContent ?? false;
  const events = transcriptPurgedAtMs === undefined ? args.events : [];
  const modelUsage = transcriptPurgedAtMs === undefined ? args.modelUsage : [];
  const sentryConversationUrl = buildSentryConversationUrl(conversationId);

  return {
    ...conversationSummaryFromStoredConversation({
      access: args.access,
      conversation,
      durationMs: args.durationMs,
      ...(args.locationId ? { locationId: args.locationId } : {}),
      usage: args.usage,
    }),
    events: projectConversationReportEvents({ canExposePayload, events }),
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
  options: { verifiedViewerEmail?: string },
): Promise<ConversationDetailReport | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;

  const executor = getSqlExecutor();
  const includeDescendantMetrics = record.rootConversationId === conversationId;
  const [accessByConversation, eventRows, modelUsage, metricsByRoot] =
    await Promise.all([
      readConversationAccessFromSql(
        getDb(),
        [conversationId],
        options.verifiedViewerEmail,
      ),
      readConversationReportEventRows(executor, conversationId),
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
  });
}

/** Load one conversation from its canonical event history. */
export async function readConversationDetail(
  conversationId: string,
  options: { verifiedViewerEmail?: string } = {},
): Promise<ConversationDetailReport | undefined> {
  const report = await readConversationDetailFromSql(conversationId, options);
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
    const verifiedViewerEmail = c.get("verifiedViewerEmail");
    const report = await readConversationDetail(
      conversationId,
      verifiedViewerEmail ? { verifiedViewerEmail } : {},
    );
    if (!report) throwApiError(404, "Conversation not found.");
    return report;
  },
});
