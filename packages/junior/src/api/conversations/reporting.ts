import type { StoredSlackActor } from "@/chat/actor";
import type { juniorConversations } from "@/db/schema";
import type { ConversationAccess } from "./access";
import { conversationSummaryFromStoredConversation } from "./projection";
import type {
  ConversationSummaryReport,
  ConversationSurface,
} from "../schema/conversation";

export type ReportingConversationRow = {
  channelName: string | null;
  conversationId: string;
  createdAt: Date;
  destinationId: string | null;
  durationMs: number;
  email: string | null;
  executionStatus: (typeof juniorConversations.$inferSelect)["executionStatus"];
  executionUpdatedAt: Date | null;
  fullName: string | null;
  handle: string | null;
  lastActivityAt: Date;
  providerSubjectId: string | null;
  source: (typeof juniorConversations.$inferSelect)["source"];
  title: string | null;
  updatedAt: Date;
  usage: (typeof juniorConversations.$inferSelect)["usage"];
};

/** Parse report timestamps without throwing on malformed legacy values. */
export function reportTime(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** Convert a report timestamp into the UTC day used by activity projections. */
export function reportDate(value: string): string | undefined {
  const time = reportTime(value);
  return time === undefined
    ? undefined
    : new Date(time).toISOString().slice(0, 10);
}

/** Return the dashboard label for a conversation surface. */
export function surfaceLabel(surface: ConversationSurface): string {
  if (surface === "scheduler") return "Scheduler";
  if (surface === "api") return "API";
  if (surface === "internal") return "Internal";
  return "Conversation";
}

/** Return the dashboard-safe Slack location label for a conversation. */
export function slackLocationLabel(args: {
  channel?: string;
  channelName?: string;
  channelNameRedacted?: boolean;
}): string | undefined {
  const channelId = args.channel;
  if (!channelId) return undefined;
  if (args.channelNameRedacted && args.channelName) return args.channelName;
  const name = args.channelName?.replace(/^#/, "");
  if (channelId.startsWith("D")) return "Direct Message";
  if (channelId.startsWith("C")) {
    return name ? `#${name}` : "Public Channel";
  }
  if (channelId.startsWith("G")) {
    if (name?.startsWith("mpdm-")) return "Group DM";
    return "Private Channel";
  }
  return name || channelId;
}

function actorFromRow(
  row: ReportingConversationRow,
): StoredSlackActor | undefined {
  const actor = {
    ...(row.email ? { email: row.email } : undefined),
    ...(row.fullName ? { fullName: row.fullName } : undefined),
    ...(row.providerSubjectId ? { slackUserId: row.providerSubjectId } : undefined),
    ...(row.handle ? { slackUserName: row.handle } : undefined),
  };
  return Object.keys(actor).length ? actor : undefined;
}

/** Project one SQL conversation row into a privacy-safe API summary. */
export function summaryFromRow(
  row: ReportingConversationRow,
  options: {
    access?: ConversationAccess;
    metrics?: {
      durationMs: number;
      usage?: NonNullable<ReportingConversationRow["usage"]>;
    };
  } = {},
): ConversationSummaryReport {
  const actor = actorFromRow(row);
  const conversation = {
    conversationId: row.conversationId,
    createdAtMs: row.createdAt.getTime(),
    lastActivityAtMs: row.lastActivityAt.getTime(),
    updatedAtMs: row.updatedAt.getTime(),
    execution: {
      status: row.executionStatus,
      ...(row.executionUpdatedAt
        ? { updatedAtMs: row.executionUpdatedAt.getTime() }
        : undefined),
    },
    ...(actor ? { actor } : undefined),
    ...(row.channelName ? { channelName: row.channelName } : undefined),
    ...(row.source ? { source: row.source } : undefined),
    ...(row.title ? { title: row.title } : undefined),
  };
  return conversationSummaryFromStoredConversation({
    access: options.access,
    conversation,
    durationMs: options.metrics?.durationMs ?? row.durationMs,
    ...(options.access?.visibility === "public" && row.destinationId
      ? { locationId: row.destinationId }
      : undefined),
    usage: options.metrics?.usage ?? row.usage ?? undefined,
  });
}

/** Collapse persisted conversation usage into the dashboard token total. */
export function usageTokens(
  row: Pick<ReportingConversationRow, "usage">,
): number | undefined {
  const usage = row.usage;
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheCreationTokens,
  ].filter((value): value is number => value !== undefined);
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

/** Collapse a conversation summary status into aggregate counters. */
export function conversationSignals(summary: ConversationSummaryReport) {
  return {
    active: summary.status === "active",
    failed: summary.status === "failed",
  };
}
