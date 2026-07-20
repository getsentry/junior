/** Deterministic reporting fixtures for local dashboard development and QA. */
import type {
  ActorDirectoryReport,
  ActorActivityDayReport,
  ActorIdentity,
  ActorProfileReport,
  ActorSummaryReport,
  ConversationDetailReport,
  ConversationFeed,
  ConversationReportEvent,
  ConversationReportEventData,
  ConversationStatsItem,
  ConversationStatsReport,
  ConversationSummaryReport,
  LocationDetailReport,
  LocationActorSummaryReport,
  LocationActivityDayReport,
  LocationDirectoryReport,
  LocationSummaryReport,
  PeopleActivityDayReport,
} from "@sentry/junior/api/schema";

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const INCIDENT_CONVERSATION_ID = "slack:CQA123:1770000000.000100";
const PRIVATE_CONVERSATION_ID = "slack:DQA123:1770007200.000300";
const SANDBOX_CONVERSATION_ID = "slack:CQA999:1770010800.000400";
const FAILED_CONVERSATION_ID = "slack:CQA777:1770014400.000500";
const LONG_CONVERSATION_ID = "slack:CQA456:1770021600.000600";
const SCHEDULER_CONVERSATION_ID = "scheduler:daily-ops-digest";
export const DASHBOARD_QA_CONVERSATION_ID = "internal:dashboard-qa";
const DASHBOARD_QA_PLAN_ID = "junior:internal:dashboard-qa:advisor-plan";
const DASHBOARD_QA_REVIEW_ID = "junior:internal:dashboard-qa:advisor-review";
const PEOPLE_ACTIVITY_DAYS = 90;
const PEOPLE_PROFILE_ACTIVITY_DAYS = 365;
const PUBLIC_MOCK_CHANNEL_IDS = new Set([
  "CQA123",
  "CQA456",
  "CQA777",
  "CQA999",
]);

function iso(nowMs: number, offsetMs = 0): string {
  return new Date(nowMs + offsetMs).toISOString();
}

function sentryConversationUrl(conversationId: string): string {
  return `https://sentry.example.com/organizations/acme/explore/conversations/${encodeURIComponent(conversationId)}/`;
}

function reportEvent(
  seq: number,
  createdAt: string,
  data: ConversationReportEventData,
): ConversationReportEvent {
  return { seq, createdAt, data };
}

type DetailOptions = Omit<
  ConversationDetailReport,
  | "cumulativeDurationMs"
  | "displayTitle"
  | "eventHistory"
  | "events"
  | "generatedAt"
  | "lastProgressAt"
  | "lastSeenAt"
  | "startedAt"
  | "status"
  | "surface"
> & {
  cumulativeDurationMs?: number;
  displayTitle: string;
  eventHistory?: ConversationDetailReport["eventHistory"];
  events: ConversationReportEvent[];
  lastProgressAt?: string;
  lastSeenAt?: string;
  startedAt: string;
  status?: ConversationDetailReport["status"];
  surface?: ConversationDetailReport["surface"];
};

type MockConversation = ConversationDetailReport & {
  parentConversationId?: string;
};

function detail(
  nowMs: number,
  options: DetailOptions,
): ConversationDetailReport {
  return {
    ...options,
    cumulativeDurationMs: options.cumulativeDurationMs ?? 0,
    eventHistory: options.eventHistory ?? { status: "available" },
    generatedAt: iso(nowMs),
    lastProgressAt: options.lastProgressAt ?? options.startedAt,
    lastSeenAt: options.lastSeenAt ?? options.startedAt,
    status: options.status ?? "completed",
    surface: options.surface ?? "internal",
  };
}

function activeConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -6 * 60_000);
  return detail(nowMs, {
    conversationId: ACTIVE_CONVERSATION_ID,
    displayTitle: "Investigate checkout latency",
    startedAt,
    lastProgressAt: iso(nowMs, -20_000),
    lastSeenAt: iso(nowMs, -10_000),
    status: "active",
    surface: "slack",
    channel: "CQA123",
    channelName: "proj-checkout",
    actorIdentity: actor("morgan@sentry.io", "Morgan Lee", "morgan"),
    cumulativeDurationMs: 31_000,
    cumulativeUsage: usage(0.041),
    sentryConversationUrl: sentryConversationUrl(ACTIVE_CONVERSATION_ID),
    events: [
      reportEvent(0, startedAt, {
        type: "message",
        messageId: "active-user",
        role: "user",
        text: "Find the slow checkout requests from the last deployment.",
      }),
      reportEvent(1, iso(Date.parse(startedAt), 5_000), {
        type: "turn_lifecycle",
        turnId: "active-turn",
        state: "started",
      }),
      reportEvent(2, iso(Date.parse(startedAt), 8_000), {
        type: "tool_started",
        name: "datacat.search_logs",
      }),
    ],
  });
}

function dashboardQaConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -11 * 60_000);
  return detail(nowMs, {
    conversationId: DASHBOARD_QA_CONVERSATION_ID,
    displayTitle: "Dashboard QA edge cases",
    startedAt,
    lastSeenAt: iso(nowMs, -8 * 60_000),
    lastProgressAt: iso(nowMs, -8 * 60_000),
    actorIdentity: actor("morgan@sentry.io", "Morgan Lee", "morgan"),
    cumulativeDurationMs: 98_000,
    events: [
      reportEvent(0, startedAt, {
        type: "message",
        messageId: "qa-user",
        role: "user",
        text: "Review the dashboard plan before editing.",
      }),
      reportEvent(1, iso(Date.parse(startedAt), 2_000), {
        type: "tool_started",
        name: "advisor",
      }),
      reportEvent(2, iso(Date.parse(startedAt), 3_000), {
        type: "subagent_started",
        childConversationId: DASHBOARD_QA_PLAN_ID,
        subagentKind: "advisor",
        toolStartedSeq: 1,
      }),
      reportEvent(3, iso(Date.parse(startedAt), 20_000), {
        type: "subagent_ended",
        startedSeq: 2,
        outcome: "success",
      }),
      reportEvent(4, iso(Date.parse(startedAt), 25_000), {
        type: "subagent_started",
        childConversationId: DASHBOARD_QA_REVIEW_ID,
        subagentKind: "advisor",
      }),
      reportEvent(5, iso(Date.parse(startedAt), 44_000), {
        type: "subagent_ended",
        startedSeq: 4,
        outcome: "success",
      }),
      reportEvent(6, iso(Date.parse(startedAt), 50_000), {
        type: "compaction",
      }),
      reportEvent(7, iso(Date.parse(startedAt), 55_000), {
        type: "message",
        messageId: "qa-assistant",
        role: "assistant",
        text: "The canonical event rendering looks sound.",
      }),
    ],
  });
}

function advisorConversation(
  nowMs: number,
  conversationId: string,
  text: string,
): MockConversation {
  const startedAt = iso(nowMs, -10 * 60_000);
  const conversation = detail(nowMs, {
    conversationId,
    displayTitle: "Advisor review",
    startedAt,
    lastSeenAt: iso(Date.parse(startedAt), 18_000),
    lastProgressAt: iso(Date.parse(startedAt), 18_000),
    cumulativeDurationMs: 18_000,
    events: [
      reportEvent(0, startedAt, {
        type: "message",
        messageId: `${conversationId}:input`,
        role: "user",
        text,
      }),
      reportEvent(1, iso(Date.parse(startedAt), 18_000), {
        type: "message",
        messageId: `${conversationId}:output`,
        role: "assistant",
        text: "Review complete; no blocking issues found.",
      }),
    ],
  });
  return {
    ...conversation,
    parentConversationId: DASHBOARD_QA_CONVERSATION_ID,
  };
}

function longConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -92 * 60_000);
  const events: ConversationReportEvent[] = [
    reportEvent(0, startedAt, {
      type: "message",
      messageId: "release-user",
      role: "user",
      text: "Release the package, update the example app, and open a PR.",
    }),
  ];
  for (let index = 0; index < 12; index += 1) {
    events.push(
      reportEvent(
        index + 1,
        iso(Date.parse(startedAt), 2_000 + index * 4_000),
        {
          type: "tool_started",
          name: "bash",
        },
      ),
    );
  }
  events.push(
    reportEvent(13, iso(Date.parse(startedAt), 53_000), {
      type: "compaction",
    }),
    reportEvent(14, iso(Date.parse(startedAt), 90_000), {
      type: "handoff",
    }),
    reportEvent(15, iso(Date.parse(startedAt), 166_000), {
      type: "message",
      messageId: "release-assistant",
      role: "assistant",
      text: "Released the package and opened the update pull request.",
    }),
  );
  return detail(nowMs, {
    conversationId: LONG_CONVERSATION_ID,
    displayTitle: "Package release and self-update",
    startedAt,
    lastSeenAt: iso(nowMs, -81 * 60_000),
    lastProgressAt: iso(nowMs, -81 * 60_000),
    surface: "slack",
    channel: "CQA456",
    channelName: "proj-release",
    actorIdentity: actor(undefined, "Jordan Blake", "jordan"),
    cumulativeDurationMs: 552_761,
    cumulativeUsage: usage(0.18),
    modelUsage: [
      {
        modelId: "anthropic/claude-sonnet-4-5",
        usage: {
          inputTokens: 800,
          outputTokens: 280,
          cachedInputTokens: 200,
          cost: { input: 0.048, output: 0.072, total: 0.12 },
        },
      },
      {
        modelId: "openai/gpt-5.2",
        usage: {
          inputTokens: 400,
          outputTokens: 140,
          cachedInputTokens: 100,
          cost: { input: 0.024, output: 0.036, total: 0.06 },
        },
      },
    ],
    events,
  });
}

function incidentConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -44 * 60_000);
  return detail(nowMs, {
    conversationId: INCIDENT_CONVERSATION_ID,
    displayTitle: "Checkout latency triage",
    startedAt,
    lastSeenAt: iso(nowMs, -41 * 60_000),
    lastProgressAt: iso(nowMs, -42 * 60_000),
    surface: "slack",
    channel: "CQA123",
    channelName: "proj-checkout",
    actorIdentity: actor("morgan@sentry.io", "Morgan Lee", "morgan"),
    cumulativeDurationMs: 206_000,
    cumulativeUsage: usage(0.0332),
    events: [
      reportEvent(0, startedAt, {
        type: "message",
        messageId: "incident-user",
        role: "user",
        text: "Draft the rollback note with the exact evidence.",
      }),
      reportEvent(1, iso(Date.parse(startedAt), 12_000), {
        type: "tool_started",
        name: "sentry.get_issue",
      }),
      reportEvent(2, iso(Date.parse(startedAt), 35_000), {
        type: "message",
        messageId: "incident-assistant",
        role: "assistant",
        text: "The regression started with payments-v42; rollback is recommended.",
      }),
    ],
  });
}

function privateConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -24 * 60_000);
  return detail(nowMs, {
    conversationId: PRIVATE_CONVERSATION_ID,
    displayTitle: "Direct Message",
    startedAt,
    lastSeenAt: iso(nowMs, -21 * 60_000),
    lastProgressAt: iso(nowMs, -21 * 60_000),
    surface: "slack",
    channel: "DQA123",
    channelName: "Private conversation",
    channelNameRedacted: true,
    actorIdentity: actor("avery@sentry.io", "Avery Chen", "avery"),
    cumulativeDurationMs: 42_000,
    eventHistory: { status: "redacted", reason: "non_public_conversation" },
    events: [
      reportEvent(0, startedAt, {
        type: "message",
        messageId: "private-user",
        role: "user",
        redacted: true,
      }),
      reportEvent(1, iso(Date.parse(startedAt), 10_000), {
        type: "tool_started",
        name: "sentry.search",
      }),
      reportEvent(2, iso(Date.parse(startedAt), 30_000), {
        type: "message",
        messageId: "private-assistant",
        role: "assistant",
        redacted: true,
      }),
    ],
  });
}

function failedConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -36 * 60_000);
  return detail(nowMs, {
    conversationId: FAILED_CONVERSATION_ID,
    displayTitle: "Deployment investigation failed",
    startedAt,
    lastSeenAt: iso(nowMs, -35 * 60_000),
    lastProgressAt: iso(nowMs, -35 * 60_000),
    status: "failed",
    surface: "slack",
    channel: "CQA777",
    channelName: "proj-incidents",
    actorIdentity: actor("riley@sentry.io", "Riley Park", "riley"),
    cumulativeDurationMs: 19_000,
    events: [
      reportEvent(0, startedAt, {
        type: "message",
        messageId: "failed-user",
        role: "user",
        text: "Check the deployment failure.",
      }),
      reportEvent(1, iso(Date.parse(startedAt), 1_000), {
        type: "turn_lifecycle",
        turnId: "failed-turn",
        state: "started",
      }),
      reportEvent(2, iso(Date.parse(startedAt), 19_000), {
        type: "turn_lifecycle",
        turnId: "failed-turn",
        state: "failed",
        failureKind: "agent",
      }),
    ],
  });
}

function simpleConversation(
  nowMs: number,
  options: {
    conversationId: string;
    displayTitle: string;
    surface: "internal" | "scheduler" | "slack";
    channel?: string;
  },
): ConversationDetailReport {
  const startedAt = iso(nowMs, -2 * 60 * 60_000);
  return detail(nowMs, {
    ...options,
    startedAt,
    lastSeenAt: iso(nowMs, -110 * 60_000),
    lastProgressAt: iso(nowMs, -110 * 60_000),
    actorIdentity: actor("ops@sentry.io", "Ops Bot", "ops"),
    cumulativeDurationMs: 12_000,
    events: [
      reportEvent(0, startedAt, {
        type: "message",
        messageId: `${options.conversationId}:message`,
        role: "assistant",
        text: "Scheduled operation completed successfully.",
      }),
    ],
  });
}

function actor(
  email: string | undefined,
  fullName: string,
  slackUserName: string,
): ActorIdentity {
  return { ...(email ? { email } : {}), fullName, slackUserName };
}

function usage(cost: number) {
  return {
    inputTokens: 1_200,
    outputTokens: 420,
    cachedInputTokens: 300,
    cost: { input: cost * 0.4, output: cost * 0.6, total: cost },
  };
}

function mockConversations(nowMs: number): MockConversation[] {
  return [
    activeConversation(nowMs),
    dashboardQaConversation(nowMs),
    advisorConversation(
      nowMs,
      DASHBOARD_QA_PLAN_ID,
      "Review the dashboard plan before editing.",
    ),
    advisorConversation(
      nowMs,
      DASHBOARD_QA_REVIEW_ID,
      "Review the implementation after the first advisor pass.",
    ),
    longConversation(nowMs),
    incidentConversation(nowMs),
    privateConversation(nowMs),
    failedConversation(nowMs),
    simpleConversation(nowMs, {
      conversationId: SANDBOX_CONVERSATION_ID,
      displayTitle: "Sandbox validation",
      surface: "slack",
      channel: "CQA999",
    }),
    simpleConversation(nowMs, {
      conversationId: SCHEDULER_CONVERSATION_ID,
      displayTitle: "Daily operations digest",
      surface: "scheduler",
    }),
  ];
}

function summaryFromConversation(
  conversation: MockConversation,
): ConversationSummaryReport {
  const {
    eventHistory: _eventHistory,
    events: _events,
    generatedAt: _generatedAt,
    modelUsage: _modelUsage,
    parentConversationId: _parentConversationId,
    sentryConversationUrl: _sentryConversationUrl,
    ...summary
  } = conversation;
  return summary.channel && PUBLIC_MOCK_CHANNEL_IDS.has(summary.channel)
    ? { ...summary, locationId: `mock:${summary.channel}` }
    : summary;
}

function mockConversationFeed(nowMs: number): ConversationFeed {
  return {
    source: "conversation_index",
    generatedAt: iso(nowMs),
    conversations: mockConversations(nowMs)
      .filter((conversation) => !conversation.parentConversationId)
      .map(summaryFromConversation),
  };
}

function summaryTokenTotal(summary: ConversationSummaryReport): number {
  const usage = summary.cumulativeUsage;
  return (
    (usage?.inputTokens ?? 0) +
    (usage?.outputTokens ?? 0) +
    (usage?.cachedInputTokens ?? 0) +
    (usage?.cacheCreationTokens ?? 0)
  );
}

function statsItem(label: string): ConversationStatsItem {
  return { active: 0, conversations: 0, durationMs: 0, failed: 0, label };
}

function addSummary(
  item: ConversationStatsItem,
  summary: ConversationSummaryReport,
) {
  item.active += summary.status === "active" ? 1 : 0;
  item.conversations += 1;
  item.durationMs += summary.cumulativeDurationMs;
  item.failed += summary.status === "failed" ? 1 : 0;
  const tokens = summaryTokenTotal(summary);
  if (tokens) item.tokens = (item.tokens ?? 0) + tokens;
  const cost = summary.cumulativeUsage?.cost?.total;
  if (cost !== undefined) item.costUsd = (item.costUsd ?? 0) + cost;
}

function locationLabel(summary: ConversationSummaryReport): string {
  if (summary.channel?.startsWith("C")) {
    return summary.channelName ? `#${summary.channelName}` : "Public Channel";
  }
  if (summary.channel?.startsWith("D")) return "Direct Message";
  return summary.surface === "scheduler" ? "Scheduler" : "Internal";
}

function actorLabel(identity: ActorIdentity | undefined): string {
  return (
    identity?.email ??
    identity?.fullName ??
    identity?.slackUserName ??
    "Unknown"
  );
}

function statsWindowStartMs(nowMs: number): number {
  const windowStart = new Date(nowMs);
  windowStart.setUTCHours(0, 0, 0, 0);
  windowStart.setUTCDate(windowStart.getUTCDate() - 89);
  return windowStart.getTime();
}

function windowBounds(nowMs: number) {
  return {
    windowEnd: iso(nowMs),
    windowStart: iso(statsWindowStartMs(nowMs)),
  };
}

function conversationMetricDays(
  nowMs: number,
  summaries: ConversationSummaryReport[],
): ConversationStatsReport["metricDays"] {
  const days = new Map<string, ConversationStatsReport["metricDays"][number]>();
  for (let offset = 89; offset >= 0; offset -= 1) {
    const date = new Date(nowMs);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    days.set(key, { date: key, durationMs: 0 });
  }
  for (const summary of summaries) {
    const day = days.get(summary.lastSeenAt.slice(0, 10));
    if (!day) continue;
    day.durationMs += summary.cumulativeDurationMs;
    const tokens = summaryTokenTotal(summary);
    if (tokens) day.tokens = (day.tokens ?? 0) + tokens;
    const costUsd = summary.cumulativeUsage?.cost?.total;
    if (costUsd !== undefined) {
      day.costUsd = (day.costUsd ?? 0) + costUsd;
    }
  }
  return [...days.values()];
}

/** Return the explicit canonical-event visual-QA feed, optionally scoped by actor. */
export function readMockConversationFeed(
  actorEmail?: string,
): ConversationFeed {
  const feed = mockConversationFeed(Date.now());
  if (!actorEmail) return feed;
  return {
    ...feed,
    conversations: feed.conversations.filter(
      (conversation) =>
        conversation.actorIdentity?.email?.toLowerCase() ===
        actorEmail.toLowerCase(),
    ),
  };
}

/** Return one canonical-event visual-QA conversation detail fixture. */
export function readMockConversationDetail(
  conversationId: string,
): ConversationDetailReport | undefined {
  const conversation = mockConversations(Date.now()).find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;
  const { parentConversationId: _parentConversationId, ...detail } =
    conversation;
  return detail.channel && PUBLIC_MOCK_CHANNEL_IDS.has(detail.channel)
    ? { ...detail, locationId: `mock:${detail.channel}` }
    : detail;
}

/** Build mock dashboard stats from canonical-event mock conversations. */
export function readMockConversationStats(): ConversationStatsReport {
  const nowMs = Date.now();
  const windowStartMs = statsWindowStartMs(nowMs);
  const summaries = mockConversationFeed(nowMs).conversations.filter(
    (summary) => {
      const lastSeenAtMs = Date.parse(summary.lastSeenAt);
      return lastSeenAtMs >= windowStartMs && lastSeenAtMs <= nowMs;
    },
  );
  const total = statsItem("All conversations");
  const actorItems = new Map<string, ConversationStatsItem>();
  const locationItems = new Map<string, ConversationStatsItem>();
  for (const summary of summaries) {
    addSummary(total, summary);
    const actorName = actorLabel(summary.actorIdentity);
    const actorItem = actorItems.get(actorName) ?? statsItem(actorName);
    addSummary(actorItem, summary);
    actorItems.set(actorName, actorItem);
    const place = locationLabel(summary);
    const locationItem = locationItems.get(place) ?? statsItem(place);
    addSummary(locationItem, summary);
    locationItems.set(place, locationItem);
  }
  return {
    active: total.active,
    actors: [...actorItems.values()],
    conversations: total.conversations,
    costUsd: total.costUsd,
    durationMs: total.durationMs,
    failed: total.failed,
    generatedAt: iso(nowMs),
    locations: [...locationItems.values()],
    metricDays: conversationMetricDays(nowMs, summaries),
    source: "conversation_index",
    tokens: total.tokens,
    ...windowBounds(nowMs),
  };
}

function mockPeopleActivityDays(
  nowMs: number,
  summaries: ConversationSummaryReport[],
): PeopleActivityDayReport[] {
  const byDate = new Map<
    string,
    { actors: Set<string>; conversations: number }
  >();
  for (const summary of summaries) {
    const email = summary.actorIdentity?.email?.toLowerCase();
    if (!email) continue;
    const date = summary.lastSeenAt.slice(0, 10);
    const day = byDate.get(date) ?? {
      actors: new Set<string>(),
      conversations: 0,
    };
    day.actors.add(email);
    day.conversations += 1;
    byDate.set(date, day);
  }
  return activityDates(nowMs, PEOPLE_ACTIVITY_DAYS).map((date) => ({
    activePeople: byDate.get(date)?.actors.size ?? 0,
    conversations: byDate.get(date)?.conversations ?? 0,
    date,
  }));
}

function activityDates(nowMs: number, days = PEOPLE_ACTIVITY_DAYS): string[] {
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - (days - 1 - index));
    return date.toISOString().slice(0, 10);
  });
}

/** Build mock People analytics from canonical-event mock conversations. */
export function readMockPeopleDirectory(): ActorDirectoryReport {
  const nowMs = Date.now();
  const summaries = mockConversationFeed(nowMs).conversations;
  const byEmail = new Map<
    string,
    ActorSummaryReport & { dates: Set<string> }
  >();
  for (const summary of summaries) {
    const identity = summary.actorIdentity;
    const email = identity?.email?.toLowerCase();
    if (!identity || !email) continue;
    const existing = byEmail.get(email) ?? {
      active: 0,
      activeDays: 0,
      actor: { ...identity, email },
      conversations: 0,
      dates: new Set<string>(),
      durationMs: 0,
      failed: 0,
      firstSeenAt: summary.startedAt,
      lastSeenAt: summary.lastSeenAt,
    };
    existing.active += summary.status === "active" ? 1 : 0;
    existing.conversations += 1;
    existing.dates.add(summary.lastSeenAt.slice(0, 10));
    existing.activeDays = existing.dates.size;
    existing.durationMs += summary.cumulativeDurationMs;
    existing.failed += summary.status === "failed" ? 1 : 0;
    existing.firstSeenAt =
      Date.parse(summary.startedAt) < Date.parse(existing.firstSeenAt)
        ? summary.startedAt
        : existing.firstSeenAt;
    existing.lastSeenAt =
      Date.parse(summary.lastSeenAt) > Date.parse(existing.lastSeenAt)
        ? summary.lastSeenAt
        : existing.lastSeenAt;
    const tokens = summaryTokenTotal(summary);
    if (tokens) existing.tokens = (existing.tokens ?? 0) + tokens;
    byEmail.set(email, existing);
  }
  const activityDays = mockPeopleActivityDays(nowMs, summaries);
  return {
    activityDays,
    generatedAt: iso(nowMs),
    people: [...byEmail.values()]
      .map(({ dates: _dates, ...person }) => person)
      .sort(
        (left, right) =>
          Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt),
      ),
    source: "conversation_index",
    windowEnd: `${activityDays.at(-1)!.date}T00:00:00.000Z`,
    windowStart: `${activityDays[0]!.date}T00:00:00.000Z`,
  };
}

/** Build one mock People profile from canonical-event mock conversations. */
export function readMockPeopleProfile(
  email: string,
): ActorProfileReport | undefined {
  const nowMs = Date.now();
  const normalized = email.toLowerCase();
  const summaries = mockConversationFeed(nowMs).conversations.filter(
    (summary) => summary.actorIdentity?.email?.toLowerCase() === normalized,
  );
  const identity = summaries[0]?.actorIdentity;
  if (!identity) return undefined;
  const totals: ActorProfileReport["totals"] = {
    active: 0,
    activeDays: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
  };
  const activeDates = new Set<string>();
  const sparseDays = new Map<string, ActorActivityDayReport>();
  const locations = new Map<string, ConversationStatsItem>();
  const surfaces = new Map<string, ConversationStatsItem>();
  for (const summary of summaries) {
    totals.active += summary.status === "active" ? 1 : 0;
    totals.conversations += 1;
    totals.durationMs += summary.cumulativeDurationMs;
    totals.failed += summary.status === "failed" ? 1 : 0;
    const tokens = summaryTokenTotal(summary);
    if (tokens) totals.tokens = (totals.tokens ?? 0) + tokens;

    const date = summary.lastSeenAt.slice(0, 10);
    activeDates.add(date);
    const day = sparseDays.get(date) ?? {
      active: 0,
      conversations: 0,
      date,
      durationMs: 0,
      failed: 0,
    };
    day.active += summary.status === "active" ? 1 : 0;
    day.conversations += 1;
    day.durationMs += summary.cumulativeDurationMs;
    day.failed += summary.status === "failed" ? 1 : 0;
    if (tokens) day.tokens = (day.tokens ?? 0) + tokens;
    sparseDays.set(date, day);

    const place = locationLabel(summary);
    const location = locations.get(place) ?? statsItem(place);
    addSummary(location, summary);
    locations.set(place, location);

    const surfaceLabel =
      summary.surface === "api"
        ? "API"
        : `${summary.surface.charAt(0).toUpperCase()}${summary.surface.slice(1)}`;
    const surface = surfaces.get(surfaceLabel) ?? statsItem(surfaceLabel);
    addSummary(surface, summary);
    surfaces.set(surfaceLabel, surface);
  }
  totals.activeDays = activeDates.size;
  const activityDays = activityDates(nowMs, PEOPLE_PROFILE_ACTIVITY_DAYS).map(
    (date): ActorActivityDayReport =>
      sparseDays.get(date) ?? {
        active: 0,
        conversations: 0,
        date,
        durationMs: 0,
        failed: 0,
      },
  );
  return {
    activityDays,
    generatedAt: iso(nowMs),
    locations: [...locations.values()].map(
      ({ costUsd: _costUsd, ...item }) => item,
    ),
    recentConversations: summaries.map(
      ({
        cumulativeUsage: _usage,
        sentryTraceUrl: _url,
        traceId: _trace,
        ...item
      }) => item,
    ),
    actor: { ...identity, email: normalized },
    source: "conversation_index",
    surfaces: [...surfaces.values()].map(
      ({ costUsd: _costUsd, ...item }) => item,
    ),
    totals,
    windowEnd: `${activityDays.at(-1)!.date}T00:00:00.000Z`,
    windowStart: `${activityDays[0]!.date}T00:00:00.000Z`,
  };
}

/** Find conversation time bounds without relying on feed order. */
export function conversationTimeBounds(
  summaries: readonly [
    ConversationSummaryReport,
    ...ConversationSummaryReport[],
  ],
): Pick<LocationSummaryReport, "firstSeenAt" | "lastSeenAt"> {
  let firstSeenAt = summaries[0].startedAt;
  let lastSeenAt = summaries[0].lastSeenAt;
  for (const summary of summaries) {
    if (Date.parse(summary.startedAt) < Date.parse(firstSeenAt)) {
      firstSeenAt = summary.startedAt;
    }
    if (Date.parse(summary.lastSeenAt) > Date.parse(lastSeenAt)) {
      lastSeenAt = summary.lastSeenAt;
    }
  }
  return { firstSeenAt, lastSeenAt };
}

function publicLocation(
  summaries: ConversationSummaryReport[],
  channel: string,
): LocationSummaryReport {
  const [first, ...rest] = summaries.filter(
    (summary) => summary.channel === channel,
  );
  if (!first) throw new Error(`Missing mock summaries for ${channel}`);
  const matching: [ConversationSummaryReport, ...ConversationSummaryReport[]] =
    [first, ...rest];
  const item = statsItem(locationLabel(first));
  for (const summary of matching) {
    addSummary(item, summary);
  }
  const bounds = conversationTimeBounds(matching);
  return {
    ...item,
    ...bounds,
    id: `mock:${channel}`,
    kind: "channel",
    provider: "slack",
    providerDestinationId: channel,
    visibility: "public",
  };
}

/** Build the mock public-location directory from canonical-event summaries. */
export function readMockLocationDirectory(): LocationDirectoryReport {
  const nowMs = Date.now();
  const summaries = mockConversationFeed(nowMs).conversations;
  const channels = [
    ...new Set(
      summaries
        .map((summary) => summary.channel)
        .filter((channel): channel is string =>
          Boolean(channel && PUBLIC_MOCK_CHANNEL_IDS.has(channel)),
        ),
    ),
  ];
  const privateActivity = statsItem("Private activity");
  const sparseActivity = new Map<string, LocationActivityDayReport>();
  for (const summary of summaries) {
    const isPublic = Boolean(
      summary.channel && PUBLIC_MOCK_CHANNEL_IDS.has(summary.channel),
    );
    const date = summary.lastSeenAt.slice(0, 10);
    const day = sparseActivity.get(date) ?? {
      date,
      privateConversations: 0,
      publicConversations: 0,
    };
    if (isPublic) day.publicConversations += 1;
    else {
      day.privateConversations += 1;
      addSummary(privateActivity, summary);
    }
    sparseActivity.set(date, day);
  }
  const activityDays = activityDates(nowMs).map(
    (date): LocationActivityDayReport =>
      sparseActivity.get(date) ?? {
        date,
        privateConversations: 0,
        publicConversations: 0,
      },
  );
  return {
    activityDays,
    generatedAt: iso(nowMs),
    locations: channels.map((channel) => publicLocation(summaries, channel)),
    privateActivity,
    source: "conversation_index",
    windowEnd: `${activityDays.at(-1)!.date}T00:00:00.000Z`,
    windowStart: `${activityDays[0]!.date}T00:00:00.000Z`,
  };
}

/** Build one mock public-location detail from canonical-event summaries. */
export function readMockLocationDetail(
  locationId: string,
): LocationDetailReport | undefined {
  const nowMs = Date.now();
  const directory = readMockLocationDirectory();
  const location = directory.locations.find((item) => item.id === locationId);
  if (!location) return undefined;
  const recentConversations = mockConversationFeed(nowMs).conversations.filter(
    (summary) => summary.channel === location.providerDestinationId,
  );
  const actorItems = new Map<string, LocationActorSummaryReport>();
  const sparseDays = new Map<
    string,
    LocationDetailReport["activityDays"][number]
  >();
  for (const summary of recentConversations) {
    const identity = summary.actorIdentity;
    const actorKey = identity?.email ?? identity?.slackUserId;
    if (identity && actorKey) {
      const actorItem = actorItems.get(actorKey) ?? {
        ...statsItem(actorLabel(identity)),
        actor: identity,
      };
      addSummary(actorItem, summary);
      actorItems.set(actorKey, actorItem);
    }
    const date = summary.lastSeenAt.slice(0, 10);
    const day = sparseDays.get(date) ?? {
      active: 0,
      conversations: 0,
      date,
      durationMs: 0,
      failed: 0,
    };
    day.active += summary.status === "active" ? 1 : 0;
    day.conversations += 1;
    day.durationMs += summary.cumulativeDurationMs;
    day.failed += summary.status === "failed" ? 1 : 0;
    const tokens = summaryTokenTotal(summary);
    if (tokens) day.tokens = (day.tokens ?? 0) + tokens;
    sparseDays.set(date, day);
  }
  const activityDays = activityDates(nowMs).map(
    (date): LocationDetailReport["activityDays"][number] =>
      sparseDays.get(date) ?? {
        active: 0,
        conversations: 0,
        date,
        durationMs: 0,
        failed: 0,
      },
  );
  return {
    ...location,
    activityDays,
    actors: [...actorItems.values()].sort(
      (left, right) =>
        right.conversations - left.conversations ||
        left.label.localeCompare(right.label),
    ),
    generatedAt: iso(nowMs),
    recentConversations,
    source: "conversation_index",
    windowEnd: `${activityDays.at(-1)!.date}T00:00:00.000Z`,
    windowStart: `${activityDays[0]!.date}T00:00:00.000Z`,
  };
}
