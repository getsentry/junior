import type { User } from "@sentry/junior-plugin-api";
import type { Conversation } from "@/chat/conversations/store";
import { getDb, getSqlExecutor } from "@/chat/db";
import { buildSentryConversationUrl } from "@/chat/sentry-links";
import { resolveSlackTeamDomains } from "@/chat/slack/team-domain";
import { readConversationModelUsageFromSql } from "@/chat/pi/sql-model-usage";
import { encodeConversationCursor } from "./cursor";
import { readConversationEventPage } from "./event-page";
import { readConversationRecordFromSql } from "./list";
import {
  conversationEventHistory,
  conversationSummaryFromStoredConversation,
} from "./projection";
import {
  readConversationAccessFromSql,
  type ConversationAccess,
} from "./access";
import { readRootConversationMetricsFromSql } from "./usage";
import { readConversationAuxiliaryCostsFromSql } from "./auxiliary-costs";
import { conversationDetailReportSchema } from "../schema/conversation";
import type { ConversationDetailReport } from "../schema/conversation";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { readConversationSourceTask } from "@/chat/tasks/read";
import { readConversationArchivedAt } from "./archive";

/** Project stored metadata and a bounded event page into a signed history cursor. */
function projectConversationDetail(args: {
  access?: ConversationAccess;
  archivedAtMs?: number;
  auxiliaryCosts?: ConversationDetailReport["auxiliaryCosts"];
  conversation: Conversation;
  durationMs: number;
  annotations: NonNullable<ConversationDetailReport["annotations"]>;
  events: ConversationDetailReport["events"];
  locationId?: string;
  modelUsage: NonNullable<ConversationDetailReport["modelUsage"]>;
  previousSeq?: number;
  sourceTask?: ConversationDetailReport["sourceTask"];
  teamDomainByTeamId?: ReadonlyMap<string, string>;
  usage: ConversationDetailReport["cumulativeUsage"];
}): ConversationDetailReport {
  const { conversation } = args;
  const conversationId = conversation.conversationId;
  const transcriptPurgedAtMs = conversation.transcriptPurgedAtMs;
  const canExposePayload = args.access?.canViewPrivateContent ?? false;
  const modelUsage = transcriptPurgedAtMs === undefined ? args.modelUsage : [];
  const sentryConversationUrl = buildSentryConversationUrl(conversationId);

  return {
    ...conversationSummaryFromStoredConversation({
      access: args.access,
      ...(args.archivedAtMs === undefined
        ? undefined
        : { archivedAtMs: args.archivedAtMs }),
      auxiliaryCosts: args.auxiliaryCosts,
      conversation,
      durationMs: args.durationMs,
      ...(args.locationId ? { locationId: args.locationId } : undefined),
      ...(args.teamDomainByTeamId
        ? { teamDomainByTeamId: args.teamDomainByTeamId }
        : undefined),
      usage: args.usage,
    }),
    annotations: canExposePayload ? args.annotations : [],
    events: args.events,
    ...(args.previousSeq !== undefined
      ? {
          previousCursor: encodeConversationCursor({
            conversationId,
            seq: args.previousSeq,
          }),
        }
      : undefined),
    ...(modelUsage.length > 0 ? { modelUsage } : undefined),
    eventHistory: conversationEventHistory({
      canExposePayload,
      ...(transcriptPurgedAtMs === undefined
        ? undefined
        : { transcriptPurgedAtMs }),
    }),
    generatedAt: new Date().toISOString(),
    ...(sentryConversationUrl ? { sentryConversationUrl } : undefined),
    ...(args.sourceTask ? { sourceTask: args.sourceTask } : undefined),
  };
}

async function readConversationDetailFromSql(
  conversationId: string,
  options: {
    limit: number;
    viewer?: User;
  },
): Promise<ConversationDetailReport | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;
  const archivedAtMs = options.viewer
    ? await readConversationArchivedAt(options.viewer, conversationId)
    : undefined;

  const executor = getSqlExecutor();
  const includeDescendantMetrics = record.rootConversationId === conversationId;
  const [
    accessByConversation,
    annotations,
    auxiliaryCostsByConversation,
    modelUsage,
    metricsByRoot,
    sourceTask,
    teamDomainByTeamId,
  ] = await Promise.all([
    readConversationAccessFromSql(getDb(), [conversationId], options.viewer),
    listConversationAnnotations(getDb(), conversationId),
    readConversationAuxiliaryCostsFromSql(getDb(), [conversationId], {
      includeDescendants: includeDescendantMetrics,
    }),
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
    readConversationSourceTask({
      conversationId,
      ...(options.viewer ? { viewer: options.viewer } : undefined),
    }),
    resolveSlackTeamDomains(
      record.conversation.location?.provider === "slack"
        ? [record.conversation.location.teamId]
        : [],
    ),
  ]);
  const access = accessByConversation.get(conversationId);
  const page =
    record.conversation.transcriptPurgedAtMs === undefined
      ? await readConversationEventPage(executor, {
          canExposePayload: access?.canViewPrivateContent ?? false,
          conversationId,
          limit: options.limit,
        })
      : { events: [] };
  const metrics = metricsByRoot.get(conversationId);
  return projectConversationDetail({
    ...record,
    access,
    ...(archivedAtMs === undefined ? undefined : { archivedAtMs }),
    annotations,
    auxiliaryCosts: auxiliaryCostsByConversation.get(conversationId),
    durationMs: metrics?.durationMs ?? record.durationMs,
    events: page.events,
    modelUsage,
    ...(sourceTask ? { sourceTask } : undefined),
    teamDomainByTeamId,
    ...(page.previousSeq === undefined
      ? undefined
      : { previousSeq: page.previousSeq }),
    usage: metrics?.usage ?? record.usage ?? undefined,
  });
}

/** Load one conversation from its canonical event history. */
export async function readConversationDetail(
  conversationId: string,
  options: {
    limit?: number;
    viewer?: User;
  } = {},
): Promise<ConversationDetailReport | undefined> {
  const report = await readConversationDetailFromSql(conversationId, {
    ...options,
    limit: options.limit ?? 500,
  });
  return report ? conversationDetailReportSchema.parse(report) : undefined;
}
