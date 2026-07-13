import type {
  ConversationStatsItem,
  ConversationSummaryReport,
  ActorActivityDayReport,
  ActorIdentity,
  ActorProfileReport,
} from "./schema";
import {
  conversationSignals,
  reportDate,
  reportTime,
  slackLocationLabel,
  summaryFromRow,
  surfaceLabel,
  usageTokens,
} from "../conversations/reporting";
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
  actorRows,
  SAMPLE_LIMIT,
  statsItems,
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

/** Load one person profile from the configured SQL database. */
export async function readPeopleProfileFromSql(
  email: string,
): Promise<ActorProfileReport> {
  const nowMs = Date.now();
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return emptyProfile("", nowMs);
  }

  const { rows, truncated } = await actorRows(normalizedEmail);
  let actor: (ActorIdentity & { email: string }) | undefined;
  const totals = emptyTotals();
  const activeDates = new Set<string>();
  const days = new Map<string, ActorActivityDayReport>();
  const locations = new Map<string, ConversationStatsItem>();
  const surfaces = new Map<string, ConversationStatsItem>();
  const recentConversations: ConversationSummaryReport[] = [];

  for (const row of rows) {
    const summary = summaryFromRow(row);
    const identity = identityWithEmail(summary.actorIdentity);
    if (identity) {
      actor = actor ? mergeIdentity(actor, identity) : identity;
    }
    recentConversations.push(summary);

    const value = conversationSignals(summary);
    const date = reportDate(summary.lastSeenAt);
    totals.conversations += 1;
    totals.durationMs += summary.cumulativeDurationMs;
    const tokens = usageTokens(row);
    if (tokens !== undefined) totals.tokens = (totals.tokens ?? 0) + tokens;
    addSignals(totals, value);

    if (date) {
      activeDates.add(date);
      const day = days.get(date) ?? emptyActivityDay(date);
      day.conversations += 1;
      day.durationMs += summary.cumulativeDurationMs;
      if (tokens !== undefined) day.tokens = (day.tokens ?? 0) + tokens;
      addSignals(day, value);
      days.set(date, day);
    }

    const location =
      slackLocationLabel(summary) ?? surfaceLabel(summary.surface);
    const locationItem = locations.get(location) ?? emptyStatsItem(location);
    locationItem.conversations += 1;
    locationItem.durationMs += summary.cumulativeDurationMs;
    if (tokens !== undefined) {
      locationItem.tokens = (locationItem.tokens ?? 0) + tokens;
    }
    addSignals(locationItem, value);
    locations.set(location, locationItem);

    const surface = surfaceLabel(summary.surface);
    const surfaceItem = surfaces.get(surface) ?? emptyStatsItem(surface);
    surfaceItem.conversations += 1;
    surfaceItem.durationMs += summary.cumulativeDurationMs;
    if (tokens !== undefined) {
      surfaceItem.tokens = (surfaceItem.tokens ?? 0) + tokens;
    }
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
