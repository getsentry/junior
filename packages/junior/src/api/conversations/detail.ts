import { canExposeConversationPayload } from "@/chat/conversation-privacy";
import {
  conversationEventSchema,
  type ConversationEvent,
} from "@/chat/conversations/history";
import { readConversationEventPrivacySnapshot } from "@/chat/conversations/sql/privacy";
import type { Conversation } from "@/chat/conversations/store";
import { getSqlExecutor } from "@/chat/db";
import { buildSentryConversationUrl } from "@/chat/sentry-links";
import { projectConversationModelUsage } from "@/chat/pi/conversation-events";
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
  const modelUsage = projectConversationModelUsage(events);
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

  const snapshot = await readConversationEventPrivacySnapshot(
    getSqlExecutor(),
    {
      conversationId,
      eventTypes: conversationReportSourceEventTypes,
    },
  );
  if (!snapshot) return undefined;
  const events = snapshot.events.map((row) =>
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
    snapshot.visibility === "public" || snapshot.visibility === "private"
      ? snapshot.visibility
      : undefined;
  return projectConversationDetail({
    ...record,
    effectiveVisibility,
    events,
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
