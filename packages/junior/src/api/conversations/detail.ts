import { and, asc, eq, inArray } from "drizzle-orm";
import { canExposeConversationPayload } from "@/chat/conversation-privacy";
import {
  conversationEventSchema,
  type ConversationEvent,
} from "@/chat/conversations/history";
import { readRootVisibility } from "@/chat/conversations/sql/privacy";
import type { Conversation } from "@/chat/conversations/store";
import { getDb, getSqlExecutor } from "@/chat/db";
import { buildSentryConversationUrl } from "@/chat/sentry-links";
import {
  conversationReportSourceEventTypes,
  projectConversationReportEvents,
} from "./events";
import { readConversationRecordFromSql } from "./list";
import { conversationSummaryFromStoredConversation } from "./projection";
import { conversationDetailReportSchema } from "./schema";
import type { ConversationDetailReport } from "./schema";
import { juniorConversationEvents } from "@/db/schema";
import type { ApiRoute } from "../route";
import { parseParams } from "../http";
import { conversationParamsSchema } from "../schema";

function projectConversationDetail(args: {
  conversation: Conversation;
  durationMs: number;
  effectiveVisibility?: Conversation["visibility"];
  events: ConversationEvent[];
  privacyConversationId?: string;
  locationId?: string;
  usage: ConversationDetailReport["cumulativeUsage"];
}): ConversationDetailReport {
  const { conversation } = args;
  const conversationId = conversation.conversationId;
  const transcriptPurgedAtMs = conversation.transcriptPurgedAtMs;
  const { visibility: _storedVisibility, ...conversationWithoutVisibility } =
    conversation;
  const authorizedConversation: Conversation = {
    ...conversationWithoutVisibility,
    ...(args.effectiveVisibility
      ? { visibility: args.effectiveVisibility }
      : {}),
  };
  const canExposePayload = canExposeConversationPayload({
    conversationId: args.privacyConversationId ?? conversationId,
    visibility: args.effectiveVisibility,
  });
  const events = transcriptPurgedAtMs === undefined ? args.events : [];
  const sentryConversationUrl = buildSentryConversationUrl(conversationId);

  return {
    ...conversationSummaryFromStoredConversation({
      conversation: authorizedConversation,
      durationMs: args.durationMs,
      ...(args.locationId ? { locationId: args.locationId } : {}),
      usage: args.usage,
    }),
    events: projectConversationReportEvents({ canExposePayload, events }),
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
): Promise<ConversationDetailReport | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;

  const { rootConversationId, visibility } = await readRootVisibility(
    getSqlExecutor(),
    conversationId,
  );
  const rows = await getDb()
    .select()
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        inArray(
          juniorConversationEvents.type,
          conversationReportSourceEventTypes,
        ),
      ),
    )
    .orderBy(asc(juniorConversationEvents.seq));
  const events = rows.map((row) =>
    conversationEventSchema.parse({
      schemaVersion: row.schemaVersion,
      seq: row.seq,
      contextEpoch: row.contextEpoch,
      ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
      createdAtMs: row.createdAt.getTime(),
      data: { ...row.payload, type: row.type },
    }),
  );
  const effectiveVisibility =
    visibility === "public" || visibility === "private"
      ? visibility
      : undefined;
  return projectConversationDetail({
    ...record,
    effectiveVisibility,
    events,
    privacyConversationId: rootConversationId,
    usage: record.usage ?? undefined,
  });
}

/** Load one conversation from its canonical event history. */
export async function readConversationDetail(
  conversationId: string,
): Promise<ConversationDetailReport | undefined> {
  const report = await readConversationDetailFromSql(conversationId);
  return report ? conversationDetailReportSchema.parse(report) : undefined;
}

/** Serve one conversation detail endpoint. */
export default {
  method: "get",
  path: "/:conversationId",
  handler: async (c) => {
    const { conversationId } = parseParams(
      conversationParamsSchema,
      c.req.param(),
    );
    const report = await readConversationDetail(conversationId);
    return report
      ? Response.json(report)
      : Response.json({ error: "Conversation not found." }, { status: 404 });
  },
} satisfies ApiRoute;
