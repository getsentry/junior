import { conversationStore, type ConversationReaderOptions } from "./context";
import {
  newestRun,
  reportTime,
  slackStatsLocationLabel,
  surfaceFallbackLabel,
} from "./shared";
import { sessionReportFromConversation } from "./summaries";
import type {
  ActorIdentity,
  ConversationStatsItem,
  ConversationStatsReport,
  ConversationSummaryReport,
  ConversationUsage,
} from "./types";

const CONVERSATION_STATS_LIMIT = 5_000;
const RECENT_CONVERSATION_STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
function usageTokenTotal(
  usage: ConversationUsage | undefined,
): number | undefined {
  if (!usage) return undefined;
  const components = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheCreationTokens,
  ].reduce<number | undefined>((sum, value) => {
    const count =
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : undefined;
    return count === undefined ? sum : (sum ?? 0) + count;
  }, undefined);
  if (components !== undefined) {
    return components;
  }
  return typeof usage.totalTokens === "number" &&
    Number.isFinite(usage.totalTokens)
    ? Math.max(0, Math.floor(usage.totalTokens))
    : undefined;
}

type RunContribution = {
  durationMs: number;
  tokens?: number;
  run: ConversationSummaryReport;
};

function runDurationSnapshot(
  run: ConversationSummaryReport,
): number | undefined {
  return typeof run.cumulativeDurationMs === "number" &&
    Number.isFinite(run.cumulativeDurationMs)
    ? Math.max(0, Math.floor(run.cumulativeDurationMs))
    : undefined;
}

function runContributions(
  runs: ConversationSummaryReport[],
): RunContribution[] {
  let previousDuration = 0;
  let previousTokens = 0;
  return runs.map((run) => {
    const duration = runDurationSnapshot(run);
    const tokens = usageTokenTotal(run.cumulativeUsage);
    const contribution: RunContribution = {
      durationMs:
        duration === undefined ? 0 : Math.max(0, duration - previousDuration),
      run,
    };
    if (tokens !== undefined) {
      contribution.tokens = Math.max(0, tokens - previousTokens);
    }
    if (duration !== undefined) {
      previousDuration = Math.max(previousDuration, duration);
    }
    if (tokens !== undefined) {
      previousTokens = Math.max(previousTokens, tokens);
    }
    return contribution;
  });
}

function contributionDurationTotal(contributions: RunContribution[]): number {
  return contributions.reduce(
    (sum, contribution) => sum + contribution.durationMs,
    0,
  );
}

function addTokenTotal(
  total: number | undefined,
  tokens: number | undefined,
): number | undefined {
  return tokens === undefined ? total : (total ?? 0) + tokens;
}

function contributionTokenTotal(
  contributions: RunContribution[],
): number | undefined {
  return contributions.reduce(
    (sum, contribution) => addTokenTotal(sum, contribution.tokens),
    undefined as number | undefined,
  );
}

function actorLabel(actor: ActorIdentity | undefined): string | undefined {
  const email = actor?.email?.trim() || undefined;
  const fullName = actor?.fullName?.trim() || undefined;
  const slackUserName = actor?.slackUserName?.trim() || undefined;
  return email ?? fullName ?? slackUserName ?? actor?.slackUserId;
}

function locationLabel(run: ConversationSummaryReport): string {
  return slackStatsLocationLabel(run) ?? surfaceFallbackLabel(run.surface);
}

function emptyStatsItem(label: string): ConversationStatsItem {
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    hung: 0,
    label,
    runs: 0,
  };
}

function addItemTokens(
  item: ConversationStatsItem,
  tokens: number | undefined,
): void {
  if (tokens !== undefined) {
    item.tokens = (item.tokens ?? 0) + tokens;
  }
}

function statusSignals(runs: ConversationSummaryReport[]) {
  return {
    active: runs.some((run) => run.status === "active"),
    failed: runs.some((run) => run.status === "failed"),
    hung: runs.some((run) => run.status === "hung"),
  };
}

function statsItems(map: Map<string, ConversationStatsItem>) {
  return [...map.values()].sort(
    (left, right) =>
      right.conversations - left.conversations ||
      right.runs - left.runs ||
      right.durationMs - left.durationMs ||
      left.label.localeCompare(right.label),
  );
}

function recentConversationGroups(args: {
  nowMs: number;
  summaries: ConversationSummaryReport[];
}): ConversationSummaryReport[][] {
  const startMs = args.nowMs - RECENT_CONVERSATION_STATS_WINDOW_MS;
  const groups = new Map<string, ConversationSummaryReport[]>();
  for (const summary of args.summaries) {
    groups.set(summary.conversationId, [
      ...(groups.get(summary.conversationId) ?? []),
      summary,
    ]);
  }

  return [...groups.values()]
    .map((runs) =>
      [...runs].sort(
        (left, right) =>
          (reportTime(left.startedAt) ?? 0) -
            (reportTime(right.startedAt) ?? 0) ||
          left.id.localeCompare(right.id),
      ),
    )
    .filter((runs) => {
      const activityAt = reportTime(newestRun(runs).lastSeenAt);
      return (
        activityAt !== undefined &&
        activityAt >= startMs &&
        activityAt <= args.nowMs
      );
    });
}

function conversationDurationMs(runs: ConversationSummaryReport[]): number {
  if (!runs.some((run) => runDurationSnapshot(run) !== undefined)) {
    return 0;
  }
  return contributionDurationTotal(runContributions(runs));
}

function buildConversationStatsReport(args: {
  generatedAt: string;
  nowMs: number;
  sampleLimit: number;
  sampleSize: number;
  summaries: ConversationSummaryReport[];
  truncated: boolean;
}): ConversationStatsReport {
  const conversations = recentConversationGroups(args);
  const actors = new Map<string, ConversationStatsItem>();
  const locations = new Map<string, ConversationStatsItem>();
  let durationMs = 0;
  let tokens: number | undefined;
  let active = 0;
  let failed = 0;
  let hung = 0;

  for (const runs of conversations) {
    const contributions = runContributions(runs);
    const conversationSignals = statusSignals(runs);
    const conversationTokens = contributionTokenTotal(contributions);
    durationMs += contributionDurationTotal(contributions);
    tokens = addTokenTotal(tokens, conversationTokens);
    active += conversationSignals.active ? 1 : 0;
    failed += conversationSignals.failed ? 1 : 0;
    hung += conversationSignals.hung ? 1 : 0;

    const actorRuns = new Map<string, RunContribution[]>();
    for (const contribution of contributions) {
      const actor = actorLabel(contribution.run.actorIdentity) ?? "Unknown";
      actorRuns.set(actor, [...(actorRuns.get(actor) ?? []), contribution]);
    }

    for (const [actor, actorContributions] of actorRuns) {
      const item = actors.get(actor) ?? emptyStatsItem(actor);
      const signals = statusSignals(
        actorContributions.map((contribution) => contribution.run),
      );
      item.conversations += 1;
      item.runs += actorContributions.length;
      item.durationMs += contributionDurationTotal(actorContributions);
      item.active += signals.active ? 1 : 0;
      item.failed += signals.failed ? 1 : 0;
      item.hung += signals.hung ? 1 : 0;
      addItemTokens(item, contributionTokenTotal(actorContributions));
      actors.set(actor, item);
    }

    const location = locationLabel(newestRun(runs));
    const locationItem = locations.get(location) ?? emptyStatsItem(location);
    locationItem.conversations += 1;
    locationItem.runs += runs.length;
    locationItem.durationMs += conversationDurationMs(runs);
    locationItem.active += conversationSignals.active ? 1 : 0;
    locationItem.failed += conversationSignals.failed ? 1 : 0;
    locationItem.hung += conversationSignals.hung ? 1 : 0;
    addItemTokens(locationItem, conversationTokens);
    locations.set(location, locationItem);
  }

  return {
    active,
    conversations: conversations.length,
    durationMs,
    failed,
    generatedAt: args.generatedAt,
    hung,
    locations: statsItems(locations),
    actors: statsItems(actors),
    sampleLimit: args.sampleLimit,
    sampleSize: args.sampleSize,
    source: "conversation_index",
    ...(tokens !== undefined ? { tokens } : {}),
    truncated: args.truncated,
    runs: conversations.reduce((sum, runs) => sum + runs.length, 0),
    windowEnd: new Date(args.nowMs).toISOString(),
    windowStart: new Date(
      args.nowMs - RECENT_CONVERSATION_STATS_WINDOW_MS,
    ).toISOString(),
  };
}

export async function readConversationStatsReport(
  options: ConversationReaderOptions = {},
): Promise<ConversationStatsReport> {
  const store = conversationStore(options);
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const conversations = await store.listByActivity({
    limit: CONVERSATION_STATS_LIMIT + 1,
  });
  const truncated = conversations.length > CONVERSATION_STATS_LIMIT;
  const sampledConversations = conversations.slice(0, CONVERSATION_STATS_LIMIT);
  const summaries = sampledConversations.map((conversation) =>
    sessionReportFromConversation(conversation, nowMs),
  );
  return buildConversationStatsReport({
    generatedAt,
    nowMs,
    sampleLimit: CONVERSATION_STATS_LIMIT,
    sampleSize: sampledConversations.length,
    summaries,
    truncated,
  });
}

/** List recent conversation summaries for plugin operational reports. */
