import { listConversationSidebarAnnotations } from "@/chat/plugins/conversation-sidebar";
import type { User } from "@sentry/junior-plugin-api";
import type { Conversation } from "@/chat/conversations/store";
import { getDb, getSqlExecutor } from "@/chat/db";
import { startSpan } from "@/chat/sentry";
import { buildSentryConversationUrl } from "@/chat/sentry-links";
import { resolveSlackTeamDomains } from "@/chat/slack/team-domain";
import { readConversationModelUsageFromSql } from "@/chat/pi/sql-model-usage";
import { decodeConversationCursor, encodeConversationCursor } from "./cursor";
import { readConversationAgentTree } from "./agent-tree";
import { readFirstHumanMessageTexts } from "./first-message";
import {
  readConversationEventPage,
  readConversationEventPageAfter,
  readConversationEventPageAround,
} from "./event-page";
import { conversationEventPageReport } from "./event-list";
import { attachConversationMentions } from "./mentions";
import {
  conversationEventHistory,
  conversationSummaryFromStoredConversation,
} from "./projection";
import {
  createConversationAccessReader,
  type ConversationAccess,
} from "./access";
import {
  readConversationDetailState,
  type DetailStateRead,
} from "./detail-etag";
import {
  childAgentTotalsReport,
  readConversationTreeMetricsFromSql,
} from "./usage";
import { readConversationAuxiliaryCostsFromSql } from "./auxiliary-costs";
import {
  CONVERSATION_EVENT_PAGE_LIMIT,
  conversationDetailReportSchema,
} from "../schema/conversation";
import type { ConversationDetailReport } from "../schema/conversation";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { readLatestConversationBrief } from "@/chat/briefs/store";
import { readConversationSourceTask } from "@/chat/automations/read";
import { readAutomationTitlesByConversationId } from "@/chat/automations/execution-stats";
import { readConversationAuthors } from "./participants";
import { canContinueInSlack } from "@/chat/slack/continue-in-slack";
import { canPauseConversationDelivery } from "@/chat/conversations/delivery-pause";

/** Project stored metadata and a bounded event page into a signed history cursor. */
function projectConversationDetail(args: {
  access?: ConversationAccess;
  appendCursor?: string;
  /** Events hold only the events after the request's `after` cursor. */
  appended?: boolean;
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
    ...(args.appended ? { appended: true as const } : undefined),
    ...(args.appendCursor ? { appendCursor: args.appendCursor } : undefined),
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
    after?: string;
    latestTurns?: number;
    limit: number;
    stored?: DetailStateRead;
    unreadPage?: boolean;
    viewer?: User;
  },
): Promise<ConversationDetailReport | undefined> {
  const readAccess = createConversationAccessReader(getDb(), options.viewer);
  const { record, state } =
    options.stored ??
    (await readConversationDetailState(
      conversationId,
      options.viewer,
      readAccess,
    ));
  if (!record) return undefined;
  const { access, readPosition } = state;
  const canExposePayload = access?.canViewPrivateContent ?? false;

  const executor = getSqlExecutor();
  const isPurged = record.conversation.transcriptPurgedAtMs !== undefined;
  // A poll extends the events that it has only while they still project the
  // same way. The first read of a visit asks for the unread page, which needs
  // the latest page.
  const after =
    options.after && !options.unreadPage && !isPurged
      ? decodeConversationCursor({ conversationId, cursor: options.after })
      : undefined;
  const afterSeq =
    after && after.transcript === state.transcriptVersion
      ? after.seq
      : undefined;
  const readPage = async (): Promise<
    Awaited<ReturnType<typeof readConversationEventPage>> & {
      appended?: true;
    }
  > => {
    if (isPurged) return { events: [] };
    if (afterSeq !== undefined) {
      const newer = await readConversationEventPageAfter(executor, {
        afterSeq,
        canExposePayload,
        conversationId,
        limit: options.limit,
      });
      // A reader more than a page behind gets the latest page instead.
      if (newer.nextSeq === undefined) {
        return { appended: true, events: newer.events };
      }
    }
    return readConversationEventPage(executor, {
      canExposePayload,
      conversationId,
      latestTurns: options.latestTurns,
      limit: options.limit,
    });
  };
  // Access is known, so the event page reads beside the metadata.
  const [
    agentTree,
    annotations,
    automationTitleByConversation,
    auxiliaryCostsByConversation,
    briefVersion,
    firstHumanMessageTextByConversation,
    modelUsage,
    metricsByConversation,
    people,
    sourceTask,
    teamDomainByTeamId,
    page,
  ] = await Promise.all([
    readConversationAgentTree(
      {
        conversationId,
        ...(record.conversation.parentConversationId
          ? { parentConversationId: record.conversation.parentConversationId }
          : undefined),
      },
      readAccess,
    ),
    listConversationAnnotations(getDb(), conversationId),
    readAutomationTitlesByConversationId([record.conversation]),
    readConversationAuxiliaryCostsFromSql(getDb(), [conversationId]),
    readLatestConversationBrief(getDb(), conversationId),
    readFirstHumanMessageTexts(getDb(), [record.conversation]),
    isPurged
      ? Promise.resolve([])
      : readConversationModelUsageFromSql(executor, { conversationId }),
    readConversationTreeMetricsFromSql(getDb(), [conversationId]),
    readConversationAuthors(getDb(), conversationId),
    readConversationSourceTask({
      conversationId,
      ...(options.viewer ? { viewer: options.viewer } : undefined),
    }),
    resolveSlackTeamDomains(
      record.conversation.location?.provider === "slack"
        ? [record.conversation.location.teamId]
        : [],
    ),
    readPage(),
  ]);
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
  const brief = canExposePayload ? briefVersion?.content : undefined;
  const [{ briefMentions, events }, unreadPage, sidebarAnnotations] =
    await Promise.all([
      startSpan({ name: "Attach conversation mentions", op: "function" }, () =>
        attachConversationMentions(executor, conversationId, {
          ...(brief ? { brief } : undefined),
          events: page.events,
        }),
      ),
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
      canExposePayload
        ? listConversationSidebarAnnotations(
            [conversationId],
            new Map([[conversationId, annotations]]),
          ).then((byConversation) => byConversation[conversationId])
        : undefined,
    ]);
  // A poll with no newer events keeps the cursor that it sent.
  const appendedAfterSeq = page.appended ? afterSeq : undefined;
  const metrics = metricsByConversation.get(conversationId);
  const auxiliaryCosts = auxiliaryCostsByConversation.get(conversationId);
  const childAgentTotals = childAgentTotalsReport(metrics, auxiliaryCosts);
  const detail: Parameters<typeof projectConversationDetail>[0] = {
    ...record,
    access,
    ...(page.appended ? { appended: true } : undefined),
    ...(isPurged
      ? undefined
      : {
          appendCursor: encodeConversationCursor({
            conversationId,
            seq: page.events.at(-1)?.seq ?? appendedAfterSeq ?? -1,
            transcript: state.transcriptVersion,
          }),
        }),
    ...state.viewerMarks,
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
  };
  const report = startSpan(
    { name: "Project conversation detail", op: "function" },
    () => projectConversationDetail(detail),
  );
  return {
    ...report,
    ...state.forks,
    ...(agentTree ? { agentTree } : undefined),
    ...(report.isParticipant && state.autoArchive !== undefined
      ? { autoArchive: state.autoArchive }
      : undefined),
    ...(report.isParticipant && state.subscribed !== undefined
      ? { subscribed: state.subscribed }
      : undefined),
    ...(canContinueInSlack(record.conversation, access)
      ? { canContinueInSlack: true as const }
      : undefined),
    ...(report.isParticipant &&
    canPauseConversationDelivery(record.conversation)
      ? {
          deliveryPaused: record.conversation.deliveryPausedAtMs !== undefined,
        }
      : undefined),
  };
}

/** Turns in the default page: enough to read the latest exchange in context. */
const DETAIL_LATEST_TURNS = 3;

/**
 * Load one conversation from its canonical event history. Without `limit`,
 * events hold the latest Turns, up to the default limit.
 */
export async function readConversationDetail(
  conversationId: string,
  options: {
    /** An `appendCursor`: return only newer events when it still applies. */
    after?: string;
    limit?: number;
    /** The record and state that the route already read for the ETag. */
    stored?: DetailStateRead;
    /** Also read the page around the read position. */
    unreadPage?: boolean;
    viewer?: User;
  } = {},
): Promise<ConversationDetailReport | undefined> {
  const report = await readConversationDetailFromSql(conversationId, {
    ...options,
    ...(options.limit === undefined
      ? {
          latestTurns: DETAIL_LATEST_TURNS,
          limit: CONVERSATION_EVENT_PAGE_LIMIT,
        }
      : { limit: options.limit }),
  });
  if (!report) return undefined;
  return startSpan(
    { name: "Validate conversation detail", op: "function" },
    () => conversationDetailReportSchema.parse(report),
  );
}
