import { listConversationSidebarAnnotations } from "@/chat/plugins/conversation-sidebar";
import type { User } from "@sentry/junior-plugin-api";
import type { Conversation } from "@/chat/conversations/store";
import { getDb, getSqlExecutor } from "@/chat/db";
import { buildSentryConversationUrl } from "@/chat/sentry-links";
import { resolveSlackTeamDomains } from "@/chat/slack/team-domain";
import { readConversationModelUsageFromSql } from "@/chat/pi/sql-model-usage";
import { encodeConversationCursor } from "./cursor";
import { readFirstHumanMessageTexts } from "./first-message";
import {
  readConversationEventPage,
  readConversationEventPageAround,
} from "./event-page";
import { conversationEventPageReport } from "./event-list";
import { attachConversationMentions } from "./mentions";
import { readConversationRecordFromSql } from "./list";
import {
  conversationEventHistory,
  conversationSummaryFromStoredConversation,
} from "./projection";
import {
  readConversationAccessFromSql,
  type ConversationAccess,
} from "./access";
import {
  childAgentTotalsReport,
  readConversationTreeMetricsFromSql,
} from "./usage";
import { readConversationAuxiliaryCostsFromSql } from "./auxiliary-costs";
import { conversationDetailReportSchema } from "../schema/conversation";
import type { ConversationDetailReport } from "../schema/conversation";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { readLatestConversationBrief } from "@/chat/briefs/store";
import { readConversationSourceTask } from "@/chat/automations/read";
import { readAutomationTitlesByConversationId } from "@/chat/automations/execution-stats";
import { readConversationViewerMarks } from "./membership";
import { readConversationAutoArchive } from "./auto-archive";
import { readConversationAuthors } from "./participants";
import { readConversationForks } from "./fork";
import { readConversationAgentTree } from "./agent-tree";
import { readConversationReadPosition } from "./read-position";

/** Project stored metadata and a bounded event page into a signed history cursor. */
function projectConversationDetail(args: {
  access?: ConversationAccess;
  archivedAtMs?: number;
  pinnedAtMs?: number;
  automationTitle?: string;
  auxiliaryCosts?: ConversationDetailReport["auxiliaryCosts"];
  brief?: ConversationDetailReport["brief"];
  childAgentTotals?: ConversationDetailReport["childAgentTotals"];
  conversation: Conversation;
  durationMs: number;
  firstHumanMessageText?: string;
  annotations: NonNullable<ConversationDetailReport["annotations"]>;
  sidebarAnnotations?: ConversationDetailReport["sidebarAnnotations"];
  events: ConversationDetailReport["events"];
  locationId?: string;
  modelUsage: NonNullable<ConversationDetailReport["modelUsage"]>;
  participants: NonNullable<ConversationDetailReport["participants"]>;
  authors: NonNullable<ConversationDetailReport["authors"]>;
  previousSeq?: number;
  readPosition?: ConversationDetailReport["readPosition"];
  sourceTask?: ConversationDetailReport["sourceTask"];
  teamDomainByTeamId?: ReadonlyMap<string, string>;
  unreadAfterSeq?: number;
  unreadPage?: ConversationDetailReport["unreadPage"];
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
      archivedAtMs: args.archivedAtMs,
      pinnedAtMs: args.pinnedAtMs,
      automationTitle: args.automationTitle,
      auxiliaryCosts: args.auxiliaryCosts,
      ...(args.childAgentTotals
        ? { childAgentTotals: args.childAgentTotals }
        : undefined),
      conversation,
      durationMs: args.durationMs,
      firstHumanMessageText: args.firstHumanMessageText,
      ...(args.locationId ? { locationId: args.locationId } : undefined),
      ...(args.teamDomainByTeamId
        ? { teamDomainByTeamId: args.teamDomainByTeamId }
        : undefined),
      usage: args.usage,
    }),
    annotations: canExposePayload ? args.annotations : [],
    sidebarAnnotations: canExposePayload ? args.sidebarAnnotations : undefined,
    ...(canExposePayload && args.brief ? { brief: args.brief } : undefined),
    events: args.events,
    ...(canExposePayload && args.participants.length > 0
      ? { authors: args.authors, participants: args.participants }
      : undefined),
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
    ...(args.readPosition ? { readPosition: args.readPosition } : undefined),
    ...(args.unreadAfterSeq !== undefined
      ? {
          unreadCursor: encodeConversationCursor({
            conversationId,
            seq: args.unreadAfterSeq,
          }),
        }
      : undefined),
    ...(args.unreadPage ? { unreadPage: args.unreadPage } : undefined),
    generatedAt: new Date().toISOString(),
    ...(sentryConversationUrl ? { sentryConversationUrl } : undefined),
    ...(args.sourceTask ? { sourceTask: args.sourceTask } : undefined),
  };
}

async function readConversationDetailFromSql(
  conversationId: string,
  options: {
    limit: number;
    unreadPage?: boolean;
    viewer?: User;
  },
): Promise<ConversationDetailReport | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;
  const viewerMarks = options.viewer
    ? await readConversationViewerMarks(options.viewer, conversationId)
    : undefined;

  const executor = getSqlExecutor();
  const [
    accessByConversation,
    annotations,
    automationTitleByConversation,
    auxiliaryCostsByConversation,
    briefVersion,
    firstHumanMessageTextByConversation,
    modelUsage,
    metricsByConversation,
    people,
    readPosition,
    sourceTask,
    teamDomainByTeamId,
  ] = await Promise.all([
    readConversationAccessFromSql(getDb(), [conversationId], options.viewer),
    listConversationAnnotations(getDb(), conversationId),
    readAutomationTitlesByConversationId([record.conversation]),
    readConversationAuxiliaryCostsFromSql(getDb(), [conversationId]),
    readLatestConversationBrief(getDb(), conversationId),
    readFirstHumanMessageTexts(getDb(), [record.conversation]),
    record.conversation.transcriptPurgedAtMs === undefined
      ? readConversationModelUsageFromSql(executor, { conversationId })
      : Promise.resolve([]),
    readConversationTreeMetricsFromSql(getDb(), [conversationId]),
    readConversationAuthors(getDb(), conversationId),
    options.viewer
      ? readConversationReadPosition(options.viewer, conversationId)
      : undefined,
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
  const sidebarAnnotations = access?.canViewPrivateContent
    ? (
        await listConversationSidebarAnnotations(
          [conversationId],
          new Map([[conversationId, annotations]]),
        )
      )[conversationId]
    : undefined;
  const canExposePayload = access?.canViewPrivateContent ?? false;
  const page =
    record.conversation.transcriptPurgedAtMs === undefined
      ? await readConversationEventPage(executor, {
          canExposePayload,
          conversationId,
          limit: options.limit,
        })
      : { events: [] };
  // Events hold the latest page. A reader who is further behind starts from
  // their read position instead, so they need a cursor there.
  const firstSeq = page.events[0]?.seq;
  const unreadAfterSeq =
    readPosition !== undefined &&
    page.previousSeq !== undefined &&
    firstSeq !== undefined &&
    readPosition.lastReadSeq + 1 < firstSeq
      ? readPosition.lastReadSeq
      : undefined;
  // The Brief is shown only to viewers who can see private content.
  const brief = access?.canViewPrivateContent
    ? briefVersion?.content
    : undefined;
  const [{ briefMentions, events }, unreadPage] = await Promise.all([
    attachConversationMentions(executor, conversationId, {
      ...(brief ? { brief } : undefined),
      events: page.events,
    }),
    // Only the first read of a visit asks for this page, not each poll. The
    // page is optional: without it, the dashboard reads it with an `around`
    // request, which reports the same failure on its own route. So a failed
    // page must not fail the detail.
    options.unreadPage && unreadAfterSeq !== undefined
      ? readConversationEventPageAround(executor, {
          canExposePayload,
          conversationId,
          limit: options.limit,
          seq: unreadAfterSeq,
        })
          .then((around) =>
            conversationEventPageReport(executor, {
              conversationId,
              eventHistory: conversationEventHistory({ canExposePayload }),
              page: around,
            }),
          )
          .catch(() => undefined)
      : undefined,
  ]);
  const metrics = metricsByConversation.get(conversationId);
  const auxiliaryCosts = auxiliaryCostsByConversation.get(conversationId);
  const childAgentTotals = childAgentTotalsReport(metrics, auxiliaryCosts);
  return projectConversationDetail({
    ...record,
    access,
    ...viewerMarks,
    automationTitle: automationTitleByConversation.get(conversationId),
    annotations,
    sidebarAnnotations,
    auxiliaryCosts: auxiliaryCosts?.total,
    ...(childAgentTotals ? { childAgentTotals } : undefined),
    ...(briefVersion
      ? {
          brief: {
            content: briefVersion.content,
            ...(briefMentions.length > 0
              ? { mentions: briefMentions }
              : undefined),
            updatedAt: briefVersion.createdAt.toISOString(),
            version: briefVersion.version,
          },
        }
      : undefined),
    durationMs: metrics?.durationMs ?? record.durationMs,
    events,
    firstHumanMessageText:
      firstHumanMessageTextByConversation.get(conversationId),
    modelUsage,
    authors: people.authors,
    participants: people.participants,
    ...(sourceTask ? { sourceTask } : undefined),
    teamDomainByTeamId,
    ...(page.previousSeq === undefined
      ? undefined
      : { previousSeq: page.previousSeq }),
    ...(readPosition ? { readPosition } : undefined),
    ...(unreadAfterSeq === undefined ? undefined : { unreadAfterSeq }),
    ...(unreadPage ? { unreadPage } : undefined),
    usage: metrics?.usage ?? record.usage ?? undefined,
  });
}

/** Load one conversation from its canonical event history. */
export async function readConversationDetail(
  conversationId: string,
  options: {
    limit?: number;
    /** Also read the page around the read position. */
    unreadPage?: boolean;
    viewer?: User;
  } = {},
): Promise<ConversationDetailReport | undefined> {
  const report = await readConversationDetailFromSql(conversationId, {
    ...options,
    limit: options.limit ?? 500,
  });
  if (!report) return undefined;
  const [forks, agentTree, autoArchive] = await Promise.all([
    readConversationForks(conversationId, options.viewer),
    readConversationAgentTree(conversationId, options.viewer),
    options.viewer && report.isParticipant
      ? readConversationAutoArchive(options.viewer, conversationId)
      : undefined,
  ]);
  return conversationDetailReportSchema.parse({
    ...report,
    ...forks,
    ...(agentTree ? { agentTree } : undefined),
    ...(autoArchive === undefined ? undefined : { autoArchive }),
  });
}
