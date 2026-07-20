import { canExposeConversationPayload } from "@/chat/conversation-privacy";
import {
  decodeStoredConversationEvent,
  type ConversationEvent,
} from "@/chat/conversations/history";
import { readConversationEventPrivacySnapshot } from "@/chat/conversations/sql/privacy";
import type { Conversation } from "@/chat/conversations/store";
import { getSqlExecutor } from "@/chat/db";
import { buildSentryConversationUrl } from "@/chat/sentry-links";
import { readConversationModelUsageFromSql } from "@/chat/pi/sql-model-usage";
import {
  conversationReportSourceEventTypes,
  projectConversationReportEvents,
} from "./events";
import { readConversationRecordFromSql } from "./list";
import { conversationSummaryFromStoredConversation } from "./projection";
import { conversationDetailReportSchema } from "./schema";
import type { ConversationDetailReport } from "./schema";
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
  modelUsage: NonNullable<ConversationDetailReport["modelUsage"]>;
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
  const modelUsage = transcriptPurgedAtMs === undefined ? args.modelUsage : [];
  const sentryConversationUrl = buildSentryConversationUrl(conversationId);

  return {
    ...conversationSummaryFromStoredConversation({
      conversation: authorizedConversation,
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
): Promise<ConversationDetailReport | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;

  const executor = getSqlExecutor();
  const [snapshot, modelUsage] = await Promise.all([
    readConversationEventPrivacySnapshot(executor, {
      conversationId,
      eventTypes: conversationReportSourceEventTypes,
    }),
    record.conversation.transcriptPurgedAtMs === undefined
      ? readConversationModelUsageFromSql(executor, conversationId)
      : Promise.resolve([]),
  ]);
  if (!snapshot) return undefined;
  const events = snapshot.events.map((row) =>
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
  const effectiveVisibility =
    snapshot.visibility === "public" || snapshot.visibility === "private"
      ? snapshot.visibility
      : undefined;
  return projectConversationDetail({
    ...record,
    effectiveVisibility,
    events,
    modelUsage,
    privacyConversationId: snapshot.rootConversationId,
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
