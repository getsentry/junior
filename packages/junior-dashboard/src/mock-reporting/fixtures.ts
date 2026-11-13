import { mockAutomationCollection } from "./automation-collection";
/** Deterministic reporting fixtures for local dashboard development and QA. */
import type {
  ActorDirectoryReport,
  ActorDirectoryWindows,
  ActorActivityDayReport,
  ActorIdentity,
  ActorProfileReport,
  ActorSummaryReport,
  ActorWindowMetrics,
  ConversationChildAgentsReport,
  ConversationDetailReport,
  ConversationEventPage,
  ConversationFeed,
  ConversationFeedItem,
  ConversationPendingMessagesReport,
  ConversationReportEvent,
  ConversationReportEventData,
  ConversationStatsItem,
  ConversationStatsReport,
  ConversationSummaryReport,
  CodeOverviewReport,
  CodePersonReport,
  LocationDetailReport,
  LocationActorSummaryReport,
  LocationActivityDayReport,
  LocationDirectoryReport,
  LocationSummaryReport,
  PeopleActivityDayReport,
  PersonalSpendReport,
  PluginOperationalReportFeed,
  AutomationExecutionList,
  AutomationList,
  AutomationSummary,
} from "@sentry/junior/api/schema";
import { mockQuestionConversations } from "./review-items";
import { isUnlistedMockConversation, withMockSends } from "./sends";

/** Fixed current time for mock reports and browser tests. */
export const NOW = "2026-08-07T12:00:00.000Z";
/** Milliseconds for {@link NOW}. */
export const NOW_MS = Date.parse(NOW);

/** Build code activity for local dashboard development and QA. */
export function readMockCodeOverview(nowMs = NOW_MS): CodeOverviewReport {
  const windowEnd = new Date(nowMs).toISOString();
  const windowStart = new Date(nowMs - 30 * 86_400_000).toISOString();
  const activityDays = Array.from({ length: 90 }, (_, index) => {
    const date = new Date(nowMs - (89 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const created = index === 84 || index === 88 ? 1 : index === 83 ? 2 : 0;
    const merged = index === 86 ? 1 : 0;
    const closed = index === 85 ? 1 : 0;
    return { closed, created, date, merged };
  });
  return {
    activityDays,
    changes: [
      {
        draft: true,
        id: "00000000-0000-4000-8000-000000000001",
        number: 42,
        openedAt: new Date(nowMs - 2 * 86_400_000).toISOString(),
        provider: "github",
        repository: "getsentry/payments",
        state: "open",
        title: "Reduce checkout latency",
        url: "https://github.com/getsentry/payments/pull/42",
      },
      {
        draft: false,
        id: "00000000-0000-4000-8000-000000000002",
        mergedAt: new Date(nowMs - 4 * 86_400_000).toISOString(),
        number: 781,
        openedAt: new Date(nowMs - 6 * 86_400_000).toISOString(),
        provider: "github",
        repository: "getsentry/junior",
        state: "merged",
        title: "Keep repository context across turns",
        url: "https://github.com/getsentry/junior/pull/781",
      },
    ],
    generatedAt: windowEnd,
    repositories: [
      {
        closed: 1,
        created: 5,
        id: "00000000-0000-4000-8000-000000000003",
        medianCostUsd: 4.25,
        merged: 4,
        mergeRate: 4 / 5,
        name: "getsentry/junior",
        open: 1,
        provider: "github",
        url: "https://github.com/getsentry/junior",
      },
      {
        closed: 0,
        created: 3,
        id: "00000000-0000-4000-8000-000000000004",
        medianCostUsd: 2.1,
        merged: 2,
        mergeRate: 1,
        name: "getsentry/payments",
        open: 1,
        provider: "github",
        url: "https://github.com/getsentry/payments",
      },
    ],
    summary: {
      closed: 1,
      costUsd: 18.4,
      created: 8,
      medianCostUsd: 3.5,
      medianMergeTimeMs: 2 * 86_400_000,
      merged: 6,
      mergeRate: 6 / 7,
      open: 2,
    },
    windowEnd,
    windowStart,
  };
}

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
// Mock text links to dashboard pages on this origin.
const MOCK_DASHBOARD_ORIGIN = "https://junior.example.com";
const INCIDENT_CONVERSATION_ID = "slack:CQA123:1770000000.000100";
const PRIVATE_CONVERSATION_ID = "slack:DQA123:1770007200.000300";
const SANDBOX_CONVERSATION_ID = "slack:CQA999:1770010800.000400";
const FAILED_CONVERSATION_ID = "slack:CQA777:1770014400.000500";
const LONG_CONVERSATION_ID = "slack:CQA456:1770021600.000600";
const MANY_TURNS_CONVERSATION_ID = "slack:CQA456:1770025200.000700";
const SCHEDULER_CONVERSATION_ID = "scheduler:daily-ops-digest";
/** Event automation run. Its trigger message id equals the conversation id. */
const EVENT_AUTOMATION_RUN_CONVERSATION_ID = "agent-dispatch:event-1";
export const DASHBOARD_QA_CONVERSATION_ID = "internal:dashboard-qa";
export const ARCHIVED_CONVERSATION_ID = "internal:archived-restore-qa";
const DASHBOARD_QA_PLAN_ID = "junior:internal:dashboard-qa:advisor-plan";
const DASHBOARD_QA_REVIEW_ID = "junior:internal:dashboard-qa:advisor-review";
const DASHBOARD_QA_PLAN_CHECK_ID =
  "junior:internal:dashboard-qa:advisor-plan:claim-check";
export const DASHBOARD_QA_THREAD_ID = "junior:internal:dashboard-qa:thread";
export const DASHBOARD_QA_ARCHIVED_THREAD_ID =
  "junior:internal:dashboard-qa:archived-thread";
/** A Thread whose parent is the Thread above, not the root. */
const DASHBOARD_QA_NESTED_THREAD_ID =
  "junior:internal:dashboard-qa:thread:nested";
/** Process-local pins so the Pinned section can be exercised in visual QA. */
const mockPinnedConversationIds = new Set<string>();
/** Process-local Pinned order from drag reorders. */
const mockPinPositions = new Map<string, number>();

/** Process-local renames so rename can be exercised in visual QA. */
const mockTitles = new Map<string, string>();

/** Process-local attached links, newest first, like the attach API. */
const mockAttachedAnnotations = new Map<
  string,
  NonNullable<ConversationDetailReport["annotations"]>
>();

/** Process-local auto-archive choices for mock visual QA. */
const mockAutoArchiveByConversationId = new Map<string, boolean>();

/** Process-local unsubscribes for mock visual QA. */
const mockUnsubscribedConversationIds = new Set<string>();

/** Process-local Slack detaches for mock visual QA. */
const mockDeliveryPausedConversationIds = new Set<string>();

/** Process-local archives. Like the API, an archive applies to everyone. */
const initialMockArchives: [string, string][] = [
  [ARCHIVED_CONVERSATION_ID, iso(NOW_MS, -3 * 24 * 60 * 60_000)],
  [DASHBOARD_QA_ARCHIVED_THREAD_ID, iso(NOW_MS, -2 * 60 * 60_000)],
];
const mockArchivedAt = new Map(initialMockArchives);
let mockArchiveCount = 0;

/** Process-local Slack channels from Continue in Slack. */
const mockSlackChannelByConversationId = new Map<
  string,
  { channel: string; channelName: string }
>();

/**
 * Restore process-local archive, pin, and auto-archive state so
 * tests sharing a worker do not leak state.
 */
export function resetMockConversationViewerState(): void {
  mockPinnedConversationIds.clear();
  mockPinPositions.clear();
  mockTitles.clear();
  mockAttachedAnnotations.clear();
  mockAutoArchiveByConversationId.clear();
  mockUnsubscribedConversationIds.clear();
  mockDeliveryPausedConversationIds.clear();
  mockArchivedAt.clear();
  mockArchiveCount = 0;
  for (const [id, at] of initialMockArchives) mockArchivedAt.set(id, at);
  mockSlackChannelByConversationId.clear();
}

/**
 * Add the mock archive, the viewer's pin, and any rename to
 * one conversation. Like the API, a child reports the pin of its root.
 */
function withMockViewerState<
  T extends { conversationId: string; displayTitle: string; status: string },
>(
  report: T & { archivedAt?: string | null },
  pinConversationId = report.conversationId,
): T & {
  archivedAt: string | undefined;
  pinnedAt: string | null;
  pinPosition?: number;
} {
  const pinPosition = mockPinPositions.get(pinConversationId);
  return {
    ...report,
    displayTitle: mockTitles.get(report.conversationId) ?? report.displayTitle,
    archivedAt: mockArchivedAt.get(report.conversationId),
    pinnedAt: mockPinnedConversationIds.has(pinConversationId) ? NOW : null,
    ...(pinPosition === undefined ? undefined : { pinPosition }),
  };
}

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

function slackLocationUrl(channelId: string, threadTs: string): string {
  const [seconds, fraction = ""] = threadTs.split(".");
  const pathTs = `p${seconds}${(fraction ?? "").padEnd(6, "0").slice(0, 6)}`;
  return `https://sentry.slack.com/archives/${channelId}/${pathTs}?thread_ts=${threadTs}&cid=${channelId}`;
}

function reportEvent(
  seq: number,
  createdAt: string,
  data: ConversationReportEventData,
  metadata?: Pick<ConversationReportEvent, "mentions" | "model" | "modelCall">,
): ConversationReportEvent {
  return { seq, createdAt, data, ...metadata };
}

type DetailOptions = Omit<
  ConversationDetailReport,
  | "cumulativeDurationMs"
  | "displayTitle"
  | "eventHistory"
  | "events"
  | "generatedAt"
  | "isParticipant"
  | "kind"
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
  isParticipant?: boolean;
  kind?: ConversationDetailReport["kind"];
  lastProgressAt?: string;
  lastSeenAt?: string;
  startedAt: string;
  status?: ConversationDetailReport["status"];
  surface?: ConversationDetailReport["surface"];
};

type MockConversation = ConversationDetailReport;

function detail(
  nowMs: number,
  options: DetailOptions,
): ConversationDetailReport {
  return {
    ...options,
    cumulativeDurationMs: options.cumulativeDurationMs ?? 0,
    eventHistory: options.eventHistory ?? { status: "available" },
    generatedAt: iso(nowMs),
    isParticipant: options.isParticipant ?? false,
    kind: options.kind ?? "root",
    lastProgressAt: options.lastProgressAt ?? options.startedAt,
    lastSeenAt: options.lastSeenAt ?? options.startedAt,
    status: options.status ?? "completed",
    surface: options.surface ?? "internal",
  };
}

function mockBrief(
  nowMs: number,
  kind: "live" | "expired",
): NonNullable<ConversationDetailReport["brief"]> {
  const live = kind === "live";
  const startedAt = iso(nowMs, live ? -6 * 60_000 : -44 * 60_000);
  const updatedAt = iso(nowMs, live ? -60_000 : -41 * 60_000);
  return {
    content: {
      schemaVersion: 1,
      record: {
        startedAt,
        lastActivityAt: updatedAt,
        durationMs: live ? 5 * 60_000 : 3 * 60_000,
        participants: [{ name: "Morgan Lee", messages: live ? 2 : 1 }],
        userMessages: live ? 2 : 1,
        assistantMessages: 1,
        toolResults: live ? 2 : 1,
        events: 0,
        turns: live ? 2 : 1,
        location: { provider: "slack", channelName: "proj-checkout" },
        codeChanges: [
          {
            repository: "getsentry/payments",
            number: live ? 42 : 77,
            title: live
              ? "Reduce checkout latency"
              : "Roll back the checkout regression",
            url: live
              ? "https://github.com/getsentry/payments/pull/42"
              : "https://github.com/getsentry/payments/pull/77",
            state: live ? "open" : "merged",
            openedAt: startedAt,
            mergedAt: live ? undefined : updatedAt,
          },
        ],
      },
      summary: live
        ? "Checkout p95 rose after payments-v42. Junior linked the spike to the slow serializer path and is comparing deployment spans before a rollback decision."
        : "The checkout regression was traced to payments-v42. The team chose to roll it back and merged the change that restored normal latency.",
      intent: live
        ? "Find the slow checkout requests from the last deployment and compare the pre-deploy and post-deploy spans."
        : "Draft the rollback note with the exact evidence for the checkout latency regression.",
      outcome: live
        ? {
            status: "in_progress",
            text: "The deployment correlation is confirmed. The span comparison is still running.",
          }
        : {
            status: "done",
            text: "The rollback note was completed and the rollback change was merged.",
          },
      decisions: live
        ? [
            {
              text: "Compare the pre-deploy and post-deploy spans before choosing a rollback.",
              by: "Morgan Lee",
              kind: "stated",
            },
            {
              text: "Use checkout.complete p95 as the primary comparison signal.",
              by: "Junior",
              kind: "assumed",
            },
          ]
        : [
            {
              text: "Roll back payments-v42 instead of patching the serializer in place.",
              by: "Morgan Lee",
              kind: "confirmed",
            },
          ],
      facts: live
        ? [
            "Checkout p95 increased from 210ms to 890ms.",
            "Error volume stayed flat during the latency increase.",
          ]
        : [
            "PAYMENTS-42 contained 418 events.",
            "The regression started with payments-v42.",
          ],
      links: [
        {
          kind: "code_change",
          label: `getsentry/payments#${live ? 42 : 77}`,
          url: live
            ? "https://github.com/getsentry/payments/pull/42"
            : "https://github.com/getsentry/payments/pull/77",
          status: live ? "open" : "merged",
        },
        {
          kind: "resource",
          label: "Checkout latency dashboard",
          url: "https://sentry.example.com/organizations/acme/explore/traces/",
          status: live ? "open" : "resolved",
        },
      ],
      keywords: ["checkout", "latency", "payments-v42", "rollback"],
    },
    updatedAt,
    version: live ? 2 : 3,
  };
}

function activeConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -6 * 60_000);
  return detail(nowMs, {
    conversationId: ACTIVE_CONVERSATION_ID,
    displayTitle: "Investigate checkout latency",
    brief: mockBrief(nowMs, "live"),
    // Visual QA needs the composer + pending mailbox stack attached above it.
    isParticipant: true,
    startedAt,
    lastProgressAt: iso(nowMs, -20_000),
    lastSeenAt: iso(nowMs, -10_000),
    status: "active",
    surface: "slack",
    channel: "CQA123",
    channelName: "proj-checkout",
    actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
    participants: [
      actor("dev@example.com", "Morgan Lee", "morgan"),
      actor("avery@sentry.io", "Avery Chen", "avery"),
      actor("riley@sentry.io", "Riley Park", "riley"),
      actor("jordan@sentry.io", "Jordan Blake", "jordan"),
    ],
    assignedWork: true,
    unfinishedWork: true,
    isPriority: true,
    sidebarAnnotations: [
      {
        icon: "git-pull-request",
        key: "getsentry/payments#42",
        label: "payments",
      },
    ],
    annotations: [
      {
        kind: "object",
        key: "getsentry/payments#42",
        label: "getsentry/payments#42",
        title: "Retry checkout writes after lock timeouts",
        displayType: "Pull request",
        objectType: "code_change",
        plugin: "github",
        status: "open",
        url: "https://github.com/getsentry/payments/pull/42",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 12_000),
      },
    ],
    auxiliaryCosts: {
      costUsd: 0.003,
      operations: [
        {
          costUsd: 0.0009,
          events: 2,
          name: "compaction",
          namespace: "junior",
        },
        {
          costUsd: 0.0001,
          events: 1,
          name: "turn_routed",
          namespace: "junior",
        },
        {
          costUsd: 0.0002,
          events: 2,
          name: "passive_reply_routed",
          namespace: "junior",
        },
        {
          costUsd: 0.0012,
          events: 3,
          name: "guardian_action_reviewed",
          namespace: "junior",
        },
        {
          costUsd: 0.0002,
          events: 2,
          name: "memories_captured",
          namespace: "memory",
        },
        {
          costUsd: 0.0004,
          events: 6,
          name: "memories_recalled",
          namespace: "memory",
        },
      ],
    },
    cumulativeDurationMs: 31_000,
    cumulativeUsage: usage(0.041),
    sandboxCostUsd: 0.0092,
    modelUsage: [
      {
        modelId: "openai/gpt-5.6-sol",
        usage: usage(0.041),
      },
    ],
    sentryConversationUrl: sentryConversationUrl(ACTIVE_CONVERSATION_ID),
    locationUrl: slackLocationUrl("CQA123", "1770003600.000200"),
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
        type: "turn_context",
        turnId: "active-turn",
        pluginName: "memory",
        kind: "recall",
        version: 1,
        content: {
          memories: [
            {
              id: "memory-checkout-runbook",
              content:
                "Checkout latency investigations start with the deployment comparison dashboard.",
              observedAtMs: Date.parse(startedAt) - 86_400_000,
              scope: "conversation",
              kind: "procedure",
            },
          ],
        },
      }),
      reportEvent(
        3,
        iso(Date.parse(startedAt), 9_000),
        {
          type: "assistant_message",
          parts: [
            {
              type: "reasoning",
              text: "Compare the latest deploy with the previous baseline.",
            },
          ],
        },
        {
          model: { modelId: "openai/gpt-5.6-sol" },
          modelCall: {
            provider: "vercel-ai-gateway",
            api: "openai-responses",
            stopReason: "toolUse",
          },
        },
      ),
      reportEvent(
        4,
        iso(Date.parse(startedAt), 10_000),
        {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "active-search",
              name: "webSearch",
              status: "running",
            },
          ],
        },
        {
          model: { modelId: "openai/gpt-5.6-sol" },
          modelCall: {
            provider: "vercel-ai-gateway",
            api: "openai-responses",
            stopReason: "toolUse",
            usage: {
              inputTokens: 12500,
              outputTokens: 800,
              cachedInputTokens: 32000,
              cacheCreationTokens: 2000,
              reasoningTokens: 600,
              totalTokens: 47300,
              cost: {
                input: 0.025,
                output: 0.008,
                cacheRead: 0.0064,
                cacheWrite: 0.005,
                total: 0.0444,
              },
            },
          },
        },
      ),
      reportEvent(
        5,
        iso(Date.parse(startedAt), 14_000),
        {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "active-search",
              name: "webSearch",
              status: "completed",
              startedSeq: 4,
              startedAt: iso(Date.parse(startedAt), 10_000),
              input: { query: "checkout latency last deployment" },
              output: {
                results: [
                  {
                    title: "payments-v42 deploy notes",
                    url: "https://docs.sentry.io",
                  },
                ],
              },
            },
          ],
        },
        {
          model: { modelId: "openai/gpt-5.6-sol" },
        },
      ),
      // Mixed markdown keeps font/legibility QA honest for long assistant replies.
      reportEvent(6, iso(Date.parse(startedAt), 22_000), {
        type: "message",
        messageId: "active-assistant",
        role: "assistant",
        text: [
          "Checkout p95 jumped after **payments-v42** landed.",
          "",
          "What I checked:",
          "- deploy marker `payments-v42` correlates with the spike",
          "- canary hosts show the same `checkout.latency` shape",
          "- error volume is flat, so this looks like slow path not hard fail",
          "",
          "| Window | Region | Host class | p50 | p95 | p99 | Errors | Notes |",
          "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
          "| pre-deploy | us-west1 | canary + stable | 120ms | 210ms | 340ms | 0.4% | baseline |",
          "| post-deploy | us-west1 | stable | 310ms | **890ms** | 1.4s | 0.5% | spike after payments-v42 |",
          "| canary only | us-west1 | canary | 280ms | 860ms | 1.3s | 0.5% | same shape as stable |",
          "",
          "Useful query:",
          "```sql",
          "SELECT percentile(duration, 0.95) AS p95",
          "FROM transactions",
          "WHERE transaction = 'checkout.complete'",
          "  AND timestamp > now() - interval '2 hours'",
          "GROUP BY 1",
          "ORDER BY p95 DESC;",
          "```",
          "",
          "Next step: compare the pre/post deploy spans, then decide whether to",
          "roll back or patch the slow serializer path.",
        ].join("\n"),
      }),
      reportEvent(7, iso(Date.parse(startedAt), 40_000), {
        type: "message",
        messageId: "active-user-followup",
        role: "user",
        // Quoted reply keeps blockquote and nested-list rendering in visual QA.
        text: [
          "> error volume is flat, so this looks like slow path not hard fail",
          "",
          "Agreed. Compare the pre/post deploy spans next:",
          "1. `checkout.complete` p95",
          "   - stable hosts",
          "   - canary hosts",
          "2. ~~error rate~~ serializer span time",
        ].join("\n"),
      }),
      reportEvent(8, iso(Date.parse(startedAt), 42_000), {
        type: "turn_lifecycle",
        turnId: "active-followup-turn",
        state: "started",
      }),
      reportEvent(9, iso(Date.parse(startedAt), 45_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "active-span-compare",
            name: "executeTool",
            status: "running",
            input: {
              tool_name: "github_getPullRequest",
              arguments: { repo: "getsentry/payments", number: 42 },
            },
          },
        ],
        // The running step shows its reasoning while the activity is closed.
        assistant: {
          parts: [
            {
              type: "reasoning",
              text: "Read the payments-v42 pull request first, so the span comparison focuses on the serializer path it changed.",
            },
            { type: "tool_call", toolCallId: "active-span-compare" },
          ],
        },
      }),
      reportEvent(10, iso(Date.parse(startedAt), 46_000), {
        type: "turn_context",
        turnId: "active-turn",
        pluginName: "junior",
        kind: "user_customization",
        version: 1,
        content: {
          text: "Keep replies short and simple.\nLead with the answer, then the evidence.",
        },
      }),
    ],
  });
}

function dashboardQaConversation(nowMs: number): ConversationDetailReport {
  // Finished work stays in Today even when it was active in the last 24 hours.
  const startedAt = iso(nowMs, -5 * 60 * 60_000);
  return detail(nowMs, {
    conversationId: DASHBOARD_QA_CONVERSATION_ID,
    displayTitle: "Dashboard QA edge cases",
    startedAt,
    lastSeenAt: iso(nowMs, -4 * 60 * 60_000),
    lastProgressAt: iso(nowMs, -4 * 60 * 60_000),
    actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
    assignedWork: true,
    unfinishedWork: true,
    isPriority: true,
    // Newest-first GitHub sidebar order with mixed finished/unfinished work for
    // the same label. Badges keep every status icon under one shared label.
    sidebarAnnotations: [
      {
        icon: "git-merge",
        key: "getsentry/getsentry#21571",
        label: "getsentry",
      },
      {
        icon: "git-pull-request",
        key: "getsentry/getsentry#21572",
        label: "getsentry",
      },
      {
        icon: "circle-dashed",
        key: "getsentry/getsentry#21569",
        label: "getsentry",
      },
      {
        icon: "git-merge",
        key: "getsentry/sentry#121727",
        label: "sentry",
      },
    ],
    annotations: [
      {
        kind: "resource_link",
        key: "getsentry/getsentry#21571",
        label: "getsentry/getsentry#21571",
        objectType: "code_change",
        plugin: "github",
        status: "merged",
        url: "https://github.com/getsentry/getsentry/pull/21571",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 52_000),
      },
      {
        kind: "resource_link",
        key: "getsentry/getsentry#21572",
        label: "getsentry/getsentry#21572",
        objectType: "code_change",
        plugin: "github",
        status: "open",
        url: "https://github.com/getsentry/getsentry/pull/21572",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 40_000),
      },
      {
        kind: "resource_link",
        key: "getsentry/getsentry#21569",
        label: "getsentry/getsentry#21569",
        objectType: "code_change",
        plugin: "github",
        status: "draft",
        url: "https://github.com/getsentry/getsentry/pull/21569",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 30_000),
      },
      {
        kind: "resource_link",
        key: "getsentry/sentry#121727",
        label: "getsentry/sentry#121727",
        objectType: "code_change",
        plugin: "github",
        status: "merged",
        url: "https://github.com/getsentry/sentry/pull/121727",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 20_000),
      },
    ],
    // Totals include all three subagents, like the API.
    childAgentTotals: {
      count: 3,
      cumulativeDurationMs: 88_400,
      cumulativeUsage: {
        inputTokens: 48_700,
        outputTokens: 2_680,
        cachedInputTokens: 21_600,
        cost: { total: 0.172 },
      },
    },
    cumulativeDurationMs: 186_400,
    cumulativeUsage: {
      inputTokens: 100_700,
      outputTokens: 6_080,
      cachedInputTokens: 51_600,
      cost: { total: 0.382 },
    },
    events: [
      reportEvent(0, startedAt, {
        type: "message",
        messageId: "qa-user",
        source: "slack",
        attachments: [
          {
            id: "qa-chart-png",
            filename: "input-chart.png",
            contentType: "image/png",
            bytes: 6400,
          },
          // Large Slack files that Junior never stores.
          {
            id: "qa-recording-pending",
            filename: "standup-recording.mp4",
            contentType: "video/mp4",
            bytes: 214_000_000,
            pending: true,
          },
          {
            id: "qa-deleted-pending",
            filename: "deleted-recording.mov",
            contentType: "video/quicktime",
            bytes: 98_000_000,
            pending: true,
          },
        ],
        role: "user",
        text: "Review the dashboard plan before editing.",
        actorIdentity: actor(undefined, "Taylor Chen", "taylor"),
      }),
      reportEvent(1, iso(Date.parse(startedAt), 2_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "qa-advisor",
            name: "spawnAgent",
            status: "running",
          },
        ],
      }),
      reportEvent(2, iso(Date.parse(startedAt), 3_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "qa-advisor",
            name: "spawnAgent",
            status: "running",
            startedSeq: 1,
            startedAt: iso(Date.parse(startedAt), 2_000),
            input: { task: "Review the dashboard plan before editing." },
          },
        ],
      }),
      reportEvent(3, iso(Date.parse(startedAt), 4_000), {
        type: "subagent",
        startedSeq: 3,
        startedAt: iso(Date.parse(startedAt), 4_000),
        childConversationId: DASHBOARD_QA_PLAN_ID,
        childKind: "task",
        subagentKind: "agent",
        agentName: "planner",
        task: "Review the dashboard plan before editing.",
        title: "Review the dashboard plan",
        parentToolCallId: "qa-advisor",
        status: "running",
      }),
      reportEvent(4, iso(Date.parse(startedAt), 20_000), {
        type: "subagent",
        startedSeq: 3,
        startedAt: iso(Date.parse(startedAt), 4_000),
        childConversationId: DASHBOARD_QA_PLAN_ID,
        childKind: "task",
        subagentKind: "agent",
        agentName: "planner",
        task: "Review the dashboard plan before editing.",
        title: "Review the dashboard plan",
        parentToolCallId: "qa-advisor",
        status: "completed",
      }),
      reportEvent(5, iso(Date.parse(startedAt), 21_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "qa-advisor",
            name: "spawnAgent",
            status: "completed",
            startedSeq: 1,
            startedAt: iso(Date.parse(startedAt), 2_000),
            output: { conversation_id: DASHBOARD_QA_PLAN_ID },
          },
        ],
      }),
      reportEvent(6, iso(Date.parse(startedAt), 25_000), {
        type: "subagent",
        startedSeq: 6,
        startedAt: iso(Date.parse(startedAt), 25_000),
        childConversationId: DASHBOARD_QA_REVIEW_ID,
        childKind: "task",
        subagentKind: "agent",
        agentName: "reviewer",
        status: "running",
      }),
      reportEvent(7, iso(Date.parse(startedAt), 44_000), {
        type: "subagent",
        startedSeq: 6,
        startedAt: iso(Date.parse(startedAt), 25_000),
        childConversationId: DASHBOARD_QA_REVIEW_ID,
        childKind: "task",
        subagentKind: "agent",
        agentName: "reviewer",
        status: "blocked",
      }),
      reportEvent(8, iso(Date.parse(startedAt), 50_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "qa-load-skill",
            name: "loadSkill",
            status: "running",
            startedSeq: 8,
            startedAt: iso(Date.parse(startedAt), 50_000),
            input: { skill_name: "junior-qa" },
          },
          {
            toolCallId: "qa-execute-tool",
            name: "executeTool",
            status: "running",
            startedSeq: 8,
            startedAt: iso(Date.parse(startedAt), 50_000),
            input: {
              tool_name: "github_search",
              arguments: { query: "is:pr is:open", limit: 25 },
            },
          },
        ],
        assistant: {
          parts: [
            {
              type: "reasoning",
              text: "Load the dashboard QA skill before inspecting the reporting surface.",
            },
            { type: "tool_call", toolCallId: "qa-load-skill" },
            {
              type: "reasoning",
              text: "Search the repository so the review covers the current pull request state.",
            },
            { type: "tool_call", toolCallId: "qa-execute-tool" },
          ],
        },
      }),
      reportEvent(9, iso(Date.parse(startedAt), 52_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "qa-load-skill",
            name: "loadSkill",
            status: "completed",
            startedSeq: 8,
            startedAt: iso(Date.parse(startedAt), 50_000),
            input: { skill_name: "junior-qa" },
            output: { skill_name: "junior-qa" },
          },
          {
            toolCallId: "qa-execute-tool",
            name: "executeTool",
            status: "completed",
            startedSeq: 8,
            startedAt: iso(Date.parse(startedAt), 50_000),
            input: {
              tool_name: "github_search",
              arguments: { query: "is:pr is:open", limit: 25 },
            },
            output: { matches: 3 },
          },
        ],
      }),
      reportEvent(10, iso(Date.parse(startedAt), 54_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "qa-bash",
            name: "bash",
            status: "error",
            input: {
              command: "jr-rpc config get github.repo",
              timeout_ms: 10_000,
            },
            output: { error: "configuration unavailable" },
          },
        ],
      }),
      reportEvent(11, iso(Date.parse(startedAt), 56_000), {
        type: "compaction",
        modelId: "openai/gpt-5.4",
        details: {
          reason: "capacity",
          estimatedInputTokens: 361_000,
          replacementInputTokens: 2_400,
          triggerTokens: 360_000,
          inputLimitTokens: 380_000,
          inputMessageCount: 42,
          retainedMessageCount: 2,
          summaryChars: 1_200,
        },
      }),
      reportEvent(12, iso(Date.parse(startedAt), 58_000), {
        type: "message",
        messageId: "qa-assistant",
        role: "assistant",
        text: "The canonical event rendering looks sound.",
      }),
      reportEvent(13, iso(Date.parse(startedAt), 60_000), {
        type: "structured_event",
        namespace: "memory",
        name: "memories_captured",
        version: 1,
        turnId: "qa-turn",
        presentation: {
          icon: "brain",
          title: "2 memories captured",
          details: [
            {
              title: "Use pnpm for repository commands.",
              metadata: ["preference", "personal"],
            },
            {
              title: "Dashboard transcript events should remain expandable.",
              metadata: ["knowledge", "conversation"],
            },
          ],
        },
      }),
      reportEvent(14, iso(Date.parse(startedAt), 62_000), {
        type: "structured_event",
        namespace: "junior",
        name: "agents_instructions_updated",
        version: 1,
        turnId: "qa-turn",
        presentation: {
          icon: "brain",
          title: "Loaded AGENTS.md",
          preview: "AGENTS.md · 2 KB",
          details: [
            {
              title: "AGENTS.md",
              content: `# Agent Instructions

## Core principles

- Use the words in \`TERMINOLOGY.md\`.
- Prefer functions, plain objects, simple types, and small modules.
- Optimize for the next maintainer.
- Use **pnpm** for repository commands.

## Testing

Run targeted tests before broad suites, and keep durable explanations beside the owning code.`,
            },
          ],
        },
      }),
      reportEvent(15, iso(Date.parse(startedAt), 63_000), {
        type: "attachments_delivered",
        attachments: [
          {
            id: "qa-chart-png",
            filename: "chart.png",
            contentType: "image/png",
            bytes: 18211,
          },
          {
            id: "qa-chart-png",
            filename: "chart-detail.png",
            contentType: "image/png",
            bytes: 18211,
          },
          {
            id: "qa-demo-mp4",
            filename: "demo.mp4",
            contentType: "video/mp4",
            bytes: 5922,
          },
          {
            id: "qa-notes-txt",
            filename: "notes.txt",
            contentType: "text/plain",
            bytes: 42,
          },
          {
            id: "qa-readme-md",
            filename: "README.md",
            contentType: "text/markdown",
            bytes: 173,
          },
        ],
      }),
      reportEvent(16, iso(Date.parse(startedAt), 64_000), {
        type: "message",
        messageId: "qa-unused-context",
        role: "user",
        text: "This ambient message must not appear in the transcript.",
        explicitMention: false,
        actorIdentity: actor(undefined, "Alex Rivera", "alex"),
      }),
      reportEvent(17, iso(Date.parse(startedAt), 66_000), {
        type: "message",
        messageId: "qa-used-context",
        role: "user",
        text: "Can you clarify which dashboard state you mean?",
        explicitMention: false,
        actorIdentity: actor(undefined, "Alex Rivera", "alex"),
      }),
      reportEvent(18, iso(Date.parse(startedAt), 67_000), {
        type: "turn_lifecycle",
        turnId: "qa-context-turn",
        state: "started",
        inputMessageIds: ["qa-used-context"],
      }),
      reportEvent(19, iso(Date.parse(startedAt), 69_000), {
        type: "message",
        messageId: "qa-context-answer",
        role: "assistant",
        text: "I mean the empty, loading, and failed transcript states.",
      }),
      // The reviewer card already shows this result, so the transcript
      // hides the row.
      reportEvent(20, iso(Date.parse(startedAt), 70_000), {
        type: "message",
        messageId: "qa-reviewer-result",
        role: "user",
        eventType: "agent_invocation.blocked",
        trustedSummary: 'Child agent "reviewer" is blocked.',
        text: "The reviewer needs access to the dashboard repository.",
      }),
      reportEvent(21, iso(Date.parse(startedAt), 80_000), {
        type: "message",
        messageId: "qa-github-review-comment",
        role: "user",
        eventType: "pull_request.review_comment.created",
        eventNamespace: "github",
        eventObjectType: "code_change",
        trustedSummary: "New review comment on getsentry/getsentry#21572.",
        text: "Can the empty state reuse the loading skeleton?",
      }),
      reportEvent(22, iso(Date.parse(startedAt), 86_000), {
        type: "reply_posted",
        plugin: "github",
        text: "Yes. The empty state now reuses the loading skeleton.",
        url: "https://github.com/getsentry/getsentry/pull/21572#discussion_r7",
      }),
      // Threads render as link cards. The archived one is not in the feed,
      // so its card falls back to what the parent recorded.
      reportEvent(23, iso(Date.parse(startedAt), 90_000), {
        type: "subagent",
        startedSeq: 23,
        startedAt: iso(Date.parse(startedAt), 90_000),
        childConversationId: DASHBOARD_QA_THREAD_ID,
        childKind: "thread",
        subagentKind: "agent",
        task: "Check pinned row order with the person who reported it.",
        title: "Check pinned row order",
        status: "completed",
      }),
      reportEvent(24, iso(Date.parse(startedAt), 92_000), {
        type: "subagent",
        startedSeq: 24,
        startedAt: iso(Date.parse(startedAt), 92_000),
        childConversationId: DASHBOARD_QA_ARCHIVED_THREAD_ID,
        childKind: "thread",
        subagentKind: "agent",
        task: "Compare the sidebar badges with the design.",
        title: "Compare sidebar badges",
        status: "completed",
      }),
    ],
  });
}

function advisorConversation(
  nowMs: number,
  conversationId: string,
  text: string,
  metrics: Pick<
    ConversationDetailReport,
    "childAgentTotals" | "cumulativeDurationMs" | "cumulativeUsage"
  >,
  parentConversationId = DASHBOARD_QA_CONVERSATION_ID,
): MockConversation {
  const startedAt = iso(nowMs, -10 * 60_000);
  const conversation = detail(nowMs, {
    conversationId,
    displayTitle: "Advisor review",
    // The viewer takes part, so QA shows that a Task still has no composer.
    isParticipant: true,
    // A child keeps the Actor who started it, but that person did not write
    // its agent invocation input.
    actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
    startedAt,
    lastSeenAt: iso(Date.parse(startedAt), 18_000),
    lastProgressAt: iso(Date.parse(startedAt), 18_000),
    ...metrics,
    events: [
      reportEvent(0, startedAt, {
        type: "message",
        messageId: `${conversationId}:input`,
        role: "user",
        agentInvocationId: `${conversationId}:invocation`,
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
    kind: "task",
    parentConversationId,
    archivedAt: mockArchivedAt.get(conversationId) ?? null,
  };
}

/**
 * A Thread in the dashboard QA tree. The parent agent starts its first Turn,
 * and a person starts the next one.
 */
function threadConversation(
  nowMs: number,
  conversationId: string,
  displayTitle: string,
  text: string,
  offsetMs: number,
  parentConversationId = DASHBOARD_QA_CONVERSATION_ID,
): MockConversation {
  const startedAt = iso(nowMs, offsetMs);
  return detail(nowMs, {
    conversationId,
    displayTitle,
    kind: "thread",
    // The viewer takes part, so QA shows that a person can message a Thread.
    isParticipant: true,
    parentConversationId,
    archivedAt: mockArchivedAt.get(conversationId) ?? null,
    actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
    startedAt,
    lastSeenAt: iso(Date.parse(startedAt), 30_000),
    lastProgressAt: iso(Date.parse(startedAt), 30_000),
    cumulativeDurationMs: 30_000,
    events: [
      reportEvent(0, startedAt, {
        type: "message",
        messageId: `${conversationId}:input`,
        role: "user",
        agentInvocationId: `${conversationId}:invocation`,
        text,
      }),
      reportEvent(1, iso(Date.parse(startedAt), 12_000), {
        type: "message",
        messageId: `${conversationId}:output`,
        role: "assistant",
        text: "Done. No differences found.",
      }),
      reportEvent(2, iso(Date.parse(startedAt), 20_000), {
        type: "message",
        messageId: `${conversationId}:follow-up`,
        role: "user",
        actorIdentity: actor("taylor@example.com", "Taylor Chen", "taylor"),
        text: "Can you check it with a cold cache too?",
      }),
      reportEvent(3, iso(Date.parse(startedAt), 30_000), {
        type: "message",
        messageId: `${conversationId}:follow-up-output`,
        role: "assistant",
        text: "Checked with a cold cache. The order still holds.",
      }),
    ],
  });
}

/**
 * Add a Watch Event that reached a child after its last reply. The child runs
 * it as an agent invocation, so the input names the invocation and the Event.
 */
function withChildWatchEvent(conversation: MockConversation): MockConversation {
  const last = conversation.events.at(-1)!;
  const at = iso(Date.parse(last.createdAt), 60_000);
  const { conversationId } = conversation;
  return {
    ...conversation,
    events: [
      ...conversation.events,
      reportEvent(last.seq + 1, at, {
        type: "message",
        messageId: `${conversationId}:watch-event`,
        role: "user",
        agentInvocationId: `${conversationId}:watch-invocation`,
        eventType: "pull_request.checks.failed",
        eventNamespace: "github",
        eventObjectType: "code_change",
        trustedSummary:
          "GitHub PR getsentry/junior#2950 checks failed (1) for 705a328 on fix/pin-order.",
        text: '<task about="GitHub PR getsentry/junior#2950" event="pull_request.checks.failed">\n<instructions>Fix failed checks that the pull request causes.</instructions>\n</task>',
      }),
      reportEvent(last.seq + 2, iso(Date.parse(at), 20_000), {
        type: "message",
        messageId: `${conversationId}:watch-output`,
        role: "assistant",
        text: "The failed check was a flaky runner, so I re-ran it.",
      }),
    ],
  };
}

function longConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -92 * 60_000);
  const events: ConversationReportEvent[] = [
    reportEvent(1, startedAt, {
      type: "message",
      messageId: "release-user",
      role: "user",
      text: "Release the package, update the example app, and open a PR.",
    }),
  ];
  let nextSeq = 2;
  for (let index = 0; index < 12; index += 1) {
    const startedAtMs = Date.parse(startedAt) + 2_000 + index * 4_000;
    const startedSeq = nextSeq;
    nextSeq += 1;
    events.push(
      reportEvent(startedSeq, iso(startedAtMs), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: `release-bash-${index}`,
            name: "bash",
            status: "running",
          },
        ],
      }),
    );
    events.push(
      reportEvent(nextSeq, iso(startedAtMs, 1_500), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: `release-bash-${index}`,
            name: "bash",
            status: "completed",
            startedSeq,
            startedAt: iso(startedAtMs),
            input: { command: `step-${index}` },
            output: { exitCode: 0 },
          },
        ],
      }),
    );
    nextSeq += 1;
  }
  events.push(
    reportEvent(nextSeq, iso(Date.parse(startedAt), 53_000), {
      type: "compaction",
      modelId: "openai/gpt-5.4",
      summary:
        "The release is complete. Preserve the published version and continue by checking the update pull request.",
      details: {
        reason: "capacity",
        estimatedInputTokens: 364_200,
        replacementInputTokens: 2_750,
        triggerTokens: 360_000,
        inputLimitTokens: 380_000,
        inputMessageCount: 28,
        retainedMessageCount: 1,
        summaryChars: 980,
      },
    }),
  );
  nextSeq += 1;
  events.push(
    reportEvent(nextSeq, iso(Date.parse(startedAt), 166_000), {
      type: "message",
      messageId: "release-assistant",
      role: "assistant",
      // Links to the Annotations below show as a link, a hover card, and a
      // full card.
      text: [
        "Released the package.",
        "Opened the update pull request https://github.com/getsentry/junior/pull/2201. The [relay fix](https://github.com/getsentry/relay/pull/44) is merged.",
        "",
        "https://github.com/getsentry/payments/pull/91",
        "",
        // No Annotations: the API resolves these dashboard links.
        `Deployment is ready. Next, ${MOCK_DASHBOARD_ORIGIN}/people/dev%40example.com picks up ${MOCK_DASHBOARD_ORIGIN}/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}.`,
        "Track it in https://docs.google.com/document/d/1MockReleaseChecklist_0123456789/edit before https://www.google.com/calendar/event?eid=cmVsNDJnb25vZ28ganVuaW9yQGV4YW1wbGUuY29t",
        "Metrics are in https://drive.google.com/file/d/1MockReleaseMetricsPdf_0123456789/view, and the assets are in https://drive.google.com/drive/folders/1MockReleaseAssets_0123456789",
        "Morgan asked to hold the deploy: https://acme.slack.com/archives/CQA456/p1770021700000100",
        "The checkout error is back after the deploy: https://acme.sentry.io/issues/JUNIOR-3ZK/",
        "The demo is at https://www.youtube.com/watch?v=MockLaunchDemo",
        "",
        "https://blog.example.com/posts/release-4-2",
        "",
        // Alone on their lines: the video shows only its thumbnail, the
        // Slack message shows a card, and the repeated pull request shows
        // no second card.
        "https://www.youtube.com/watch?v=MockLaunchDemo",
        "",
        "https://acme.slack.com/archives/CQA456/p1770021700000100",
        "",
        "https://github.com/getsentry/payments/pull/91",
      ].join("\n"),
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
    assignedWork: true,
    unfinishedWork: true,
    isPriority: true,
    sidebarAnnotations: [
      {
        objectType: "code_change",
        status: "draft",
        key: "getsentry/junior#2201",
        label: "junior",
      },
      {
        icon: "git-pull-request",
        key: "getsentry/payments#91",
        label: "payments",
      },
      {
        icon: "git-merge",
        key: "getsentry/relay#44",
        label: "relay",
      },
    ],
    annotations: [
      {
        kind: "resource_link",
        key: "getsentry/junior#2201",
        label: "getsentry/junior#2201",
        objectType: "code_change",
        plugin: "github",
        status: "draft",
        url: "https://github.com/getsentry/junior/pull/2201",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 80_000),
      },
      {
        kind: "object",
        key: "getsentry/payments#91",
        label: "getsentry/payments#91",
        title: "Pin the release train to payments 4.2",
        displayType: "Pull request",
        objectType: "code_change",
        plugin: "github",
        status: "open",
        url: "https://github.com/getsentry/payments/pull/91",
        // The API names description images by Junior image paths.
        previewImages: ["payments-91-before", "payments-91-after"].map(
          (id) => ({
            src: `/api/images/${id}?w=320`,
            srcSet: `/api/images/${id}?w=320 1x, /api/images/${id}?w=640 2x`,
          }),
        ),
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 75_000),
      },
      {
        kind: "resource_link",
        key: "getsentry/relay#44",
        label: "getsentry/relay#44",
        objectType: "code_change",
        plugin: "github",
        status: "merged",
        url: "https://github.com/getsentry/relay/pull/44",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 70_000),
      },
    ],
    cumulativeDurationMs: 552_761,
    cumulativeUsage: usage(0.18),
    previousCursor: `mock:before:${LONG_CONVERSATION_ID}`,
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
    brief: mockBrief(nowMs, "expired"),
    startedAt,
    lastSeenAt: iso(nowMs, -41 * 60_000),
    lastProgressAt: iso(nowMs, -42 * 60_000),
    surface: "slack",
    visibility: "public",
    channel: "CQA123",
    channelName: "proj-checkout",
    actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
    // Finished links show the final annotation state in the sidebar.
    assignedWork: true,
    finishedWorkAt: iso(nowMs, -42 * 60_000),
    sidebarAnnotations: [
      {
        icon: "git-merge",
        key: "getsentry/payments#77",
        label: "payments",
      },
      {
        icon: "circle-x",
        key: "getsentry/payments#61",
        label: "payments",
      },
    ],
    annotations: [
      {
        kind: "object",
        key: "getsentry/payments#77",
        label: "getsentry/payments#77",
        title: "Cache tax rates per checkout session",
        displayType: "Pull request",
        objectType: "code_change",
        plugin: "github",
        status: "merged",
        url: "https://github.com/getsentry/payments/pull/77",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 30_000),
      },
      {
        kind: "object",
        key: "getsentry/payments#61",
        label: "getsentry/payments#61",
        title: "Checkout p95 regressed after tax lookup change",
        displayType: "Issue",
        objectType: "task",
        plugin: "github",
        status: "closed",
        url: "https://github.com/getsentry/payments/issues/61",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 28_000),
      },
    ],
    cumulativeDurationMs: 206_000,
    cumulativeUsage: usage(0.0332),
    eventHistory: {
      status: "expired",
      expiredAt: iso(nowMs, -20 * 60_000),
    },
    events: [],
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
    visibility: "private",
    channel: "DQA123",
    // Participant-visible private DM: type label, not a privacy restatement.
    channelName: "Direct Message",
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
        type: "tool_calls",
        calls: [
          {
            toolCallId: "private-search",
            name: "sentry.search",
            status: "running",
          },
        ],
      }),
      reportEvent(2, iso(Date.parse(startedAt), 11_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "private-search",
            name: "sentry.search",
            status: "running",
            startedSeq: 1,
            startedAt: iso(Date.parse(startedAt), 10_000),
          },
        ],
      }),
      reportEvent(3, iso(Date.parse(startedAt), 25_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "private-search",
            name: "sentry.search",
            status: "completed",
            startedSeq: 1,
            startedAt: iso(Date.parse(startedAt), 10_000),
          },
        ],
      }),
      reportEvent(4, iso(Date.parse(startedAt), 30_000), {
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
        failureCode: "model_execution_failed",
        failureReason: "network",
        eventId: "0123456789abcdef0123456789abcdef",
        sentryEventUrl:
          "https://sentry.example/organizations/acme/issues/?project=1&query=0123456789abcdef0123456789abcdef",
      }),
    ],
  });
}

/** A Conversation longer than its detail page, for the outline. */
function manyTurnsConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -26 * 60 * 60_000);
  const topics = [
    "the checkout error budget",
    "the canary rollout order",
    "the payments retry policy",
    "the alert thresholds",
    "the on-call handoff notes",
  ];
  return detail(nowMs, {
    conversationId: MANY_TURNS_CONVERSATION_ID,
    displayTitle: "Quarterly reliability review",
    surface: "slack",
    channel: "CQA456",
    startedAt,
    actorIdentity: actor("jordan@example.com", "Jordan Blake", "jordan"),
    events: Array.from({ length: 24 }, (_, turn) => [
      reportEvent(turn * 2, iso(Date.parse(startedAt), turn * 60_000), {
        type: "message" as const,
        messageId: `many-turns-user-${turn}`,
        role: "user" as const,
        text:
          turn % 2 === 0
            ? `Question ${turn + 1}: review ${topics[turn % topics.length]}.`
            : `Question ${turn + 1}: review ${topics[turn % topics.length]}. Check last quarter's numbers, list the open follow-ups with their owners, and tell me whether anything blocks the next release or needs a decision from the team this week.`,
      }),
      reportEvent(
        turn * 2 + 1,
        iso(Date.parse(startedAt), turn * 60_000 + 20_000),
        {
          type: "message" as const,
          messageId: `many-turns-reply-${turn}`,
          role: "assistant" as const,
          text: [
            `Reviewed ${topics[turn % topics.length]}.`,
            "",
            "- Last quarter's numbers stay inside the target.",
            "- Two follow-ups are open, and both have owners.",
            "- No change blocks the next release.",
            "",
            "I will flag it in the weekly summary if the trend changes.",
          ].join("\n"),
        },
      ),
    ]).flat(),
  });
}

function simpleConversation(
  nowMs: number,
  options: {
    conversationId: string;
    displayTitle: string;
    surface: "internal" | "scheduler" | "slack";
    channel?: string;
    sourceTask?: ConversationDetailReport["sourceTask"];
    archivedAt?: string;
  },
): ConversationDetailReport {
  // Finished work stays in Today even when it was active in the last 24 hours.
  const startedAt = iso(nowMs, -5 * 60 * 60_000);
  return detail(nowMs, {
    ...options,
    startedAt,
    lastSeenAt: iso(nowMs, -4 * 60 * 60_000),
    lastProgressAt: iso(nowMs, -4 * 60 * 60_000),
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

const HISTORY_TOPICS = [
  "Release notes draft",
  "Flaky test triage",
  "Quota alert follow-up",
  "Onboarding doc review",
  "Dependency bump",
  "Billing export check",
  "Incident timeline",
  "SDK changelog summary",
];

/**
 * Older finished conversations from the last 80 days. They fill more than one
 * feed page, so the conversation list loads pages as the reader scrolls.
 */
function historyConversations(nowMs: number): ConversationDetailReport[] {
  return Array.from({ length: 64 }, (_, index) => {
    const conversationId = `internal:history-${index + 1}`;
    const startedAt = iso(nowMs, -(2 + index * 1.2) * 24 * 60 * 60_000);
    return detail(nowMs, {
      conversationId,
      displayTitle: `${HISTORY_TOPICS[index % HISTORY_TOPICS.length]} ${index + 1}`,
      actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
      cumulativeDurationMs: 8_000,
      startedAt,
      events: [
        reportEvent(0, startedAt, {
          type: "message",
          messageId: `${conversationId}:message`,
          role: "assistant",
          text: "Done.",
        }),
      ],
    });
  });
}

const MOCK_MENTION_MORGAN: ActorIdentity = {
  email: "dev@example.com",
  fullName: "Morgan Lee",
  slackUserId: "U123",
  slackUserName: "morgan",
};

function eventAutomationRunConversation(
  nowMs: number,
): ConversationDetailReport {
  const startedAt = iso(nowMs, -3 * 60 * 60_000);
  const at = (offsetMs: number) => iso(Date.parse(startedAt), offsetMs);
  return detail(nowMs, {
    conversationId: EVENT_AUTOMATION_RUN_CONVERSATION_ID,
    displayTitle: "Closed issue summary",
    surface: "internal",
    startedAt,
    lastSeenAt: at(14_000),
    lastProgressAt: at(14_000),
    cumulativeDurationMs: 14_000,
    sourceTask: {
      id: "event-1",
      kind: "event",
      label: "Summarize the closed issue",
      title: "Closed issue summary",
      triggerMessageId: EVENT_AUTOMATION_RUN_CONVERSATION_ID,
      triggerLabel: "Linear issue ACME-42 closed",
      credentialMode: "creator",
      credentialUser: "Alex Rivera",
    },
    events: [
      reportEvent(
        0,
        startedAt,
        {
          type: "message",
          messageId: EVENT_AUTOMATION_RUN_CONVERSATION_ID,
          role: "user",
          // Dispatch input is authored by the dispatch owner, not a person.
          actorIdentity: {
            fullName: "junior",
            slackUserId: "junior",
            slackUserName: "junior",
          },
          text: [
            '<task about="Issue · ACME-42" event="issue.closed">',
            '<created-by><@U123>. This person is the Automation creator. "The Automation creator", "me", and "my" in the instructions mean this person. Where the instructions refer to this person, write this mention in the message. If they do not, do not mention this person.</created-by>',
            "<instructions>Summarize the closed issue</instructions>",
            "<summary>ACME-42 Checkout fails for saved cards was closed by Morgan Lee.</summary>",
            "End with `reply`, `noReply`, or `reportBlocked`.",
            "</task>",
          ].join("\n"),
        },
        { mentions: [MOCK_MENTION_MORGAN] },
      ),
      reportEvent(1, at(1_000), {
        type: "turn_lifecycle",
        turnId: "dispatch:event-1",
        state: "started",
        inputMessageIds: [EVENT_AUTOMATION_RUN_CONVERSATION_ID],
      }),
      reportEvent(
        2,
        at(13_000),
        {
          type: "message",
          messageId: `${EVENT_AUTOMATION_RUN_CONVERSATION_ID}:reply`,
          role: "assistant",
          text: "<@U123> ACME-42 is closed. The saved-card checkout failure was fixed by the token refresh change and verified in production. cc <@U456> and <@U999> in <#C42|proj-checkout>.",
        },
        // U456 has no People profile, and U999 is not resolved.
        {
          mentions: [
            MOCK_MENTION_MORGAN,
            { fullName: "Casey Nguyen", slackUserId: "U456" },
          ],
        },
      ),
      reportEvent(3, at(14_000), {
        type: "turn_lifecycle",
        turnId: "dispatch:event-1",
        state: "succeeded",
      }),
    ],
  });
}

function actor(
  email: string | undefined,
  fullName: string,
  slackUserName: string,
): ActorIdentity {
  return { ...(email ? { email } : undefined), fullName, slackUserName };
}

function usage(cost: number) {
  return {
    inputTokens: 1_200,
    outputTokens: 420,
    cachedInputTokens: 300,
    cost: { input: cost * 0.4, output: cost * 0.6, total: cost },
  };
}

/** Fixture Conversations with the mock sends of this process. */
function mockConversations(nowMs: number): MockConversation[] {
  return withMockSends(fixtureConversations(nowMs));
}

function fixtureConversations(nowMs: number): MockConversation[] {
  return [
    activeConversation(nowMs),
    ...mockQuestionConversations(nowMs).map((options) =>
      detail(nowMs, options),
    ),
    dashboardQaConversation(nowMs),
    advisorConversation(
      nowMs,
      DASHBOARD_QA_PLAN_ID,
      "Review the dashboard plan before editing.",
      {
        childAgentTotals: {
          count: 1,
          cumulativeDurationMs: 6_200,
          cumulativeUsage: {
            inputTokens: 4_100,
            outputTokens: 220,
            cost: { total: 0.011 },
          },
        },
        cumulativeDurationMs: 78_600,
        cumulativeUsage: {
          inputTokens: 42_500,
          outputTokens: 2_370,
          cachedInputTokens: 21_600,
          cost: { input: 0.1, output: 0.053, total: 0.153 },
        },
      },
    ),
    advisorConversation(
      nowMs,
      DASHBOARD_QA_PLAN_CHECK_ID,
      "Check one claim in the dashboard plan.",
      {
        cumulativeDurationMs: 6_200,
        cumulativeUsage: {
          inputTokens: 4_100,
          outputTokens: 220,
          cost: { total: 0.011 },
        },
      },
      DASHBOARD_QA_PLAN_ID,
    ),
    advisorConversation(
      nowMs,
      DASHBOARD_QA_REVIEW_ID,
      "Review the implementation after the first advisor pass.",
      {
        cumulativeDurationMs: 9_800,
        cumulativeUsage: {
          inputTokens: 6_200,
          outputTokens: 310,
          cost: { input: 0.015, output: 0.004, total: 0.019 },
        },
      },
    ),
    {
      ...withChildWatchEvent(
        threadConversation(
          nowMs,
          DASHBOARD_QA_THREAD_ID,
          "Check pinned row order",
          "Check that pinned rows keep their order after a reload.",
          -3 * 60 * 60_000,
        ),
      ),
      // The nested Thread below.
      childAgentTotals: { count: 1, cumulativeDurationMs: 12_000 },
    },
    threadConversation(
      nowMs,
      DASHBOARD_QA_NESTED_THREAD_ID,
      "Recheck pin order in Safari",
      "Recheck the pinned row order in Safari.",
      -2.9 * 60 * 60_000,
      DASHBOARD_QA_THREAD_ID,
    ),
    threadConversation(
      nowMs,
      DASHBOARD_QA_ARCHIVED_THREAD_ID,
      "Compare sidebar badges",
      "Compare the sidebar badges with the design.",
      -3.5 * 60 * 60_000,
    ),
    longConversation(nowMs),
    manyTurnsConversation(nowMs),
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
      sourceTask: {
        id: "scheduled-1",
        kind: "scheduled",
        label:
          "Send the weekly project summary with release blockers, owner follow-ups, and next-week risks for every tracked workstream",
        title: "Weekly project summary",
      },
    }),
    eventAutomationRunConversation(nowMs),
    simpleConversation(nowMs, {
      conversationId: ARCHIVED_CONVERSATION_ID,
      displayTitle: "Archived restore target",
      surface: "internal",
    }),
    ...historyConversations(nowMs),
  ];
}

function summaryFromConversation(
  conversation: MockConversation,
): ConversationSummaryReport {
  const activityEvent =
    [...conversation.events]
      .reverse()
      .find(
        (event) =>
          event.data.type === "message" && event.data.role === "assistant",
      ) ??
    [...conversation.events]
      .reverse()
      .find(
        (event) => event.data.type === "message" && event.data.role === "user",
      );
  const activityPreview =
    activityEvent?.data.type === "message" && activityEvent.data.text
      ? {
          createdAt: activityEvent.createdAt,
          ...(activityEvent.mentions
            ? { mentions: activityEvent.mentions }
            : undefined),
          role: activityEvent.data.role as "assistant" | "user",
          text: activityEvent.data.text,
        }
      : undefined;
  const {
    brief: _brief,
    eventHistory: _eventHistory,
    events: _events,
    forkedFromConversationId: _forkedFromConversationId,
    forkedFromTitle: _forkedFromTitle,
    forks: _forks,
    generatedAt: _generatedAt,
    modelUsage: _modelUsage,
    previousCursor: _previousCursor,
    sentryConversationUrl: _sentryConversationUrl,
    sourceTask: _sourceTask,
    ...summary
  } = conversation;
  const summaryWithActivity = {
    ...summary,
    ...(activityPreview ? { activityPreview } : undefined),
  };
  const withViewerState = withMockViewerState(summaryWithActivity);
  return withViewerState.channel &&
    PUBLIC_MOCK_CHANNEL_IDS.has(withViewerState.channel)
    ? { ...withViewerState, locationId: `mock:${withViewerState.channel}` }
    : withViewerState;
}

/**
 * Find where a mock Thread nests, like the API: its nearest Thread or root
 * ancestor. Returns undefined when an ancestor child is archived.
 */
function mockThreadPlacement(
  byId: ReadonlyMap<string, MockConversation>,
  thread: MockConversation,
): string | undefined {
  let placement: string | undefined;
  for (
    let ancestor = byId.get(thread.parentConversationId ?? "");
    ancestor;
    ancestor = byId.get(ancestor.parentConversationId ?? "")
  ) {
    if (ancestor.kind === "root") return placement ?? ancestor.conversationId;
    if (ancestor.archivedAt) return undefined;
    if (ancestor.kind === "thread") placement ??= ancestor.conversationId;
  }
  return undefined;
}

/** Group shown mock Threads by where they nest. */
function mockThreadsByPlacement(
  conversations: readonly MockConversation[],
): Map<string, ConversationFeedItem[]> {
  const byId = new Map(
    conversations.map((conversation) => [
      conversation.conversationId,
      conversation,
    ]),
  );
  const threadsByPlacement = new Map<string, ConversationFeedItem[]>();
  for (const thread of conversations) {
    if (thread.kind !== "thread" || thread.archivedAt) continue;
    const placement = mockThreadPlacement(byId, thread);
    if (!placement) continue;
    threadsByPlacement.set(placement, [
      ...(threadsByPlacement.get(placement) ?? []),
      summaryFromConversation(thread),
    ]);
  }
  return threadsByPlacement;
}

/**
 * Match the API feed: roots only, each with its shown Threads nested under
 * their nearest shown ancestor.
 */
function mockConversationFeed(nowMs: number): ConversationFeed {
  const conversations = mockConversations(nowMs);
  const threadsByPlacement = mockThreadsByPlacement(conversations);
  const nest = (item: ConversationFeedItem): ConversationFeedItem => {
    const threads = threadsByPlacement.get(item.conversationId);
    return threads ? { ...item, threads: threads.map(nest) } : item;
  };
  return {
    source: "conversation_index",
    generatedAt: iso(nowMs),
    conversations: conversations
      .filter(
        (conversation) =>
          conversation.kind === "root" &&
          !isUnlistedMockConversation(conversation.conversationId),
      )
      .map((root) => {
        const summary = summaryFromConversation(root);
        return summary.archivedAt ? summary : nest(summary);
      }),
  };
}

/**
 * Active root summaries used by mock aggregates and directories. Like the
 * feed, they leave out unlisted Conversations.
 */
function activeMockSummaries(nowMs: number): ConversationSummaryReport[] {
  return mockConversations(nowMs)
    .filter(
      (conversation) =>
        conversation.kind === "root" &&
        !isUnlistedMockConversation(conversation.conversationId),
    )
    .map(summaryFromConversation)
    .filter((summary) => !summary.archivedAt);
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

/** Count a completed mock conversation as an answered or done outcome. */
function addMockOutcome(
  bucket: ConversationStatsReport["metricDays"][number],
  summary: ConversationSummaryReport,
) {
  if (summary.status !== "completed") return;
  bucket.outcomes = (bucket.outcomes ?? 0) + 1;
  bucket.outcomeCostUsd =
    (bucket.outcomeCostUsd ?? 0) + (summary.cumulativeUsage?.cost?.total ?? 0);
}

/** Add two mock merged code changes, with split conversation cost. */
function addMockMergedCodeChanges(
  buckets: Map<string, ConversationStatsReport["metricDays"][number]>,
  nowMs: number,
  keyLength: number,
) {
  for (const change of [
    { at: iso(nowMs, -3 * 86_400_000), costUsd: 4.25 },
    { at: iso(nowMs, -4 * 86_400_000), costUsd: 2.1 },
  ]) {
    const bucket = buckets.get(change.at.slice(0, keyLength));
    if (!bucket) continue;
    bucket.mergedCodeChanges = (bucket.mergedCodeChanges ?? 0) + 1;
    bucket.mergedCodeChangeCostUsd =
      (bucket.mergedCodeChangeCostUsd ?? 0) + change.costUsd;
    bucket.outcomes = (bucket.outcomes ?? 0) + 1;
    bucket.outcomeCostUsd = (bucket.outcomeCostUsd ?? 0) + change.costUsd;
  }
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
    days.set(key, { conversations: 0, date: key, durationMs: 0 });
  }
  for (const summary of summaries) {
    const day = days.get(summary.lastSeenAt.slice(0, 10));
    if (!day) continue;
    day.conversations += 1;
    day.durationMs += summary.cumulativeDurationMs;
    addMockOutcome(day, summary);
    const tokens = summaryTokenTotal(summary);
    if (tokens) day.tokens = (day.tokens ?? 0) + tokens;
    const inputTokens = summary.cumulativeUsage?.inputTokens;
    if (inputTokens !== undefined) {
      day.inputTokens = (day.inputTokens ?? 0) + inputTokens;
    }
    const cachedInputTokens = summary.cumulativeUsage?.cachedInputTokens;
    if (cachedInputTokens !== undefined) {
      day.cachedInputTokens = (day.cachedInputTokens ?? 0) + cachedInputTokens;
    }
    const costUsd = summary.cumulativeUsage?.cost?.total;
    if (costUsd !== undefined) {
      day.costUsd = (day.costUsd ?? 0) + costUsd;
    }
    if (summary.sandboxCostUsd !== undefined) {
      day.sandboxCostUsd = (day.sandboxCostUsd ?? 0) + summary.sandboxCostUsd;
    }
  }
  addMockMergedCodeChanges(days, nowMs, 10);
  return [...days.values()];
}

function conversationMetricHours(
  nowMs: number,
  summaries: ConversationSummaryReport[],
): NonNullable<ConversationStatsReport["metricHours"]> {
  const hours = new Map<
    string,
    NonNullable<ConversationStatsReport["metricHours"]>[number]
  >();
  const end = new Date(nowMs);
  end.setUTCMinutes(0, 0, 0);
  for (let offset = 7 * 24 - 1; offset >= 0; offset -= 1) {
    const date = new Date(end.getTime() - offset * 60 * 60 * 1_000);
    const key = date.toISOString().slice(0, 13);
    hours.set(key, { conversations: 0, date: key, durationMs: 0 });
  }
  for (const summary of summaries) {
    const key = summary.lastSeenAt.slice(0, 13);
    const hour = hours.get(key);
    if (!hour) continue;
    hour.conversations += 1;
    hour.durationMs += summary.cumulativeDurationMs;
    addMockOutcome(hour, summary);
    const tokens = summaryTokenTotal(summary);
    if (tokens) hour.tokens = (hour.tokens ?? 0) + tokens;
    const inputTokens = summary.cumulativeUsage?.inputTokens;
    if (inputTokens !== undefined) {
      hour.inputTokens = (hour.inputTokens ?? 0) + inputTokens;
    }
    const cachedInputTokens = summary.cumulativeUsage?.cachedInputTokens;
    if (cachedInputTokens !== undefined) {
      hour.cachedInputTokens =
        (hour.cachedInputTokens ?? 0) + cachedInputTokens;
    }
    const costUsd = summary.cumulativeUsage?.cost?.total;
    if (costUsd !== undefined) {
      hour.costUsd = (hour.costUsd ?? 0) + costUsd;
    }
  }
  addMockMergedCodeChanges(hours, nowMs, 13);
  return [...hours.values()];
}

function mockGuardianStats(nowMs: number): ConversationStatsReport["guardian"] {
  const metricDays = Array.from({ length: 90 }, (_, index) => {
    const date = new Date(nowMs);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (89 - index));
    const recentIndex = index - 59;
    const requests = recentIndex > 0 ? (recentIndex % 5) + 1 : 0;
    const deny = requests > 2 && recentIndex % 8 === 0 ? 1 : 0;
    const ask = requests > 1 && recentIndex % 4 === 0 ? 1 : 0;
    const allow = requests - ask - deny;
    return {
      allow,
      ask,
      ...(requests ? { costUsd: requests * 0.0009 } : undefined),
      date: date.toISOString().slice(0, 10),
      deny,
      requests,
    };
  });
  const end = new Date(nowMs);
  end.setUTCMinutes(0, 0, 0);
  const metricHours = Array.from({ length: 7 * 24 }, (_, index) => {
    const date = new Date(
      end.getTime() - (7 * 24 - 1 - index) * 60 * 60 * 1_000,
    );
    const requests = index > 12 ? (index % 4) + 1 : 0;
    const deny = requests > 2 && index % 5 === 0 ? 1 : 0;
    const ask = requests > 1 && index % 3 === 0 ? 1 : 0;
    const allow = requests - ask - deny;
    return {
      allow,
      ask,
      ...(requests ? { costUsd: requests * 0.0009 } : undefined),
      date: date.toISOString().slice(0, 13),
      deny,
      requests,
    };
  });
  const metricSixHours = sumMockHoursIntoSixHours(
    nowMs,
    metricHours,
    (date) => ({ allow: 0, ask: 0, date, deny: 0, requests: 0 }),
  );
  return metricDays.reduce<ConversationStatsReport["guardian"]>(
    (result, day) => ({
      allow: result.allow + day.allow,
      ask: result.ask + day.ask,
      costUsd: (result.costUsd ?? 0) + (day.costUsd ?? 0),
      deny: result.deny + day.deny,
      metricDays,
      metricHours,
      metricSixHours,
      requests: result.requests + day.requests,
    }),
    {
      allow: 0,
      ask: 0,
      costUsd: 0,
      deny: 0,
      metricDays,
      metricHours,
      metricSixHours,
      requests: 0,
    },
  );
}

const RECENT_ARCHIVE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Return the explicit canonical-event visual-QA feed, optionally scoped by actor. */
export function readMockConversationFeed(
  actorEmail?: string,
  status: "active" | "archived" = "active",
): ConversationFeed {
  const feed = mockConversationFeed(NOW_MS);
  const recentArchiveCutoffMs = NOW_MS - RECENT_ARCHIVE_WINDOW_MS;
  const conversations = feed.conversations
    .filter((conversation) =>
      status === "archived"
        ? Boolean(conversation.archivedAt)
        : !mockUnsubscribedConversationIds.has(conversation.conversationId) &&
          (!conversation.archivedAt ||
            Date.parse(conversation.archivedAt) >= recentArchiveCutoffMs),
    )
    .filter(
      (conversation) =>
        !actorEmail ||
        conversation.actorIdentity?.email?.toLowerCase() ===
          actorEmail.toLowerCase(),
    );
  return { ...feed, conversations };
}

/**
 * Archive or restore one mock conversation for local dashboard visual QA,
 * with the API's tree rules. Like the API, an archive applies to everyone.
 */
export function setMockConversationArchived(
  conversationId: string,
  archived: boolean,
  applyToChildren = false,
): { archivedAt: string | null } | { error: string } | undefined {
  const conversations = mockConversations(NOW_MS);
  const conversation = conversations.find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;
  const parentOf = new Map(
    conversations.map((item) => [
      item.conversationId,
      item.parentConversationId,
    ]),
  );
  // Nearest first.
  const ancestorsOf = (id: string) => {
    const ancestors: string[] = [];
    for (let parent = parentOf.get(id); parent; parent = parentOf.get(parent)) {
      ancestors.push(parent);
    }
    return ancestors;
  };
  const descendantIds = conversations
    .map((item) => item.conversationId)
    .filter((id) => ancestorsOf(id).includes(conversationId));
  if (archived) {
    const unarchived = descendantIds.filter((id) => !mockArchivedAt.has(id));
    if (unarchived.length > 0 && !applyToChildren) {
      return {
        error:
          unarchived.length === 1
            ? "1 child conversation is not archived. Pass applyToChildren to archive it too."
            : `${unarchived.length} child conversations are not archived. Pass applyToChildren to archive them too.`,
      };
    }
    // Like the API, one archive writes one time, so a restore can tell what
    // this archive wrote.
    const archivedAt = new Date(NOW_MS + ++mockArchiveCount).toISOString();
    for (const id of [conversationId, ...unarchived]) {
      mockArchivedAt.set(id, archivedAt);
    }
    return { archivedAt };
  }
  // Name the topmost archived ancestor, like the API.
  const archivedAncestorId = ancestorsOf(conversationId)
    .reverse()
    .find((id) => mockArchivedAt.has(id));
  if (archivedAncestorId) {
    return {
      error: `Conversation ${archivedAncestorId} above this one is archived. Restore it first.`,
    };
  }
  const archivedAt = mockArchivedAt.get(conversationId);
  for (const id of [
    conversationId,
    ...(applyToChildren && archivedAt
      ? descendantIds.filter(
          (descendantId) => mockArchivedAt.get(descendantId) === archivedAt,
        )
      : []),
  ]) {
    mockArchivedAt.delete(id);
  }
  // Match the API: a manual root restore turns auto-archive off.
  if (conversation.kind === "root") {
    mockAutoArchiveByConversationId.set(conversationId, false);
  }
  return { archivedAt: null };
}

/**
 * Pin or unpin one mock conversation for local dashboard visual QA. Like the
 * API, it refuses a child and names its root.
 */
export function setMockConversationPinned(
  conversationId: string,
  pinned: boolean,
): { pinnedAt: string | null } | { error: string } | undefined {
  const conversation = mockConversations(NOW_MS).find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;
  const rootId = mockAgentTree(conversation)?.[0]?.conversationId;
  if (rootId) {
    return {
      error: `A child conversation cannot be pinned or unpinned. It uses its root's pin: ${rootId}.`,
    };
  }
  // Match the API: a new or removed pin has no place.
  mockPinPositions.delete(conversationId);
  if (pinned) {
    mockPinnedConversationIds.add(conversationId);
    // Match the API: a pin also restores an archived conversation.
    mockArchivedAt.delete(conversationId);
  } else {
    mockPinnedConversationIds.delete(conversationId);
  }
  return { pinnedAt: pinned ? NOW : null };
}

/** Rename one mock conversation for local dashboard visual QA. */
export function setMockConversationTitle(
  conversationId: string,
  title: string,
): { title: string } | undefined {
  const exists = mockConversations(NOW_MS).some(
    (conversation) => conversation.conversationId === conversationId,
  );
  if (!exists) return undefined;
  mockTitles.set(conversationId, title);
  return { title };
}

/** Save one attached link on a mock Conversation, like the attach API. */
export function addMockAnnotation(
  conversationId: string,
  annotation: NonNullable<ConversationDetailReport["annotations"]>[number],
): void {
  mockAttachedAnnotations.set(conversationId, [
    annotation,
    ...(mockAttachedAnnotations.get(conversationId) ?? []),
  ]);
}

/** Save the mock Pinned order, like the pin-order API. */
export function setMockPinOrder(conversationIds: string[]): {
  conversationIds: string[];
} {
  const placed = conversationIds.flatMap((conversationId, index) => {
    if (!mockPinnedConversationIds.has(conversationId)) return [];
    mockPinPositions.set(conversationId, index);
    return [conversationId];
  });
  return { conversationIds: placed };
}

/** Archive every done mock conversation once, like the archive-done API. */
export function archiveMockDoneConversations(): { archived: number } {
  let archived = 0;
  for (const summary of mockConversationFeed(NOW_MS).conversations) {
    if (
      summary.archivedAt ||
      summary.pinnedAt ||
      !summary.assignedWork ||
      summary.unfinishedWork ||
      !summary.finishedWorkAt ||
      mockAutoArchiveByConversationId.get(summary.conversationId) === false
    ) {
      continue;
    }
    mockArchivedAt.set(summary.conversationId, NOW);
    archived += 1;
  }
  return { archived };
}

/**
 * Subscribe to or unsubscribe from one mock root for local dashboard visual
 * QA. Like the API, an unsubscribe drops the pin. The mock viewer is never
 * the last subscriber, so it never archives.
 */
export function setMockConversationSubscribed(
  conversationId: string,
  subscribed: boolean,
): { archivedAt: string | null; subscribed: boolean } | undefined {
  const conversation = mockConversations(NOW_MS).find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;
  const rootId =
    mockAgentTree(conversation)?.[0]?.conversationId ?? conversationId;
  if (subscribed) {
    mockUnsubscribedConversationIds.delete(rootId);
  } else {
    mockUnsubscribedConversationIds.add(rootId);
    mockPinnedConversationIds.delete(rootId);
    mockPinPositions.delete(rootId);
  }
  return { archivedAt: mockArchivedAt.get(rootId) ?? null, subscribed };
}

/**
 * Detach a mock root from its Slack thread, or attach it again, for local
 * dashboard visual QA. Like the API, only a participant's root with a Slack
 * thread can change.
 */
export function setMockConversationDeliveryPaused(
  conversationId: string,
  paused: boolean,
): { paused: boolean } | { error: string } | undefined {
  const detail = readMockConversationDetail(conversationId);
  if (!detail?.isParticipant) return undefined;
  if (detail.deliveryPaused === undefined) {
    return { error: "Only a conversation with a Slack thread can detach." };
  }
  if (paused) {
    mockDeliveryPausedConversationIds.add(conversationId);
  } else {
    mockDeliveryPausedConversationIds.delete(conversationId);
  }
  return { paused };
}

/** Save a mock auto-archive choice for local dashboard visual QA. */
export function setMockConversationAutoArchive(
  conversationId: string,
  autoArchive: boolean,
): { autoArchive: boolean } | undefined {
  const exists = mockConversations(NOW_MS).some(
    (conversation) => conversation.conversationId === conversationId,
  );
  if (!exists) return undefined;
  mockAutoArchiveByConversationId.set(conversationId, autoArchive);
  return { autoArchive };
}

/** Return accepted mailbox rows for local dashboard visual QA. */
export function readMockConversationPendingMessages(
  conversationId: string,
): ConversationPendingMessagesReport | undefined {
  const conversation = mockConversations(NOW_MS).find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;

  const nowMs = NOW_MS;
  const messages =
    conversationId === ACTIVE_CONVERSATION_ID
      ? [
          {
            actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
            createdAt: iso(nowMs, -8_000),
            delivery: "interrupt" as const,
            inboundMessageId: `${conversationId}:pending-interrupt`,
            messageId: `${conversationId}:pending-interrupt`,
            receivedAt: iso(nowMs, -7_500),
            role: "user" as const,
            source: "slack" as const,
            text: "Also check the canary traffic from the last deploy.",
          },
          {
            actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
            createdAt: iso(nowMs, -4_000),
            delivery: "defer" as const,
            inboundMessageId: `${conversationId}:pending-defer`,
            messageId: `${conversationId}:pending-defer`,
            receivedAt: iso(nowMs, -3_500),
            role: "user" as const,
            source: "web" as const,
            text: "Keep the reply in Junior. I will paste the dashboard link next.",
            attachments: [
              {
                id: "qa-chart-png",
                filename: "queued-chart.png",
                contentType: "image/png",
                bytes: 18211,
              },
            ],
          },
          {
            actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
            createdAt: iso(nowMs, -3_000),
            delivery: "defer" as const,
            inboundMessageId: `${conversationId}:pending-third`,
            messageId: `${conversationId}:pending-third`,
            receivedAt: iso(nowMs, -2_500),
            role: "user" as const,
            source: "web" as const,
            text: "Third queued message.",
          },
          {
            actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
            createdAt: iso(nowMs, -2_000),
            delivery: "defer" as const,
            inboundMessageId: `${conversationId}:pending-fourth`,
            messageId: `${conversationId}:pending-fourth`,
            receivedAt: iso(nowMs, -1_500),
            role: "user" as const,
            source: "web" as const,
            text: "Fourth queued message.",
          },
          {
            actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
            createdAt: iso(nowMs, -1_000),
            delivery: "defer" as const,
            inboundMessageId: `${conversationId}:pending-fifth`,
            messageId: `${conversationId}:pending-fifth`,
            receivedAt: iso(nowMs, -500),
            role: "user" as const,
            source: "web" as const,
            text: "Fifth queued message.",
          },
          {
            actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
            createdAt: iso(nowMs, -800),
            delivery: "defer" as const,
            inboundMessageId: `${conversationId}:pending-sixth`,
            messageId: `${conversationId}:pending-sixth`,
            receivedAt: iso(nowMs, -400),
            role: "user" as const,
            source: "web" as const,
            text: "Sixth queued message.",
          },
          {
            actorIdentity: actor("dev@example.com", "Morgan Lee", "morgan"),
            createdAt: iso(nowMs, -600),
            delivery: "defer" as const,
            inboundMessageId: `${conversationId}:pending-seventh`,
            messageId: `${conversationId}:pending-seventh`,
            receivedAt: iso(nowMs, -300),
            role: "user" as const,
            source: "web" as const,
            text: "Seventh queued message.",
          },
        ]
      : [];

  return {
    conversationId,
    generatedAt: iso(nowMs),
    messages,
  };
}

/** Return the child agents of one mock Conversation, matching its transcript. */
export function readMockConversationChildAgents(
  conversationId: string,
): ConversationChildAgentsReport | undefined {
  const conversations = mockConversations(NOW_MS);
  const conversation = conversations.find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;
  const startedAtMs = NOW_MS - 5 * 60 * 60_000;
  // Match the API: each row has the usage of its child Conversation and of
  // that child's own subagents.
  const childMetrics = (childConversationId: string) => {
    const child = conversations.find(
      (candidate) => candidate.conversationId === childConversationId,
    )!;
    return {
      ...(child.childAgentTotals
        ? { childAgentTotals: child.childAgentTotals }
        : undefined),
      archivedAt: mockArchivedAt.get(childConversationId) ?? null,
      cumulativeDurationMs: child.cumulativeDurationMs,
      cumulativeUsage: child.cumulativeUsage,
    };
  };
  if (conversationId === DASHBOARD_QA_PLAN_ID) {
    return {
      agents: [
        {
          ...childMetrics(DASHBOARD_QA_PLAN_CHECK_ID),
          conversationId: DASHBOARD_QA_PLAN_CHECK_ID,
          kind: "task",
          status: "completed",
          task: "Check one claim in the dashboard plan.",
          title: "Check one plan claim",
          updatedAt: iso(startedAtMs, 16_000),
        },
      ],
      conversationId,
    };
  }
  // Match the API: archived children stay in the report.
  const thread = (childConversationId: string, task: string) => {
    const child = conversations.find(
      (candidate) => candidate.conversationId === childConversationId,
    )!;
    return {
      ...childMetrics(childConversationId),
      conversationId: childConversationId,
      kind: "thread",
      status: "completed",
      task,
      title: child.displayTitle,
      updatedAt: child.lastProgressAt,
    } as const;
  };
  if (conversationId === DASHBOARD_QA_THREAD_ID) {
    return {
      agents: [
        thread(
          DASHBOARD_QA_NESTED_THREAD_ID,
          "Recheck the pinned row order in Safari.",
        ),
      ],
      conversationId,
    };
  }
  if (conversationId !== DASHBOARD_QA_CONVERSATION_ID) {
    return { agents: [], conversationId };
  }
  return {
    agents: [
      thread(
        DASHBOARD_QA_THREAD_ID,
        "Check pinned row order with the person who reported it.",
      ),
      thread(
        DASHBOARD_QA_ARCHIVED_THREAD_ID,
        "Compare the sidebar badges with the design.",
      ),
      {
        ...childMetrics(DASHBOARD_QA_REVIEW_ID),
        conversationId: DASHBOARD_QA_REVIEW_ID,
        kind: "task",
        error: "GitHub access is needed to read the pull request.",
        name: "reviewer",
        status: "blocked",
        task: "Review the open dashboard pull requests and list risky changes.",
        updatedAt: iso(startedAtMs, 44_000),
      },
      {
        ...childMetrics(DASHBOARD_QA_PLAN_ID),
        conversationId: DASHBOARD_QA_PLAN_ID,
        kind: "task",
        status: "completed",
        task: "Review the dashboard plan before editing.",
        title: "Review the dashboard plan",
        updatedAt: iso(startedAtMs, 20_000),
      },
    ],
    conversationId,
  };
}

/** Agent types and forks of mock children. Other children start fresh. */
const MOCK_CHILD_AGENTS: Readonly<
  Record<string, { agentType?: string; fork?: true }>
> = {
  [DASHBOARD_QA_PLAN_ID]: { agentType: "reviewer", fork: true },
  [DASHBOARD_QA_REVIEW_ID]: { agentType: "reviewer" },
  [DASHBOARD_QA_PLAN_CHECK_ID]: { fork: true },
};

/** Build the agent tree of a mock child Conversation, like the API. */
function mockAgentTree(
  conversation: MockConversation,
): ConversationDetailReport["agentTree"] {
  if (!conversation.parentConversationId) return undefined;
  const conversations = mockConversations(NOW_MS);
  const chain = [conversation];
  let current = conversation;
  while (current.parentConversationId) {
    const parent = conversations.find(
      (candidate) => candidate.conversationId === current.parentConversationId,
    );
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain.map((item) => {
    if (!item.parentConversationId) {
      return {
        conversationId: item.conversationId,
        kind: "root" as const,
        label: item.displayTitle,
      };
    }
    const agent = readMockConversationChildAgents(
      item.parentConversationId,
    )?.agents.find((child) => child.conversationId === item.conversationId);
    return {
      conversationId: item.conversationId,
      kind: item.kind,
      label:
        agent?.title ??
        agent?.name ??
        (item.kind === "thread" ? "Thread" : "Task"),
      ...MOCK_CHILD_AGENTS[item.conversationId],
    };
  });
}

/** Return one canonical-event visual-QA conversation detail fixture. */
export function readMockConversationDetail(
  conversationId: string,
  limit = 500,
): ConversationDetailReport | undefined {
  const conversation = mockConversations(NOW_MS).find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;
  const agentTree = mockAgentTree(conversation);
  // Match the API: only readable root Conversations can be forked.
  const attached = mockAttachedAnnotations.get(conversationId) ?? [];
  const detail = {
    ...conversation,
    annotations: [...attached, ...(conversation.annotations ?? [])],
    ...(agentTree ? { agentTree } : undefined),
    canFork:
      !conversation.parentConversationId &&
      !isUnlistedMockConversation(conversationId) &&
      conversation.eventHistory.status !== "redacted",
    ...(conversation.isParticipant
      ? {
          autoArchive:
            mockAutoArchiveByConversationId.get(conversationId) ?? false,
          subscribed: !mockUnsubscribedConversationIds.has(
            agentTree?.[0]?.conversationId ?? conversationId,
          ),
        }
      : undefined),
  };
  const withViewerState = withMockViewerState(
    detail,
    agentTree?.[0]?.conversationId,
  );
  const events = withViewerState.events.slice(
    -mockPageLimit(conversationId, limit),
  );
  const bounded =
    events.length < withViewerState.events.length && events[0]
      ? {
          ...withViewerState,
          events,
          previousCursor: mockBeforeCursor(conversationId, events[0].seq),
        }
      : withViewerState;
  const movedChannel = mockSlackChannelByConversationId.get(conversationId);
  const located = movedChannel
    ? { ...bounded, ...movedChannel }
    : conversationId === DASHBOARD_QA_CONVERSATION_ID
      ? // Stands in for a public dashboard conversation.
        { ...bounded, canContinueInSlack: true as const }
      : bounded;
  const withDelivery =
    located.isParticipant && !located.parentConversationId && located.channel
      ? {
          ...located,
          deliveryPaused: mockDeliveryPausedConversationIds.has(conversationId),
        }
      : located;
  return withDelivery.channel &&
    PUBLIC_MOCK_CHANNEL_IDS.has(withDelivery.channel)
    ? { ...withDelivery, locationId: `mock:${withDelivery.channel}` }
    : withDelivery;
}

/** Move the mock dashboard conversation to a mock channel thread, once. */
export function continueMockConversationInSlack(
  conversationId: string,
  locationId: string,
):
  | { channelName?: string; conversationId: string; locationUrl: string }
  | undefined {
  const channel = locationId.replace(/^mock:/, "");
  const detail = readMockConversationDetail(conversationId);
  const location = readMockLocationDirectory().locations.find(
    (candidate) => candidate.id === locationId,
  );
  if (!detail?.canContinueInSlack || !location) return undefined;
  const channelName = location.label.replace(/^#/, "");
  mockSlackChannelByConversationId.set(conversationId, {
    channel,
    channelName,
  });
  return {
    channelName,
    conversationId,
    locationUrl: `https://example.slack.com/archives/${channel}/p1770030000000100`,
  };
}

/** Return the deterministic older page used to exercise transcript pagination. */
export function readMockConversationEvents(
  conversationId: string,
  before: string,
  limit = 500,
): ConversationEventPage | undefined {
  const conversation = mockConversations(NOW_MS).find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;
  if (before === conversation.previousCursor) {
    return {
      events: mockEarlierEvents(conversation),
      eventHistory: conversation.eventHistory,
      generatedAt: NOW,
    };
  }

  const beforeSeq = parseMockBeforeCursor(conversationId, before);
  if (beforeSeq === undefined) return undefined;
  const olderEvents = conversation.events.filter(
    (event) => event.seq < beforeSeq,
  );
  const events = olderEvents.slice(-mockPageLimit(conversationId, limit));
  return {
    events,
    eventHistory: conversation.eventHistory,
    generatedAt: NOW,
    ...(events.length < olderEvents.length && events[0]
      ? { previousCursor: mockBeforeCursor(conversationId, events[0].seq) }
      : conversation.previousCursor
        ? { previousCursor: conversation.previousCursor }
        : {}),
  };
}

/** Return every event of a mock Conversation, with its earlier page. */
export function readMockConversationAllEvents(
  conversationId: string,
): ConversationEventPage | undefined {
  const conversation = mockConversations(NOW_MS).find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;
  return {
    events: [...mockEarlierEvents(conversation), ...conversation.events],
    eventHistory: conversation.eventHistory,
    generatedAt: NOW,
  };
}

/** The fixed earlier page of a Conversation that has a previous cursor. */
function mockEarlierEvents(
  conversation: ConversationDetailReport,
): ConversationReportEvent[] {
  if (!conversation.previousCursor) return [];
  return [
    reportEvent(0, iso(Date.parse(conversation.startedAt), -60_000), {
      type: "message",
      messageId: `${conversation.conversationId}:earlier`,
      role: "user",
      text: "Prepare the release and include the complete earlier context.",
    }),
  ];
}

/**
 * Return the page around a linked event or Turn. Mock transcripts fit one
 * page, so it holds every event of the Conversation.
 */
export function readMockConversationEventsAround(
  conversationId: string,
  link: { event: number } | { turn: string },
): ConversationEventPage | "turn-not-found" | undefined {
  const conversation = mockConversations(NOW_MS).find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;
  if (
    "turn" in link &&
    !conversation.events.some(
      ({ data }) =>
        data.type === "turn_lifecycle" &&
        data.state === "started" &&
        data.turnId === link.turn,
    )
  ) {
    return "turn-not-found";
  }
  const earlier = mockEarlierEvents(conversation);
  if ("event" in link && earlier.some(({ seq }) => seq === link.event)) {
    return {
      events: [...earlier, ...conversation.events],
      eventHistory: conversation.eventHistory,
      generatedAt: NOW,
    };
  }
  return {
    events: conversation.events,
    eventHistory: conversation.eventHistory,
    generatedAt: NOW,
    ...(conversation.previousCursor
      ? { previousCursor: conversation.previousCursor }
      : undefined),
  };
}

/**
 * Mock transcripts fit one page, except one that pages by 3 Turns, like the
 * API, so the outline lists messages that have not loaded.
 */
function mockPageLimit(conversationId: string, limit: number): number {
  return conversationId === MANY_TURNS_CONVERSATION_ID
    ? Math.min(limit, 6)
    : limit;
}

function mockBeforeCursor(conversationId: string, seq: number): string {
  return `mock:before:${encodeURIComponent(conversationId)}:${seq}`;
}

function parseMockBeforeCursor(
  conversationId: string,
  cursor: string,
): number | undefined {
  const prefix = `mock:before:${encodeURIComponent(conversationId)}:`;
  if (!cursor.startsWith(prefix)) return undefined;
  const seq = Number(cursor.slice(prefix.length));
  return Number.isInteger(seq) && seq >= 0 ? seq : undefined;
}

/** Build mock dashboard stats from canonical-event mock conversations. */
export function readMockConversationStats(): ConversationStatsReport {
  const nowMs = NOW_MS;
  const windowStartMs = statsWindowStartMs(nowMs);
  const summaries = activeMockSummaries(nowMs).filter((summary) => {
    const lastSeenAtMs = Date.parse(summary.lastSeenAt);
    return lastSeenAtMs >= windowStartMs && lastSeenAtMs <= nowMs;
  });
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
  const inputTokens = summaries.reduce(
    (sum, summary) => sum + (summary.cumulativeUsage?.inputTokens ?? 0),
    0,
  );
  const cachedInputTokens = summaries.reduce(
    (sum, summary) => sum + (summary.cumulativeUsage?.cachedInputTokens ?? 0),
    0,
  );
  return {
    active: total.active,
    actors: [...actorItems.values()],
    ...(cachedInputTokens ? { cachedInputTokens } : undefined),
    conversations: total.conversations,
    costUsd: total.costUsd,
    durationMs: total.durationMs,
    failed: total.failed,
    generatedAt: iso(nowMs),
    guardian: mockGuardianStats(nowMs),
    ...(inputTokens ? { inputTokens } : undefined),
    locations: [...locationItems.values()],
    metricDays: conversationMetricDays(nowMs, summaries),
    ...(() => {
      const metricHours = conversationMetricHours(nowMs, summaries);
      return {
        metricHours,
        metricSixHours: sumMockHoursIntoSixHours(
          nowMs,
          metricHours,
          (date) => ({ conversations: 0, date, durationMs: 0 }),
        ),
      };
    })(),
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

function mockPeopleActivityHours(
  nowMs: number,
  summaries: ConversationSummaryReport[],
): PeopleActivityDayReport[] {
  const byHour = new Map<
    string,
    { actors: Set<string>; conversations: number }
  >();
  for (const summary of summaries) {
    const email = summary.actorIdentity?.email?.toLowerCase();
    if (!email) continue;
    const hour = summary.lastSeenAt.slice(0, 13);
    const bucket = byHour.get(hour) ?? {
      actors: new Set<string>(),
      conversations: 0,
    };
    bucket.actors.add(email);
    bucket.conversations += 1;
    byHour.set(hour, bucket);
  }
  return trailingMetricHours(nowMs, (date) => ({
    activePeople: byHour.get(date)?.actors.size ?? 0,
    conversations: byHour.get(date)?.conversations ?? 0,
    date,
  }));
}

function mockPeopleActivitySixHours(
  nowMs: number,
  summaries: ConversationSummaryReport[],
): PeopleActivityDayReport[] {
  const bySix = new Map<
    string,
    { actors: Set<string>; conversations: number }
  >();
  for (const summary of summaries) {
    const startMs = Date.parse(summary.lastSeenAt);
    if (Number.isNaN(startMs)) continue;
    const bucket = new Date(startMs);
    bucket.setUTCMinutes(0, 0, 0);
    bucket.setUTCHours(Math.floor(bucket.getUTCHours() / 6) * 6, 0, 0, 0);
    const key = bucket.toISOString().slice(0, 13);
    const current = bySix.get(key) ?? {
      actors: new Set<string>(),
      conversations: 0,
    };
    const email = summary.actorIdentity?.email?.toLowerCase();
    if (!email) continue;
    current.actors.add(email);
    current.conversations += 1;
    bySix.set(key, current);
  }
  return trailingMetricSixHours(nowMs, (date) => {
    const row = bySix.get(date);
    return {
      activePeople: row?.actors.size ?? 0,
      conversations: row?.conversations ?? 0,
      date,
    };
  });
}

function emptyMockWindowMetrics(): ActorWindowMetrics {
  return {
    conversations: 0,
    costUsd: 0,
    durationMs: 0,
    priorCostUsd: 0,
  };
}

/** Inclusive start and exclusive end for one mock directory window. */
function mockWindowBounds(
  nowMs: number,
  range: 1 | 7 | 30 | 90,
  prior = false,
): { endExclusiveMs: number; startMs: number } {
  if (range === 1) {
    const end = new Date(nowMs);
    end.setUTCMinutes(0, 0, 0);
    const currentEndExclusiveMs = end.getTime() + 60 * 60_000;
    const endExclusiveMs =
      currentEndExclusiveMs - (prior ? 24 * 60 * 60_000 : 0);
    return {
      endExclusiveMs,
      startMs: endExclusiveMs - 24 * 60 * 60_000,
    };
  }
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const currentEndExclusiveMs = end.getTime() + 86_400_000;
  const endExclusiveMs =
    currentEndExclusiveMs - (prior ? range * 86_400_000 : 0);
  return {
    endExclusiveMs,
    startMs: endExclusiveMs - range * 86_400_000,
  };
}

function mockActorWindows(
  nowMs: number,
  summaries: ConversationSummaryReport[],
): ActorDirectoryWindows {
  const windows = {
    1: emptyMockWindowMetrics(),
    7: emptyMockWindowMetrics(),
    30: emptyMockWindowMetrics(),
    90: emptyMockWindowMetrics(),
  } satisfies ActorDirectoryWindows;

  for (const range of [1, 7, 30, 90] as const) {
    const current = mockWindowBounds(nowMs, range);
    const prior = mockWindowBounds(nowMs, range, true);
    for (const summary of summaries) {
      const seenAt = Date.parse(summary.lastSeenAt);
      const cost = summary.cumulativeUsage?.cost?.total ?? 0;
      if (seenAt >= current.startMs && seenAt < current.endExclusiveMs) {
        windows[range].conversations += 1;
        windows[range].costUsd += cost;
        windows[range].durationMs += summary.cumulativeDurationMs;
      }
      if (seenAt >= prior.startMs && seenAt < prior.endExclusiveMs) {
        windows[range].priorCostUsd += cost;
      }
    }
  }

  return windows;
}

function trailingMetricHours<T extends { date: string }>(
  nowMs: number,
  empty: (date: string) => T,
  hourCount = 7 * 24,
): T[] {
  const end = new Date(nowMs);
  end.setUTCMinutes(0, 0, 0);
  return Array.from({ length: hourCount }, (_, index) => {
    const date = new Date(
      end.getTime() - (hourCount - 1 - index) * 60 * 60 * 1_000,
    )
      .toISOString()
      .slice(0, 13);
    return empty(date);
  });
}

function trailingMetricSixHours<T extends { date: string }>(
  nowMs: number,
  empty: (date: string) => T,
  bucketCount = 7 * 4,
): T[] {
  const end = new Date(nowMs);
  end.setUTCMinutes(0, 0, 0);
  end.setUTCHours(Math.floor(end.getUTCHours() / 6) * 6, 0, 0, 0);
  return Array.from({ length: bucketCount }, (_, index) => {
    const date = new Date(
      end.getTime() - (bucketCount - 1 - index) * 6 * 60 * 60 * 1_000,
    )
      .toISOString()
      .slice(0, 13);
    return empty(date);
  });
}

function sumMockHoursIntoSixHours<T extends { date: string }>(
  nowMs: number,
  hours: readonly T[],
  empty: (date: string) => T,
): T[] {
  const bySix = new Map<string, T>();
  for (const hour of hours) {
    const startMs = Date.parse(`${hour.date}:00:00.000Z`);
    if (Number.isNaN(startMs)) continue;
    const bucket = new Date(startMs);
    bucket.setUTCMinutes(0, 0, 0);
    bucket.setUTCHours(Math.floor(bucket.getUTCHours() / 6) * 6, 0, 0, 0);
    const key = bucket.toISOString().slice(0, 13);
    const current = bySix.get(key) ?? empty(key);
    const next = { ...current, date: key } as T;
    for (const [field, value] of Object.entries(hour)) {
      if (field === "date") continue;
      if (typeof value === "number") {
        const prior = (next as Record<string, unknown>)[field];
        (next as Record<string, unknown>)[field] =
          (typeof prior === "number" ? prior : 0) + value;
      }
    }
    bySix.set(key, next);
  }
  return trailingMetricSixHours(
    nowMs,
    (date) => bySix.get(date) ?? empty(date),
  );
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
  const nowMs = NOW_MS;
  const summaries = activeMockSummaries(nowMs);
  const byEmail = new Map<
    string,
    ActorSummaryReport & {
      dates: Set<string>;
      summaries: ConversationSummaryReport[];
    }
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
      summaries: [],
      windows: mockActorWindows(nowMs, []),
    };
    existing.active += summary.status === "active" ? 1 : 0;
    existing.conversations += 1;
    existing.dates.add(summary.lastSeenAt.slice(0, 10));
    existing.activeDays = existing.dates.size;
    existing.durationMs += summary.cumulativeDurationMs;
    existing.failed += summary.status === "failed" ? 1 : 0;
    existing.summaries.push(summary);
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
  const activityHours = mockPeopleActivityHours(nowMs, summaries);
  return {
    activityDays,
    activityHours,
    activitySixHours: mockPeopleActivitySixHours(nowMs, summaries),
    generatedAt: iso(nowMs),
    people: [...byEmail.values()]
      .map(({ dates: _dates, summaries: personSummaries, ...person }) => ({
        ...person,
        windows: mockActorWindows(nowMs, personSummaries),
      }))
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
  const nowMs = NOW_MS;
  const normalized = email.toLowerCase();
  const summaries = activeMockSummaries(nowMs).filter(
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
    const costUsd = summary.cumulativeUsage?.cost?.total;
    if (costUsd !== undefined) {
      day.costUsd = (day.costUsd ?? 0) + costUsd;
    }
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

/** Build mock System operational reports for local dashboard QA. */
export function readMockPluginReports(): PluginOperationalReportFeed {
  const categories = activityDates(NOW_MS, 90).map((date, index) => {
    const briefs = index < 60 ? 0 : index % 6 === 0 ? 4 : (index % 3) + 1;
    return {
      id: date,
      label: date,
      values: { briefs, costUsd: briefs * 0.0037 },
    };
  });
  return {
    generatedAt: NOW,
    reports: [
      {
        generatedAt: NOW,
        pluginName: "briefs",
        title: "Briefs",
        metrics: [
          { label: "briefs stored", tone: "good", value: "148" },
          { label: "conversations with a brief", value: "93" },
          { label: "briefs · 30d", value: "61" },
          { label: "cost · 30d · retained", value: "$0.23" },
          {
            label: "average cost per brief · 30d · retained",
            value: "$0.0037",
          },
        ],
        widgets: [
          {
            categories,
            description: "Stored Brief versions and estimated model cost",
            id: "briefs-created",
            series: [
              { key: "briefs", label: "Briefs" },
              { format: "usd", key: "costUsd", label: "Cost" },
            ],
            timeRangeDays: [7, 30, 90],
            title: "Briefs created",
            type: "bar_chart",
          },
        ],
      },
    ],
    source: "plugins",
  };
}

/** Build mock person-scoped plugin reports for local profile QA. */
export function readMockPeoplePluginReports(
  _email: string,
): PluginOperationalReportFeed {
  const nowMs = NOW_MS;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    reports: [],
    source: "plugins",
  };
}

/** Build mock person-scoped code activity for local profile QA. */
export function readMockPeopleCode(
  email: string,
): CodePersonReport | undefined {
  const directory = readMockPeopleDirectory();
  const person = directory.people.find(
    (entry) => entry.actor.email.toLowerCase() === email.trim().toLowerCase(),
  );
  if (!person) return undefined;
  const overview = readMockCodeOverview();
  // Two weeks of merges and several open changes, so the home summary shows
  // a weekly delta and a stale change.
  const merges = [0, 1, 0, 1, 0, 1, 0, 1, 0, 2, 0, 1, 1, 0];
  const activityDays = overview.activityDays.map((day, index) => ({
    ...day,
    merged: merges[index - (overview.activityDays.length - merges.length)] ?? 0,
  }));
  const daysAgo = (days: number) =>
    new Date(NOW_MS - days * 86_400_000).toISOString();
  const openChange = (
    number: number,
    repository: string,
    title: string,
    days: number,
    idleHours?: number,
  ) => ({
    draft: false,
    id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    lastActivityAt:
      idleHours === undefined ? undefined : daysAgo(idleHours / 24),
    number,
    openedAt: daysAgo(days),
    provider: "github",
    repository,
    state: "open" as const,
    title,
    url: `https://github.com/${repository}/pull/${number}`,
  });
  const doneChange = (
    number: number,
    repository: string,
    title: string,
    openedDays: number,
    done: { closed: number } | { merged: number },
  ) => ({
    ...openChange(number, repository, title, openedDays),
    ...("merged" in done
      ? { mergedAt: daysAgo(done.merged), state: "merged" as const }
      : { closedAt: daysAgo(done.closed), state: "closed" as const }),
  });
  const openChanges = [
    openChange(2440, "getsentry/junior", "Show your week on the home page", 0),
    openChange(42, "getsentry/payments", "Reduce checkout latency", 3, 20),
    openChange(
      2391,
      "getsentry/junior",
      "Retry Slack uploads after a rate limit",
      6,
      120,
    ),
    openChange(88, "getsentry/sentry-mcp", "Bump pi-agent-core", 12, 264),
    openChange(2402, "getsentry/junior", "Cache plugin manifests", 1, 0.3),
    openChange(512, "getsentry/sentry-docs", "Document Review desk", 1, 26),
    openChange(2419, "getsentry/junior", "Trim Slack thread context", 2, 36),
    openChange(97, "getsentry/sentry-mcp", "Add trace search tool", 4, 3),
    openChange(2377, "getsentry/junior", "Split sandbox lifecycle", 5, 96),
    openChange(61, "getsentry/payments", "Drop legacy refund path", 8, 30),
    // Recorded before code changes stored titles.
    {
      ...openChange(
        523,
        "getsentry/sentry-docs",
        "Fix broken SDK links",
        10,
        216,
      ),
      title: undefined,
    },
    openChange(2350, "getsentry/junior", "Migrate memory schema", 320, 2),
  ];
  // Merges land on the days that `merges` counts in the last 7 days.
  const doneThisWeek = [
    doneChange(2330, "getsentry/junior", "Stream tool output in Slack", 9, {
      merged: 6,
    }),
    doneChange(2361, "getsentry/junior", "Add Review desk filters", 6, {
      merged: 4,
    }),
    doneChange(519, "getsentry/sentry-docs", "Document code changes", 7, {
      merged: 4,
    }),
    doneChange(2384, "getsentry/junior", "Fix sandbox snapshot reuse", 3, {
      merged: 2,
    }),
    doneChange(58, "getsentry/payments", "Try a shorter retry policy", 4, {
      closed: 2,
    }),
    doneChange(85, "getsentry/sentry-mcp", "Pin Node 22 in CI", 2, {
      merged: 1,
    }),
  ];
  // Older changes stay off the home day strip, so its counts match `merges`.
  const weekStartMs = Date.parse(activityDays.at(-7)!.date);
  const beforeWeek = (change: (typeof overview.changes)[number]) =>
    [change.openedAt, change.mergedAt, change.closedAt].every(
      (at) => at === undefined || Date.parse(at) < weekStartMs,
    );
  return {
    activityDays,
    changes: [
      ...openChanges,
      ...doneThisWeek,
      ...overview.changes.filter(
        (change) => change.state !== "open" && beforeWeek(change),
      ),
    ],
    generatedAt: overview.generatedAt,
    summary: { ...overview.summary, open: openChanges.length },
    windowEnd: overview.windowEnd,
    windowStart: overview.windowStart,
  };
}

/** Build mock rolling spend from the same personal activity used by People. */
export function readMockPersonalSpend(
  email: string,
): PersonalSpendReport | undefined {
  const profile = readMockPeopleProfile(email);
  if (!profile) return undefined;
  const spend = (days: number) =>
    Math.round(
      profile.activityDays
        .slice(-days)
        .reduce((sum, day) => sum + (day.costUsd ?? 0), 0) * 1e12,
    ) / 1e12;
  return {
    generatedAt: profile.generatedAt,
    sevenDaysUsd: spend(7),
    source: "conversation_index",
    thirtyDaysUsd: spend(30),
    windowEnd: profile.generatedAt,
    windowStart: profile.activityDays.at(-30)!.date + "T00:00:00.000Z",
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
  const nowMs = NOW_MS;
  const summaries = activeMockSummaries(nowMs);
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
  const nowMs = NOW_MS;
  const directory = readMockLocationDirectory();
  const location = directory.locations.find((item) => item.id === locationId);
  if (!location) return undefined;
  const recentConversations = activeMockSummaries(nowMs).filter(
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

/** Recent runs for the list strip, oldest first, one per `everyMs`. */
function mockRecentRuns(
  results: string,
  lastAtMs: number,
  everyMs: number,
): AutomationSummary["recentRuns"] {
  const status = { b: "blocked", c: "completed", f: "failed" } as const;
  return [...results].map((letter, index) => ({
    durationMs: 30_000 + ((index * 37) % 50) * 1_000,
    executedAt: new Date(
      lastAtMs - (results.length - 1 - index) * everyMs,
    ).toISOString(),
    status: status[letter as keyof typeof status],
  }));
}

function mockTasks(): AutomationSummary[] {
  return [
    {
      createdAt: "2026-07-28T16:00:00.000Z",
      createdBy: "Morgan",
      createdByEmail: "dev@example.com",
      destination: {
        channelId: "C123",
        label: "#project-updates",
        teamId: "T123",
        visibility: "public",
      },
      id: "scheduled-1",
      task: {
        kind: "instruction",
        instruction: "Send the weekly project summary",
      },
      kind: "scheduled",
      lastConversationId: "scheduler:daily-ops-digest",
      lastRunAt: "2026-08-06T16:00:00.000Z",
      nextRunAt: "2026-08-10T16:00:00.000Z",
      credentialMode: "creator",
      ownedByViewer: true,
      costUsd: { 1: 0.42, 7: 1.02, 30: 4.18, 90: 16.4 },
      recentRuns: mockRecentRuns(
        "cccccccccccccccfccbc",
        Date.parse("2026-08-06T16:00:00.000Z"),
        7 * 86_400_000,
      ),
      runs: { 1: 1, 7: 3, 30: 12, 90: 48 },
      timezone: "America/Los_Angeles",
      schedule: "Every Monday at 9:00 AM",
      status: "active",
      outcomes: [
        {
          action: "send_message",
          destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        },
      ],
      title: "Weekly project summary",
      totalCostUsd: 18.62,
      totalRuns: 48,
    },
    {
      createdAt: "2026-07-29T16:00:00.000Z",
      createdBy: "Morgan",
      createdByEmail: "dev@example.com",
      destination: {
        channelId: "C123",
        label: "#project-updates",
        teamId: "T123",
        visibility: "public",
      },
      id: "event-1",
      task: { kind: "instruction", instruction: "Summarize the closed issue" },
      kind: "event",
      lastConversationId: "agent-dispatch:event-1",
      lastRunAt: "2026-08-05T18:30:00.000Z",
      credentialMode: "creator",
      ownedByViewer: true,
      resource: "Issue · ACME-42",
      costUsd: { 1: 0, 7: 0.12, 30: 0.48, 90: 0.84 },
      recentRuns: mockRecentRuns(
        "ccccccc",
        Date.parse("2026-08-05T18:30:00.000Z"),
        4 * 86_400_000,
      ),
      runs: { 1: 0, 7: 1, 30: 4, 90: 7 },
      source: "github",
      outcomes: [],
      title: "Closed issue summary",
      totalCostUsd: 0.84,
      totalRuns: 7,
      trigger: {
        events: ["issue closed"],
        filters: ["labels includes bug", "repository is api or web"],
        problems: [],
      },
      status: "active",
    },
    {
      createdAt: "2026-07-30T16:00:00.000Z",
      createdBy: "Avery Chen",
      createdByEmail: "avery@sentry.io",
      destination: {
        channelId: "C456",
        label: "#incident-response",
        teamId: "T123",
        visibility: "public",
      },
      id: "event-2",
      task: {
        kind: "instruction",
        instruction: "Notify responders when the incident changes",
      },
      kind: "event",
      credentialMode: "creator",
      ownedByViewer: false,
      resource: "Incident · INC-17",
      costUsd: { 1: 0, 7: 0, 30: 0, 90: 0 },
      recentRuns: [],
      runs: { 1: 0, 7: 0, 30: 0, 90: 0 },
      source: "pagerduty",
      outcomes: [
        {
          action: "send_message",
          destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        },
      ],
      title: "Incident change alerts",
      totalCostUsd: 0,
      totalRuns: 0,
      trigger: {
        events: ["incident updated"],
        filters: [],
        problems: ["The plugin for this source is not enabled."],
      },
      status: "active",
    },
  ];
}

/** Build mock Tasks list for local dashboard development. */
export function readMockAutomationList(): AutomationList {
  return mockAutomationCollection({ automations: mockTasks() });
}

function mockStatusDays(
  nowMs: number,
): AutomationExecutionList["executionDays"] {
  return Array.from({ length: 90 }, (_, index) => {
    const date = new Date(nowMs - (89 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const completed = index % 4 === 0 ? 2 : index % 2 === 0 ? 1 : 0;
    const failed = index % 9 === 0 ? 1 : 0;
    const blocked = index % 13 === 0 ? 1 : 0;
    const costUsd = Math.round((completed + failed) * 0.21 * 100) / 100;
    return { blocked, completed, costUsd, date, failed };
  });
}

/** Build mock terminal executions for one viewer-visible task. */
export function readMockAutomationExecutions(
  id: string,
  nowMs = NOW_MS,
): AutomationExecutionList | undefined {
  const task = mockTasks().find((candidate) => candidate.id === id);
  if (!task) return undefined;
  if (task.totalRuns === 0) {
    return {
      executionDays: mockStatusDays(nowMs),
      executionHours: trailingMetricHours(nowMs, (date) => ({
        blocked: 0,
        completed: 0,
        costUsd: 0,
        date,
        failed: 0,
      })),
      executionSixHours: sumMockHoursIntoSixHours(
        nowMs,
        trailingMetricHours(nowMs, (date) => ({
          blocked: 0,
          completed: 0,
          costUsd: 0,
          date,
          failed: 0,
        })),
        (date) => ({ blocked: 0, completed: 0, costUsd: 0, date, failed: 0 }),
      ),
      executions: [],
      automation: task,
      truncated: false,
    };
  }
  const titles = [
    "Weekly project summary",
    "Ship notes for the release train",
    "Ops digest for #project-updates",
  ];
  const statuses = ["completed", "failed", "blocked", "completed"] as const;
  const costs = [0.42, 0.18, 0.07, 1.25, 0.03, undefined, 0.56, 0.09] as const;
  const durations = [
    42_000,
    18_000,
    7_500,
    95_000,
    3_200,
    undefined,
    61_000,
    12_000,
  ] as const;
  const tokens = [1_200, 480, 210, 3_400, 90, undefined, 1_800, 320] as const;
  const executions = Array.from({ length: 8 }, (_, index) => {
    const status = statuses[index % statuses.length]!;
    const hasConversation = index !== 5;
    const costUsd = costs[index % costs.length];
    const durationMs = durations[index % durations.length];
    const totalTokens = tokens[index % tokens.length];
    const executedAtMs = nowMs - index * 86_400_000 - 3_600_000;
    return {
      automationVersion: index < 3 ? 2 : 1,
      credentialMode: task.credentialMode,
      ...(status === "failed"
        ? { error: "Slack rejected the result message: channel_not_found." }
        : status === "blocked"
          ? { error: "GitHub needs the creator to reconnect their account." }
          : undefined),
      ...(task.kind === "scheduled"
        ? { scheduledFor: new Date(executedAtMs - 60_000).toISOString() }
        : undefined),
      startedAt: new Date(executedAtMs - (durationMs ?? 5_000)).toISOString(),
      ...(hasConversation
        ? {
            conversationId:
              index % 2 === 0
                ? SCHEDULER_CONVERSATION_ID
                : ACTIVE_CONVERSATION_ID,
            title: titles[index % titles.length],
            ...(costUsd !== undefined ? { costUsd } : undefined),
            ...(durationMs !== undefined ? { durationMs } : undefined),
            ...(totalTokens !== undefined ? { totalTokens } : undefined),
          }
        : undefined),
      executedAt: new Date(executedAtMs).toISOString(),
      executionId: `${id}-run-${index + 1}`,
      status,
    };
  });
  return {
    executionDays: mockStatusDays(nowMs),
    executionHours: trailingMetricHours(nowMs, (date) => ({
      blocked: 0,
      completed: 0,
      costUsd: 0,
      date,
      failed: 0,
    })),
    executionSixHours: sumMockHoursIntoSixHours(
      nowMs,
      trailingMetricHours(nowMs, (date) => ({
        blocked: 0,
        completed: 0,
        costUsd: 0,
        date,
        failed: 0,
      })),
      (date) => ({ blocked: 0, completed: 0, costUsd: 0, date, failed: 0 }),
    ),
    executions,
    automation: task,
    truncated: task.totalRuns > executions.length,
  };
}
