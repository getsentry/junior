import { canExposeConversationPayload } from "@/chat/conversation-privacy";
import {
  decodeStoredConversationEvent,
  type ConversationEvent,
} from "@/chat/conversations/history";
import { readConversationEventPrivacySnapshot } from "@/chat/conversations/sql/privacy";
import type { Conversation } from "@/chat/conversations/store";
import { getDb, getSqlExecutor } from "@/chat/db";
import { buildSentryConversationUrl } from "@/chat/sentry-links";
import { readConversationModelUsageFromSql } from "@/chat/pi/sql-model-usage";
import {
  conversationReportSourceEventTypes,
  projectConversationReportEvents,
} from "./events";
import { readConversationRecordFromSql } from "./list";
import { conversationSummaryFromStoredConversation } from "./projection";
import { readRootConversationUsageFromSql } from "./usage";
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
  isParticipant: boolean;
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
  const canExposePayload =
    args.isParticipant ||
    canExposeConversationPayload({
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
      isParticipant: args.isParticipant,
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
  options: { authorizedUserEmail?: string },
): Promise<ConversationDetailReport | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;

  const executor = getSqlExecutor();
  const includeDescendantUsage = record.rootConversationId === conversationId;
  const [snapshot, modelUsage, usageByRoot] = await Promise.all([
    readConversationEventPrivacySnapshot(executor, {
      ...(options.authorizedUserEmail
        ? { authorizedUserEmail: options.authorizedUserEmail }
        : {}),
      conversationId,
      eventTypes: conversationReportSourceEventTypes,
    }),
    record.conversation.transcriptPurgedAtMs === undefined
      ? readConversationModelUsageFromSql(executor, {
          conversationId,
          includeDescendants: includeDescendantUsage,
        })
      : Promise.resolve([]),
    readRootConversationUsageFromSql(
      getDb(),
      includeDescendantUsage ? [conversationId] : [],
    ),
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
    ...(snapshot.rootConversationId
      ? { privacyConversationId: snapshot.rootConversationId }
      : {}),
    usage: includeDescendantUsage
      ? usageByRoot.get(conversationId)
      : (record.usage ?? undefined),
    isParticipant: snapshot.isParticipant,
  });
}

/** Load one conversation from its canonical event history. */
export async function readConversationDetail(
  conversationId: string,
  options: { authorizedUserEmail?: string } = {},
): Promise<ConversationDetailReport | undefined> {
  const report = await readConversationDetailFromSql(conversationId, options);
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
    const authorizedUserEmail = c.get("authorizedUserEmail");
    const report = await readConversationDetail(
      conversationId,
      authorizedUserEmail ? { authorizedUserEmail } : {},
    );
    return report
      ? Response.json(report)
      : Response.json({ error: "Conversation not found." }, { status: 404 });
  },
} satisfies ApiRoute;
