import type {
  ConversationStatsItem,
  ConversationSummaryReport,
  ActorActivityDayReport,
  ActorIdentity,
  ActorProfileReport,
} from "./types";
import {
  ACTIVITY_DAYS,
  activityDays,
  addSignals,
  emptyActivityDay,
  emptyStatsItem,
  emptyTotals,
  identityWithEmail,
  mergeIdentity,
  normalizeEmail,
  RECENT_LIMIT,
  reportDate,
  reportTime,
  actorRows,
  SAMPLE_LIMIT,
  signals,
  slackLocationLabel,
  statsItems,
  summaryFromRow,
  surfaceLabel,
  type PeopleApiQueryOptions,
} from "./shared";

function emptyProfile(email: string, nowMs: number): ActorProfileReport {
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (ACTIVITY_DAYS - 1));
  return {
    activityDays: activityDays(new Map(), nowMs),
    generatedAt: new Date(nowMs).toISOString(),
    locations: [],
    recentConversations: [],
    actor: { email },
    sampleLimit: SAMPLE_LIMIT,
    sampleSize: 0,
    source: "conversation_index",
    surfaces: [],
    totals: emptyTotals(),
    truncated: false,
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}

/** Load one person profile from the configured or injected SQL database. */
export async function readPeopleProfileFromSql(
  email: string,
  options: PeopleApiQueryOptions = {},
): Promise<ActorProfileReport> {
  const nowMs = Date.now();
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return emptyProfile("", nowMs);
  }

  const { rows, truncated } = await actorRows(options, normalizedEmail);
  let actor: (ActorIdentity & { email: string }) | undefined;
  const totals = emptyTotals();
  const activeDates = new Set<string>();
  const days = new Map<string, ActorActivityDayReport>();
  const locations = new Map<string, ConversationStatsItem>();
  const surfaces = new Map<string, ConversationStatsItem>();
  const recentConversations: ConversationSummaryReport[] = [];

  for (const row of rows) {
    const summary = summaryFromRow(row, nowMs);
    const identity = identityWithEmail(summary.actorIdentity);
    if (identity) {
      actor = actor ? mergeIdentity(actor, identity) : identity;
    }
    recentConversations.push(summary);

    const value = signals(summary);
    const date = reportDate(summary.lastSeenAt);
    totals.conversations += 1;
    totals.runs += 1;
    addSignals(totals, value);

    if (date) {
      activeDates.add(date);
      const day = days.get(date) ?? emptyActivityDay(date);
      day.conversations += 1;
      day.runs += 1;
      addSignals(day, value);
      days.set(date, day);
    }

    const location =
      slackLocationLabel(summary) ?? surfaceLabel(summary.surface);
    const locationItem = locations.get(location) ?? emptyStatsItem(location);
    locationItem.conversations += 1;
    locationItem.runs += 1;
    addSignals(locationItem, value);
    locations.set(location, locationItem);

    const surface = surfaceLabel(summary.surface);
    const surfaceItem = surfaces.get(surface) ?? emptyStatsItem(surface);
    surfaceItem.conversations += 1;
    surfaceItem.runs += 1;
    addSignals(surfaceItem, value);
    surfaces.set(surface, surfaceItem);
  }

  totals.activeDays = activeDates.size;
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (ACTIVITY_DAYS - 1));

  return {
    activityDays: activityDays(days, nowMs),
    generatedAt: new Date(nowMs).toISOString(),
    locations: statsItems(locations),
    recentConversations: recentConversations
      .sort(
        (left, right) =>
          (reportTime(right.lastSeenAt) ?? 0) -
            (reportTime(left.lastSeenAt) ?? 0) ||
          right.conversationId.localeCompare(left.conversationId),
      )
      .slice(0, RECENT_LIMIT),
    actor: actor ?? { email: normalizedEmail },
    sampleLimit: SAMPLE_LIMIT,
    sampleSize: rows.length,
    source: "conversation_index",
    surfaces: statsItems(surfaces),
    totals,
    truncated,
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}
