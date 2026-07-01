import type {
  ConversationReport as DashboardConversationReport,
  ConversationStatsItem as DashboardConversationStatsItem,
  ConversationStatsReport as DashboardConversationStatsReport,
  ConversationSubagentTranscriptReport as DashboardConversationSubagentTranscriptReport,
  RequesterActivityDayReport as DashboardRequesterActivityDayReport,
  RequesterDirectoryReport as DashboardRequesterDirectoryReport,
  RequesterIdentity as DashboardRequesterIdentity,
  RequesterProfileReport as DashboardRequesterProfileReport,
  RequesterSummaryReport as DashboardRequesterSummaryReport,
  RequesterTotalsReport as DashboardRequesterTotalsReport,
  ConversationFeed as DashboardConversationFeed,
  ConversationSummaryReport as DashboardConversationSummary,
  ConversationUsage as DashboardRunUsage,
  TranscriptMessage as DashboardTranscriptMessage,
  ConversationRunReport as DashboardRunReport,
  JuniorReporting,
} from "@sentry/junior/reporting";

import { longReleaseConversation } from "./mock-release-conversation";
import {
  mockSubagentActivity,
  mockToolActivity,
} from "./mock-reporting/activity";
import { mockConversation, mockRun } from "./mock-reporting/conversation";
import {
  mockToolCallPart,
  mockToolResultPart,
  mockTranscriptMessage,
} from "./mock-reporting/transcript";

const INCIDENT_CONVERSATION_ID = "slack:CQA123:1770000000.000100";
const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const PRIVATE_CONVERSATION_ID = "slack:DQA123:1770007200.000300";
const HUNG_CONVERSATION_ID = "slack:CQA999:1770010800.000400";
const FAILED_CONVERSATION_ID = "slack:CQA777:1770014400.000500";
const SCHEDULER_CONVERSATION_ID = "scheduler:daily-ops-digest";
export const DASHBOARD_QA_CONVERSATION_ID = "internal:dashboard-qa";
const DASHBOARD_QA_ADVISOR_CONVERSATION_ID = `junior:${DASHBOARD_QA_CONVERSATION_ID}:advisor_session`;
const RECENT_CONVERSATION_STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function iso(nowMs: number, offsetMs = 0): string {
  return new Date(nowMs + offsetMs).toISOString();
}

function sentryConversationUrl(conversationId: string): string {
  return `https://sentry.example.com/organizations/acme/explore/conversations/${encodeURIComponent(conversationId)}/`;
}

function sentryTraceUrl(traceId: string): string {
  return `https://sentry.example.com/performance/trace/${traceId}/`;
}

function summaryFromRun(run: DashboardRunReport): DashboardConversationSummary {
  const {
    activity,
    transcript,
    transcriptAvailable,
    transcriptMessageCount,
    transcriptMetadata,
    transcriptRedacted,
    transcriptRedactionReason,
    ...session
  } = run;
  return session;
}

function publicIncidentConversation(
  nowMs: number,
): DashboardConversationReport {
  const traceId = "5f2c7f7df83e4a37a03c9d4a14f4c991";
  const startedAt = iso(nowMs, -58 * 60_000);
  const secondStartedAt = iso(nowMs, -44 * 60_000);

  return {
    conversationId: INCIDENT_CONVERSATION_ID,
    displayTitle: "Checkout latency triage",
    generatedAt: iso(nowMs),
    sentryConversationUrl: sentryConversationUrl(INCIDENT_CONVERSATION_ID),
    runs: [
      {
        conversationId: INCIDENT_CONVERSATION_ID,
        displayTitle: "Checkout latency triage",
        id: "mock-incident-turn-1",
        status: "completed",
        startedAt,
        lastProgressAt: iso(nowMs, -56 * 60_000),
        lastSeenAt: iso(nowMs, -55 * 60_000),
        completedAt: iso(nowMs, -55 * 60_000),
        cumulativeDurationMs: 181_000,
        cumulativeUsage: {
          cachedInputTokens: 2200,
          inputTokens: 6900,
          outputTokens: 1400,
          totalTokens: 9700,
        },
        surface: "slack",
        requesterIdentity: {
          email: "avery@sentry.io",
          fullName: "Avery Stone",
          slackUserId: "UQA111",
          slackUserName: "avery",
        },
        channel: "CQA123",
        channelName: "proj-checkout",
        sentryTraceUrl: sentryTraceUrl(traceId),
        traceId,
        transcriptAvailable: true,
        transcriptMessageCount: 4,
        transcript: [
          {
            role: "user",
            timestamp: Date.parse(startedAt),
            parts: [
              {
                type: "text",
                text: "Can you check why checkout p95 jumped after the last deploy? Keep it short but include the likely next owner.",
              },
            ],
          },
          {
            role: "assistant",
            timestamp: Date.parse(startedAt) + 19_000,
            parts: [
              {
                type: "thinking",
                output:
                  "Correlate deploy timing, Sentry issue volume, and endpoint latency before assigning ownership.",
              },
              {
                id: "toolu_mock_trace_search",
                name: "sentry.search_traces",
                input: {
                  project: "checkout-api",
                  query: "transaction:/api/checkout p95:>2s",
                  window: "30m",
                },
                type: "tool_call",
              },
            ],
          },
          {
            role: "toolResult",
            timestamp: Date.parse(startedAt) + 51_000,
            parts: [
              {
                id: "toolu_mock_trace_search",
                name: "sentry.search_traces",
                output: {
                  examples: [
                    {
                      durationMs: 2840,
                      operation: "POST /api/checkout",
                      traceId,
                    },
                  ],
                  p95Ms: 2310,
                  suspectedSpan: "stripe.payment_intents.create",
                },
                type: "tool_result",
              },
            ],
          },
          {
            role: "assistant",
            timestamp: Date.parse(startedAt) + 163_000,
            parts: [
              {
                type: "text",
                text: [
                  "Checkout p95 is tracking the Stripe payment intent span, not app CPU. The jump starts within five minutes of the `payments-v42` deploy.",
                  "",
                  "Suggested owner: payments platform. I would ask them to compare Stripe idempotency-key behavior between `v41` and `v42` before rolling back.",
                ].join("\n"),
              },
            ],
          },
        ],
      },
      {
        conversationId: INCIDENT_CONVERSATION_ID,
        displayTitle: "Checkout latency triage",
        id: "mock-incident-turn-2",
        status: "completed",
        startedAt: secondStartedAt,
        lastProgressAt: iso(nowMs, -42 * 60_000),
        lastSeenAt: iso(nowMs, -41 * 60_000),
        completedAt: iso(nowMs, -41 * 60_000),
        cumulativeDurationMs: 206_000,
        cumulativeUsage: {
          cachedInputTokens: 3100,
          inputTokens: 5200,
          outputTokens: 950,
          totalTokens: 9250,
        },
        surface: "slack",
        requesterIdentity: {
          email: "morgan@sentry.io",
          fullName: "Morgan Lee",
          slackUserId: "UQA222",
          slackUserName: "morgan",
        },
        channel: "CQA123",
        channelName: "proj-checkout",
        sentryTraceUrl: sentryTraceUrl(traceId),
        traceId,
        transcriptAvailable: true,
        transcriptMessageCount: 3,
        transcript: [
          {
            role: "user",
            timestamp: Date.parse(secondStartedAt),
            parts: [
              {
                type: "text",
                text: "Can you draft the rollback note with the exact evidence?",
              },
            ],
          },
          {
            role: "assistant",
            timestamp: Date.parse(secondStartedAt) + 12_000,
            parts: [
              {
                id: "toolu_mock_issue_lookup",
                name: "sentry.get_issue",
                input: {
                  issue: "CHECKOUT-9B2",
                  project: "checkout-api",
                },
                type: "tool_call",
              },
              {
                id: "toolu_mock_release_lookup",
                name: "vercel.get_deployment",
                input: {
                  deployment: "payments-v42",
                  team: "acme",
                },
                type: "tool_call",
              },
            ],
          },
          {
            role: "assistant",
            timestamp: Date.parse(secondStartedAt) + 188_000,
            parts: [
              {
                type: "text",
                text: [
                  "Rollback note:",
                  "",
                  "```md",
                  "Rolling back payments-v42. Evidence: checkout p95 rose from 740ms to 2.3s, traces isolate the regression to stripe.payment_intents.create, and CHECKOUT-9B2 began after the deployment window.",
                  "```",
                  "",
                  "Keep the rollback scoped to payments; frontend traffic and auth spans look stable.",
                ].join("\n"),
              },
            ],
          },
        ],
      },
    ],
  };
}

function activeConversation(nowMs: number): DashboardConversationReport {
  const startedAt = iso(nowMs, -6 * 60_000);

  return {
    conversationId: ACTIVE_CONVERSATION_ID,
    displayTitle: "Deploy rollout watch",
    generatedAt: iso(nowMs),
    sentryConversationUrl: sentryConversationUrl(ACTIVE_CONVERSATION_ID),
    runs: [
      {
        conversationId: ACTIVE_CONVERSATION_ID,
        displayTitle: "Deploy rollout watch",
        id: "mock-active-turn-1",
        status: "active",
        startedAt,
        lastProgressAt: iso(nowMs, -18_000),
        lastSeenAt: iso(nowMs, -12_000),
        cumulativeDurationMs: 348_000,
        cumulativeUsage: {
          inputTokens: 7800,
          outputTokens: 620,
          totalTokens: 8420,
        },
        surface: "slack",
        requesterIdentity: {
          email: "sam@sentry.io",
          fullName: "Sam Rivera",
          slackUserId: "UQA333",
          slackUserName: "sam",
        },
        channel: "CQA123",
        channelName: "proj-checkout",
        transcriptAvailable: true,
        transcriptMessageCount: 2,
        transcript: [
          {
            role: "user",
            timestamp: Date.parse(startedAt),
            parts: [
              {
                type: "text",
                text: "Watch the rollout for the next few minutes and call out anything that looks unsafe.",
              },
            ],
          },
          {
            role: "assistant",
            timestamp: Date.parse(startedAt) + 41_000,
            parts: [
              {
                type: "thinking",
                output:
                  "Keep the user updated only if the rollout crosses the agreed error-budget threshold.",
              },
              {
                id: "toolu_mock_datacat_rollout",
                name: "datacat.search_logs",
                input: {
                  query: "service:checkout-api env:prod rollout:v42",
                  window: "15m",
                },
                type: "tool_call",
              },
            ],
          },
        ],
      },
    ],
  };
}

function privateConversation(nowMs: number): DashboardConversationReport {
  const startedAt = iso(nowMs, -24 * 60_000);

  return {
    conversationId: PRIVATE_CONVERSATION_ID,
    displayTitle: "Direct Message",
    generatedAt: iso(nowMs),
    runs: [
      {
        conversationId: PRIVATE_CONVERSATION_ID,
        displayTitle: "Direct Message",
        id: "mock-private-turn-1",
        status: "completed",
        startedAt,
        lastProgressAt: iso(nowMs, -23 * 60_000),
        lastSeenAt: iso(nowMs, -22 * 60_000),
        completedAt: iso(nowMs, -22 * 60_000),
        cumulativeDurationMs: 94_000,
        cumulativeUsage: {
          inputTokens: 3100,
          outputTokens: 440,
          totalTokens: 3540,
        },
        surface: "slack",
        requesterIdentity: {
          email: "private-user@sentry.io",
          slackUserId: "UQA444",
          slackUserName: "private-user",
        },
        channel: "DQA123",
        channelName: "Direct Message",
        transcriptAvailable: false,
        transcriptMessageCount: 4,
        transcriptMetadata: redactedPrivateTranscript(Date.parse(startedAt)),
        transcriptRedacted: true,
        transcriptRedactionReason: "non_public_conversation",
        transcript: [],
      },
    ],
  };
}

function redactedPrivateTranscript(
  startedAtMs: number,
): DashboardTranscriptMessage[] {
  return [
    {
      role: "user",
      timestamp: startedAtMs,
      parts: [
        {
          bytes: 174,
          chars: 172,
          redacted: true,
          type: "text",
        },
      ],
    },
    {
      role: "assistant",
      timestamp: startedAtMs + 18_000,
      parts: [
        {
          outputKeys: ["strategy", "risk"],
          outputSizeBytes: 188,
          outputSizeChars: 188,
          outputType: "object",
          redacted: true,
          type: "thinking",
        },
      ],
    },
    {
      role: "assistant",
      timestamp: startedAtMs + 29_000,
      parts: [
        {
          id: "toolu_mock_private_thread",
          inputKeys: ["channel", "ts"],
          inputSizeBytes: 58,
          inputSizeChars: 58,
          inputType: "object",
          name: "slack.fetch_thread",
          redacted: true,
          type: "tool_call",
        },
      ],
    },
    {
      role: "toolResult",
      timestamp: startedAtMs + 47_000,
      parts: [
        {
          id: "toolu_mock_private_thread",
          name: "slack.fetch_thread",
          outputKeys: ["messages"],
          outputSizeBytes: 962,
          outputSizeChars: 950,
          outputType: "object",
          redacted: true,
          type: "tool_result",
        },
      ],
    },
  ];
}

function hungConversation(nowMs: number): DashboardConversationReport {
  const startedAt = iso(nowMs, -18 * 60_000);

  return {
    conversationId: HUNG_CONVERSATION_ID,
    displayTitle: "Sandbox QA run",
    generatedAt: iso(nowMs),
    sentryConversationUrl: sentryConversationUrl(HUNG_CONVERSATION_ID),
    runs: [
      {
        conversationId: HUNG_CONVERSATION_ID,
        displayTitle: "Sandbox QA run",
        id: "mock-hung-turn-1",
        status: "hung",
        startedAt,
        lastProgressAt: iso(nowMs, -11 * 60_000),
        lastSeenAt: iso(nowMs, -10 * 60_000),
        cumulativeDurationMs: 480_000,
        cumulativeUsage: {
          inputTokens: 11_200,
          outputTokens: 800,
          totalTokens: 12_000,
        },
        surface: "slack",
        requesterIdentity: {
          email: "dana@sentry.io",
          fullName: "Dana Chen",
          slackUserId: "UQA555",
          slackUserName: "dana",
        },
        channel: "CQA999",
        channelName: "quality",
        transcriptAvailable: true,
        transcriptMessageCount: 3,
        transcript: [
          {
            role: "user",
            timestamp: Date.parse(startedAt),
            parts: [
              {
                type: "text",
                text: "Run the checkout smoke test in the sandbox and tell me if the redirect loop still reproduces.",
              },
            ],
          },
          {
            role: "assistant",
            timestamp: Date.parse(startedAt) + 35_000,
            parts: [
              {
                id: "toolu_mock_sandbox_run",
                name: "sandbox.run_command",
                input: {
                  args: ["pnpm", "test", "checkout-smoke"],
                  cwd: "/repo",
                  timeoutMs: 600000,
                },
                type: "tool_call",
              },
            ],
          },
          {
            role: "assistant",
            timestamp: Date.parse(startedAt) + 2 * 60_000,
            parts: [
              {
                type: "text",
                text: "The sandbox command started. I am waiting on the browser trace before calling the result.",
              },
            ],
          },
        ],
      },
    ],
  };
}

function failedConversation(nowMs: number): DashboardConversationReport {
  const traceId = "29bbf789f14b469cb4f6ed830a47224d";
  const startedAt = iso(nowMs, -36 * 60_000);

  return {
    conversationId: FAILED_CONVERSATION_ID,
    displayTitle: "OAuth callback investigation",
    generatedAt: iso(nowMs),
    sentryConversationUrl: sentryConversationUrl(FAILED_CONVERSATION_ID),
    runs: [
      {
        conversationId: FAILED_CONVERSATION_ID,
        displayTitle: "OAuth callback investigation",
        id: "mock-failed-turn-1",
        status: "failed",
        startedAt,
        lastProgressAt: iso(nowMs, -35 * 60_000),
        lastSeenAt: iso(nowMs, -35 * 60_000),
        cumulativeDurationMs: 72_000,
        cumulativeUsage: {
          inputTokens: 4500,
          outputTokens: 390,
          totalTokens: 4890,
        },
        surface: "slack",
        requesterIdentity: {
          email: "riley@sentry.io",
          fullName: "Riley Patel",
          slackUserId: "UQA666",
          slackUserName: "riley",
        },
        channel: "CQA777",
        channelName: "platform-auth",
        sentryTraceUrl: sentryTraceUrl(traceId),
        traceId,
        transcriptAvailable: true,
        transcriptMessageCount: 3,
        transcript: [
          {
            role: "user",
            timestamp: Date.parse(startedAt),
            parts: [
              {
                type: "text",
                text: "Why are new Notion OAuth callbacks failing in staging?",
              },
            ],
          },
          {
            role: "assistant",
            timestamp: Date.parse(startedAt) + 15_000,
            parts: [
              {
                id: "toolu_mock_oauth_logs",
                name: "sentry.search_errors",
                input: {
                  environment: "staging",
                  query: "OAuth callback Notion status:500",
                },
                type: "tool_call",
              },
            ],
          },
          {
            role: "toolResult",
            timestamp: Date.parse(startedAt) + 53_000,
            parts: [
              {
                id: "toolu_mock_oauth_logs",
                name: "sentry.search_errors",
                output: {
                  error:
                    "Provider token exchange failed: invalid_client for staging callback origin",
                  traceId,
                },
                type: "tool_result",
              },
            ],
          },
        ],
      },
    ],
  };
}

function schedulerConversation(nowMs: number): DashboardConversationReport {
  const startedAt = iso(nowMs, -2 * 60 * 60_000);

  return {
    conversationId: SCHEDULER_CONVERSATION_ID,
    displayTitle: "Daily operations digest",
    generatedAt: iso(nowMs),
    runs: [
      {
        conversationId: SCHEDULER_CONVERSATION_ID,
        displayTitle: "Daily operations digest",
        id: "mock-scheduler-turn-1",
        status: "completed",
        startedAt,
        lastProgressAt: iso(nowMs, -119 * 60_000),
        lastSeenAt: iso(nowMs, -118 * 60_000),
        completedAt: iso(nowMs, -118 * 60_000),
        cumulativeDurationMs: 115_000,
        cumulativeUsage: {
          inputTokens: 6200,
          outputTokens: 760,
          totalTokens: 6960,
        },
        surface: "scheduler",
        transcriptAvailable: true,
        transcriptMessageCount: 2,
        transcript: [
          {
            role: "user",
            timestamp: Date.parse(startedAt),
            parts: [
              {
                type: "text",
                text: "Scheduled task: summarize overnight production risk for the checkout team.",
              },
            ],
          },
          {
            role: "assistant",
            timestamp: Date.parse(startedAt) + 109_000,
            parts: [
              {
                type: "text",
                text: "Overnight risk stayed low. One staging OAuth regression is still open; checkout production latency returned to baseline after the payments rollback.",
              },
            ],
          },
        ],
      },
    ],
  };
}

function dashboardQaConversation(nowMs: number): DashboardConversationReport {
  const conversationId = DASHBOARD_QA_CONVERSATION_ID;
  const displayTitle = "Dashboard QA edge cases";
  const activityStartedAt = iso(nowMs, -11 * 60_000);
  const transcriptStartedAt = iso(nowMs, -10 * 60_000);
  const runningToolId = "toolu_mock_dashboard_running";
  const invertedToolId = "toolu_mock_dashboard_inverted";
  const advisorPlanToolId = "toolu_mock_dashboard_advisor_plan";
  const advisorReviewToolId = "toolu_mock_dashboard_advisor_review";
  const readFileToolId = "toolu_mock_dashboard_read_file";
  const editFileToolId = "toolu_mock_dashboard_edit_file";

  return mockConversation({
    conversationId,
    displayTitle,
    generatedAt: iso(nowMs),
    runs: [
      mockRun({
        conversationId,
        displayTitle,
        id: "mock-dashboard-qa-activity-only",
        status: "active",
        startedAt: activityStartedAt,
        lastProgressAt: iso(nowMs, -10 * 60_000),
        lastSeenAt: iso(nowMs, -10 * 60_000),
        cumulativeDurationMs: 60_000,
        surface: "internal",
        transcriptAvailable: true,
        transcript: [],
        transcriptMessageCount: 3,
        activity: [
          mockToolActivity({
            id: runningToolId,
            toolCallId: runningToolId,
            toolName: "mock.dashboard_running_tool",
            createdAt: iso(nowMs, -10 * 60_000),
            status: "running",
            args: { query: "activity-only edge case" },
          }),
        ],
      }),
      mockRun({
        conversationId,
        displayTitle,
        id: "mock-dashboard-qa-inverted-tool",
        status: "completed",
        startedAt: transcriptStartedAt,
        lastProgressAt: iso(nowMs, -9 * 60_000),
        lastSeenAt: iso(nowMs, -9 * 60_000),
        completedAt: iso(nowMs, -9 * 60_000),
        cumulativeDurationMs: 120_000,
        surface: "internal",
        transcriptAvailable: true,
        transcriptMessageCount: 2,
        transcript: [
          mockTranscriptMessage({
            role: "assistant",
            timestamp: Date.parse(transcriptStartedAt) + 2_000,
            parts: [
              mockToolCallPart({
                id: invertedToolId,
                name: "mock.inverted_timestamp_tool",
                input: { order: "call before result" },
              }),
            ],
          }),
          mockTranscriptMessage({
            role: "toolResult",
            timestamp: Date.parse(transcriptStartedAt) + 1_000,
            parts: [
              mockToolResultPart({
                id: invertedToolId,
                name: "mock.inverted_timestamp_tool",
                output: { ok: true },
              }),
            ],
          }),
        ],
        activity: [
          mockToolActivity({
            id: invertedToolId,
            toolCallId: invertedToolId,
            toolName: "mock.inverted_timestamp_tool",
            createdAt: transcriptStartedAt,
            status: "completed",
          }),
        ],
      }),
      mockRun({
        conversationId,
        displayTitle,
        id: "mock-dashboard-qa-advisor-code-change",
        status: "completed",
        startedAt: iso(nowMs, -8 * 60_000),
        lastProgressAt: iso(nowMs, -5 * 60_000),
        lastSeenAt: iso(nowMs, -5 * 60_000),
        completedAt: iso(nowMs, -5 * 60_000),
        cumulativeDurationMs: 180_000,
        surface: "internal",
        transcriptAvailable: true,
        transcriptMessageCount: 7,
        transcript: [
          mockTranscriptMessage({
            role: "user",
            timestamp: nowMs - 8 * 60_000,
            parts: [
              {
                type: "text",
                text: "Add a people profile page to the dashboard and make conversation emails link to the profile. Be careful with privacy and keep the UI practical.",
              },
            ],
          }),
          mockTranscriptMessage({
            role: "assistant",
            timestamp: nowMs - 8 * 60_000 + 4_000,
            parts: [
              mockToolCallPart({
                id: advisorPlanToolId,
                name: "advisor",
                input: {
                  question:
                    "Review the dashboard plan before editing. Focus on whether requester email can be trusted, what profile metrics are useful, and what UI risks to avoid.",
                },
              }),
            ],
          }),
          mockTranscriptMessage({
            role: "toolResult",
            timestamp: nowMs - 8 * 60_000 + 35_000,
            parts: [
              mockToolResultPart({
                id: advisorPlanToolId,
                name: "advisor",
                output: {
                  verdict: "proceed",
                  summary:
                    "Use trusted requesterIdentity.email, keep metrics to conversations/runtime/tokens, and make profile activity scannable before adding heavier analytics.",
                },
              }),
            ],
          }),
          mockTranscriptMessage({
            role: "assistant",
            timestamp: nowMs - 7 * 60_000 + 5_000,
            parts: [
              mockToolCallPart({
                id: readFileToolId,
                name: "readFile",
                input: {
                  path: "packages/junior-dashboard/src/client/pages/ConversationPage.tsx",
                },
              }),
              mockToolCallPart({
                id: editFileToolId,
                name: "editFile",
                input: {
                  path: "packages/junior-dashboard/src/client/pages/PeoplePage.tsx",
                  operations: [
                    {
                      action: "insert",
                      anchor: "ProfileMetrics",
                      lines: 42,
                    },
                    {
                      action: "replace",
                      anchor: "RecentConversationList",
                      lines: 18,
                    },
                  ],
                  summary:
                    "Add requester activity grid, recent conversations, and email profile links.",
                },
              }),
            ],
          }),
          mockTranscriptMessage({
            role: "toolResult",
            timestamp: nowMs - 6 * 60_000 + 10_000,
            parts: [
              mockToolResultPart({
                id: readFileToolId,
                name: "readFile",
                output: {
                  lines: 260,
                  result: "Conversation detail component inspected.",
                  imports: [
                    "Transcript",
                    "ConversationStats",
                    "ConversationIdentity",
                  ],
                  risks: {
                    auth: "dashboard routes remain authenticated",
                    privacy:
                      "requester emails are trusted from normalized reporting identity",
                  },
                },
              }),
              mockToolResultPart({
                id: editFileToolId,
                name: "editFile",
                output: {
                  filesChanged: [
                    {
                      path: "packages/junior-dashboard/src/client/pages/PeoplePage.tsx",
                      added: 216,
                      removed: 0,
                    },
                    {
                      path: "packages/junior-dashboard/src/client/components/ConversationSummary.tsx",
                      added: 18,
                      removed: 4,
                    },
                  ],
                  checks: {
                    typecheck: "passed",
                    visualQa: "needs browser review",
                  },
                  notes:
                    "The profile page uses a contribution-style activity grid, compact stat row, and searchable recent conversations. Keep the grid cell size stable so long month labels do not shift the layout.",
                },
              }),
            ],
          }),
          mockTranscriptMessage({
            role: "assistant",
            timestamp: nowMs - 6 * 60_000 + 20_000,
            parts: [
              mockToolCallPart({
                id: advisorReviewToolId,
                name: "advisor",
                input: {
                  question:
                    "Review the implementation after the first advisor pass. Check whether the UI is too noisy and whether any data shape assumptions are weak.",
                },
              }),
            ],
          }),
          mockTranscriptMessage({
            role: "toolResult",
            timestamp: nowMs - 5 * 60_000 + 20_000,
            parts: [
              mockToolResultPart({
                id: advisorReviewToolId,
                name: "advisor",
                output: {
                  verdict: "revise",
                  summary:
                    "Remove low-signal attention widgets, add list search/filtering, and verify the activity grid fills the available width.",
                },
              }),
            ],
          }),
          mockTranscriptMessage({
            role: "assistant",
            timestamp: nowMs - 5 * 60_000 + 30_000,
            parts: [
              {
                type: "text",
                text: "Implemented the people profile route, linked requester emails, and tightened the dashboard widgets based on the advisor review.",
              },
            ],
          }),
        ],
        activity: [
          mockToolActivity({
            id: advisorPlanToolId,
            toolCallId: advisorPlanToolId,
            toolName: "advisor",
            createdAt: iso(nowMs, -8 * 60_000 + 4_000),
            status: "completed",
            args: {
              question:
                "Review the dashboard plan before editing. Focus on whether requester email can be trusted, what profile metrics are useful, and what UI risks to avoid.",
            },
            subagents: [
              mockSubagentActivity({
                id: advisorPlanToolId,
                parentToolCallId: advisorPlanToolId,
                subagentKind: "advisor",
                createdAt: iso(nowMs, -8 * 60_000 + 6_000),
                endedAt: iso(nowMs, -8 * 60_000 + 35_000),
                status: "completed",
                outcome: "success",
                transcriptAvailable: true,
              }),
            ],
          }),
          mockToolActivity({
            id: readFileToolId,
            toolCallId: readFileToolId,
            toolName: "readFile",
            createdAt: iso(nowMs, -7 * 60_000 + 5_000),
            status: "completed",
            args: {
              path: "packages/junior-dashboard/src/client/pages/ConversationPage.tsx",
            },
          }),
          mockToolActivity({
            id: editFileToolId,
            toolCallId: editFileToolId,
            toolName: "editFile",
            createdAt: iso(nowMs, -7 * 60_000 + 20_000),
            status: "completed",
            args: {
              path: "packages/junior-dashboard/src/client/pages/PeoplePage.tsx",
            },
          }),
          mockToolActivity({
            id: advisorReviewToolId,
            toolCallId: advisorReviewToolId,
            toolName: "advisor",
            createdAt: iso(nowMs, -6 * 60_000 + 20_000),
            status: "completed",
            args: {
              question:
                "Review the implementation after the first advisor pass. Check whether the UI is too noisy and whether any data shape assumptions are weak.",
            },
            subagents: [
              mockSubagentActivity({
                id: advisorReviewToolId,
                parentToolCallId: advisorReviewToolId,
                subagentKind: "advisor",
                createdAt: iso(nowMs, -6 * 60_000 + 25_000),
                endedAt: iso(nowMs, -5 * 60_000 + 20_000),
                status: "completed",
                outcome: "success",
                transcriptAvailable: true,
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function dashboardQaAdvisorTranscript(
  nowMs: number,
  subagentId: string,
): DashboardConversationSubagentTranscriptReport | undefined {
  const createdAt =
    subagentId === "toolu_mock_dashboard_advisor_plan"
      ? iso(nowMs, -8 * 60_000 + 6_000)
      : subagentId === "toolu_mock_dashboard_advisor_review"
        ? iso(nowMs, -6 * 60_000 + 25_000)
        : undefined;
  const endedAt =
    subagentId === "toolu_mock_dashboard_advisor_plan"
      ? iso(nowMs, -8 * 60_000 + 35_000)
      : subagentId === "toolu_mock_dashboard_advisor_review"
        ? iso(nowMs, -5 * 60_000 + 20_000)
        : undefined;
  if (!createdAt || !endedAt) return undefined;

  const sharedAdvisorSession: DashboardTranscriptMessage[] = [
    mockTranscriptMessage({
      role: "user",
      timestamp: Date.parse(createdAt),
      parts: [
        {
          type: "text",
          text: "Review the dashboard plan before editing. Focus on whether requester email can be trusted, what profile metrics are useful, and what UI risks to avoid.",
        },
      ],
    }),
    mockTranscriptMessage({
      role: "assistant",
      timestamp: Date.parse(createdAt) + 23_000,
      parts: [
        {
          type: "text",
          text: "Requester identity email is a reasonable profile key because reporting already normalizes trusted identities. Keep the first cut narrow: total conversations, runtime, token volume, recent conversations, and a contribution-style activity grid. Avoid attention widgets until there is an explicit operator workflow.",
        },
      ],
    }),
    mockTranscriptMessage({
      role: "user",
      timestamp: Date.parse(iso(nowMs, -6 * 60_000 + 25_000)),
      parts: [
        {
          type: "text",
          text: "Review the implementation after the first advisor pass. Check whether the UI is too noisy and whether any data shape assumptions are weak.",
        },
      ],
    }),
    mockTranscriptMessage({
      role: "assistant",
      timestamp: Date.parse(endedAt),
      parts: [
        {
          type: "text",
          text: "The implementation is directionally right, but it should be more aggressive about removing weak dashboard widgets. Conversation and profile search are more useful than top-N summaries. The activity grid should use smaller fixed cells and fill the row without sparse-looking gaps.",
        },
      ],
    }),
  ];
  const slice =
    subagentId === "toolu_mock_dashboard_advisor_plan"
      ? sharedAdvisorSession.slice(0, 2)
      : sharedAdvisorSession.slice(0, 4);

  return {
    type: "subagent",
    createdAt,
    endedAt,
    id: subagentId,
    outcome: "success",
    parentToolCallId: subagentId,
    status: "success",
    subagentConversationId: DASHBOARD_QA_ADVISOR_CONVERSATION_ID,
    subagentKind: "advisor",
    subagentSentryConversationUrl: sentryConversationUrl(
      DASHBOARD_QA_ADVISOR_CONVERSATION_ID,
    ),
    transcript: slice,
    transcriptAvailable: true,
    transcriptMessageCount: 2,
  };
}

function mockConversations(nowMs: number): DashboardConversationReport[] {
  return [
    activeConversation(nowMs),
    dashboardQaConversation(nowMs),
    longReleaseConversation(nowMs),
    publicIncidentConversation(nowMs),
    privateConversation(nowMs),
    failedConversation(nowMs),
    hungConversation(nowMs),
    schedulerConversation(nowMs),
  ];
}

function mockConversationMap(
  nowMs: number,
): Map<string, DashboardConversationReport> {
  return new Map(
    mockConversations(nowMs).map((conversation) => [
      conversation.conversationId,
      conversation,
    ]),
  );
}

function mockConversationFeed(nowMs: number): DashboardConversationFeed {
  return {
    source: "conversation_index",
    generatedAt: iso(nowMs),
    conversations: mockConversations(nowMs).flatMap((conversation) =>
      conversation.runs.map(summaryFromRun),
    ),
  };
}

function mergeConversationFeeds(
  mockFeed: DashboardConversationFeed,
  realFeed: DashboardConversationFeed,
): DashboardConversationFeed {
  const mockSummaryKeys = new Set(
    mockFeed.conversations.map(
      (conversation) => `${conversation.conversationId}:${conversation.id}`,
    ),
  );

  return {
    source: realFeed.source,
    generatedAt: realFeed.generatedAt,
    conversations: [
      ...mockFeed.conversations,
      ...realFeed.conversations.filter(
        (conversation) =>
          !mockSummaryKeys.has(
            `${conversation.conversationId}:${conversation.id}`,
          ),
      ),
    ],
  };
}

function conversationStatsReportFromSummaries(
  nowMs: number,
  summaries: DashboardConversationSummary[],
): DashboardConversationStatsReport {
  const conversations = recentConversationGroups(nowMs, summaries);
  const requesters = new Map<string, DashboardConversationStatsItem>();
  const locations = new Map<string, DashboardConversationStatsItem>();
  let durationMs = 0;
  let tokens: number | undefined;
  let active = 0;
  let failed = 0;
  let hung = 0;

  for (const runs of conversations) {
    const contributions = runContributions(runs);
    const signals = statusSignals(runs);
    const conversationTokens = contributionTokenTotal(contributions);
    durationMs += contributionDurationTotal(contributions);
    tokens = addTokenTotal(tokens, conversationTokens);
    active += signals.active ? 1 : 0;
    failed += signals.failed ? 1 : 0;
    hung += signals.hung ? 1 : 0;

    const requesterRuns = new Map<string, RunContribution[]>();
    for (const contribution of contributions) {
      const requester =
        requesterLabel(contribution.run.requesterIdentity) ?? "Unknown";
      requesterRuns.set(requester, [
        ...(requesterRuns.get(requester) ?? []),
        contribution,
      ]);
    }

    for (const [requester, requesterContributions] of requesterRuns) {
      const item = requesters.get(requester) ?? emptyStatsItem(requester);
      const requesterSignals = statusSignals(
        requesterContributions.map((contribution) => contribution.run),
      );
      item.conversations += 1;
      item.runs += requesterContributions.length;
      item.durationMs += contributionDurationTotal(requesterContributions);
      item.active += requesterSignals.active ? 1 : 0;
      item.failed += requesterSignals.failed ? 1 : 0;
      item.hung += requesterSignals.hung ? 1 : 0;
      addItemTokens(item, contributionTokenTotal(requesterContributions));
      requesters.set(requester, item);
    }

    const location = locationLabel(newestRun(runs));
    const locationItem = locations.get(location) ?? emptyStatsItem(location);
    locationItem.conversations += 1;
    locationItem.runs += runs.length;
    locationItem.durationMs += contributionDurationTotal(contributions);
    locationItem.active += signals.active ? 1 : 0;
    locationItem.failed += signals.failed ? 1 : 0;
    locationItem.hung += signals.hung ? 1 : 0;
    addItemTokens(locationItem, conversationTokens);
    locations.set(location, locationItem);
  }

  return {
    active,
    conversations: conversations.length,
    durationMs,
    failed,
    generatedAt: iso(nowMs),
    hung,
    locations: statsItems(locations),
    requesters: statsItems(requesters),
    sampleLimit: summaries.length,
    sampleSize: summaries.length,
    source: "conversation_index",
    ...(tokens !== undefined ? { tokens } : {}),
    truncated: false,
    runs: conversations.reduce((sum, runs) => sum + runs.length, 0),
    windowEnd: iso(nowMs),
    windowStart: iso(nowMs, -7 * 24 * 60 * 60 * 1000),
  };
}

type RunContribution = {
  durationMs: number;
  tokens?: number;
  run: DashboardConversationSummary;
};

function reportTime(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function newestRun(
  runs: DashboardConversationSummary[],
): DashboardConversationSummary {
  return [...runs].sort(
    (left, right) =>
      (reportTime(right.lastSeenAt) ?? 0) -
        (reportTime(left.lastSeenAt) ?? 0) || right.id.localeCompare(left.id),
  )[0]!;
}

function recentConversationGroups(
  nowMs: number,
  summaries: DashboardConversationSummary[],
): DashboardConversationSummary[][] {
  const startMs = nowMs - RECENT_CONVERSATION_STATS_WINDOW_MS;
  const groups = new Map<string, DashboardConversationSummary[]>();
  for (const summary of summaries) {
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
        activityAt !== undefined && activityAt >= startMs && activityAt <= nowMs
      );
    });
}

function usageTokenTotal(usage: DashboardRunUsage | undefined) {
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

function runContributions(
  runs: DashboardConversationSummary[],
): RunContribution[] {
  let previousDuration = 0;
  let previousTokens = 0;
  return runs.map((run) => {
    const duration = Math.max(0, Math.floor(run.cumulativeDurationMs));
    const tokens = usageTokenTotal(run.cumulativeUsage);
    const contribution: RunContribution = {
      durationMs: Math.max(0, duration - previousDuration),
      run,
    };
    if (tokens !== undefined) {
      contribution.tokens = Math.max(0, tokens - previousTokens);
    }
    previousDuration = Math.max(previousDuration, duration);
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

function requesterLabel(
  requester: DashboardRequesterIdentity | undefined,
): string | undefined {
  const email = requester?.email?.trim() || undefined;
  const fullName = requester?.fullName?.trim() || undefined;
  const slackUserName = requester?.slackUserName?.trim() || undefined;
  return email ?? fullName ?? slackUserName ?? requester?.slackUserId;
}

function locationLabel(turn: DashboardConversationSummary): string {
  const channelId = turn.channel;
  const name = turn.channelName?.replace(/^#/, "");
  if (channelId?.startsWith("D")) {
    return "Direct Message";
  }
  if (channelId?.startsWith("C")) {
    return name ? `#${name}` : "Public Channel";
  }
  if (channelId?.startsWith("G")) {
    if (name?.startsWith("mpdm-")) return "Group DM";
    return "Private Channel";
  }
  return turn.surface === "scheduler"
    ? "Scheduler"
    : turn.surface === "api"
      ? "API"
      : turn.surface === "internal"
        ? "Internal"
        : (name ?? channelId ?? "Unknown");
}

function emptyStatsItem(label: string): DashboardConversationStatsItem {
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
  item: DashboardConversationStatsItem,
  tokens: number | undefined,
): void {
  if (tokens !== undefined) {
    item.tokens = (item.tokens ?? 0) + tokens;
  }
}

function statusSignals(runs: DashboardConversationSummary[]) {
  return {
    active: runs.some((turn) => turn.status === "active"),
    failed: runs.some((turn) => turn.status === "failed"),
    hung: runs.some((turn) => turn.status === "hung"),
  };
}

function statsItems(map: Map<string, DashboardConversationStatsItem>) {
  return [...map.values()].sort(
    (left, right) =>
      right.conversations - left.conversations ||
      right.runs - left.runs ||
      right.durationMs - left.durationMs ||
      left.label.localeCompare(right.label),
  );
}

function surfaceLabel(turn: DashboardConversationSummary): string {
  if (turn.surface === "scheduler") return "Scheduler";
  if (turn.surface === "api") return "API";
  if (turn.surface === "internal") return "Internal";
  return "Conversation";
}

function normalizeEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}

function identityWithEmail(
  requester: DashboardRequesterIdentity | undefined,
): (DashboardRequesterIdentity & { email: string }) | undefined {
  const email = normalizeEmail(requester?.email);
  if (!email) return undefined;
  return {
    email,
    ...(requester?.fullName ? { fullName: requester.fullName } : {}),
    ...(requester?.slackUserId ? { slackUserId: requester.slackUserId } : {}),
    ...(requester?.slackUserName
      ? { slackUserName: requester.slackUserName }
      : {}),
  };
}

function mergeIdentity(
  current: DashboardRequesterIdentity & { email: string },
  next: DashboardRequesterIdentity & { email: string },
): DashboardRequesterIdentity & { email: string } {
  return {
    email: current.email,
    ...((current.fullName ?? next.fullName)
      ? { fullName: current.fullName ?? next.fullName }
      : {}),
    ...((current.slackUserId ?? next.slackUserId)
      ? { slackUserId: current.slackUserId ?? next.slackUserId }
      : {}),
    ...((current.slackUserName ?? next.slackUserName)
      ? { slackUserName: current.slackUserName ?? next.slackUserName }
      : {}),
  };
}

function reportDate(value: string): string | undefined {
  const time = reportTime(value);
  if (time === undefined) return undefined;
  return new Date(time).toISOString().slice(0, 10);
}

function emptyRequesterTotals(): DashboardRequesterTotalsReport {
  return {
    active: 0,
    activeDays: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    hung: 0,
    runs: 0,
  };
}

function addRequesterTokens(
  target: Pick<DashboardRequesterTotalsReport, "tokens">,
  tokens: number | undefined,
): void {
  if (tokens !== undefined) {
    target.tokens = (target.tokens ?? 0) + tokens;
  }
}

function addSignals(
  target: Pick<DashboardRequesterTotalsReport, "active" | "failed" | "hung">,
  signals: ReturnType<typeof statusSignals>,
): void {
  target.active += signals.active ? 1 : 0;
  target.failed += signals.failed ? 1 : 0;
  target.hung += signals.hung ? 1 : 0;
}

type MockRequesterAccumulator = DashboardRequesterTotalsReport & {
  activeDates: Set<string>;
  firstSeenMs: number;
  lastSeenMs: number;
  requester: DashboardRequesterIdentity & { email: string };
};

function summaryGroups(
  summaries: DashboardConversationSummary[],
): DashboardConversationSummary[][] {
  const groups = new Map<string, DashboardConversationSummary[]>();
  for (const summary of summaries) {
    groups.set(summary.conversationId, [
      ...(groups.get(summary.conversationId) ?? []),
      summary,
    ]);
  }
  return [...groups.values()].map((runs) =>
    [...runs].sort(
      (left, right) =>
        (reportTime(left.startedAt) ?? 0) -
          (reportTime(right.startedAt) ?? 0) || left.id.localeCompare(right.id),
    ),
  );
}

function directoryItem(
  accumulator: MockRequesterAccumulator,
): DashboardRequesterSummaryReport {
  return {
    active: accumulator.active,
    activeDays: accumulator.activeDates.size,
    conversations: accumulator.conversations,
    durationMs: accumulator.durationMs,
    failed: accumulator.failed,
    firstSeenAt: new Date(accumulator.firstSeenMs).toISOString(),
    hung: accumulator.hung,
    lastSeenAt: new Date(accumulator.lastSeenMs).toISOString(),
    requester: accumulator.requester,
    runs: accumulator.runs,
    ...(accumulator.tokens !== undefined ? { tokens: accumulator.tokens } : {}),
  };
}

function requesterDirectoryFromFeed(
  nowMs: number,
  feed: DashboardConversationFeed,
): DashboardRequesterDirectoryReport {
  const people = new Map<string, MockRequesterAccumulator>();
  const groups = summaryGroups(feed.conversations);
  for (const runs of groups) {
    const newest = newestRun(runs);
    const requester = identityWithEmail(newest.requesterIdentity);
    if (!requester) continue;
    const contributions = runContributions(runs);
    const signals = statusSignals(runs);
    const date = reportDate(newest.lastSeenAt);
    const firstSeenMs =
      reportTime(runs[0]?.startedAt ?? newest.startedAt) ?? nowMs;
    const lastSeenMs = reportTime(newest.lastSeenAt) ?? nowMs;
    const accumulator =
      people.get(requester.email) ??
      ({
        ...emptyRequesterTotals(),
        activeDates: new Set<string>(),
        firstSeenMs,
        lastSeenMs,
        requester,
      } satisfies MockRequesterAccumulator);
    accumulator.requester = mergeIdentity(accumulator.requester, requester);
    accumulator.conversations += 1;
    accumulator.runs += runs.length;
    accumulator.durationMs += contributionDurationTotal(contributions);
    addRequesterTokens(accumulator, contributionTokenTotal(contributions));
    addSignals(accumulator, signals);
    accumulator.firstSeenMs = Math.min(accumulator.firstSeenMs, firstSeenMs);
    accumulator.lastSeenMs = Math.max(accumulator.lastSeenMs, lastSeenMs);
    if (date) accumulator.activeDates.add(date);
    people.set(requester.email, accumulator);
  }

  return {
    generatedAt: feed.generatedAt,
    people: [...people.values()]
      .map(directoryItem)
      .sort(
        (left, right) =>
          (reportTime(right.lastSeenAt) ?? 0) -
            (reportTime(left.lastSeenAt) ?? 0) ||
          left.requester.email.localeCompare(right.requester.email),
      ),
    sampleLimit: groups.length,
    sampleSize: groups.length,
    source: "conversation_index",
    truncated: false,
  };
}

function emptyActivityDay(date: string): DashboardRequesterActivityDayReport {
  return {
    active: 0,
    conversations: 0,
    date,
    durationMs: 0,
    failed: 0,
    hung: 0,
    runs: 0,
  };
}

function profileActivityDays(
  nowMs: number,
  days: Map<string, DashboardRequesterActivityDayReport>,
): DashboardRequesterActivityDayReport[] {
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 365);
  const items: DashboardRequesterActivityDayReport[] = [];
  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    items.push(days.get(date) ?? emptyActivityDay(date));
  }
  return items;
}

function requesterProfileFromFeed(
  nowMs: number,
  email: string,
  feed: DashboardConversationFeed,
): DashboardRequesterProfileReport {
  const normalized = normalizeEmail(email) ?? email;
  const groups = summaryGroups(feed.conversations);
  const matchingGroups = groups.filter((runs) =>
    runs.some(
      (run) => normalizeEmail(run.requesterIdentity?.email) === normalized,
    ),
  );
  let requester: (DashboardRequesterIdentity & { email: string }) | undefined;
  const totals = emptyRequesterTotals();
  const activeDates = new Set<string>();
  const activityDays = new Map<string, DashboardRequesterActivityDayReport>();
  const locations = new Map<string, DashboardConversationStatsItem>();
  const surfaces = new Map<string, DashboardConversationStatsItem>();
  const recentConversations: DashboardConversationSummary[] = [];

  for (const runs of matchingGroups) {
    const newest = newestRun(runs);
    const identity = identityWithEmail(newest.requesterIdentity);
    if (identity) {
      requester = requester ? mergeIdentity(requester, identity) : identity;
    }
    recentConversations.push(newest);

    const contributions = runContributions(runs);
    const signals = statusSignals(runs);
    const durationMs = contributionDurationTotal(contributions);
    const tokens = contributionTokenTotal(contributions);
    const date = reportDate(newest.lastSeenAt);

    totals.conversations += 1;
    totals.runs += runs.length;
    totals.durationMs += durationMs;
    addRequesterTokens(totals, tokens);
    addSignals(totals, signals);

    if (date) {
      activeDates.add(date);
      const day = activityDays.get(date) ?? emptyActivityDay(date);
      day.conversations += 1;
      day.runs += runs.length;
      day.durationMs += durationMs;
      addRequesterTokens(day, tokens);
      addSignals(day, signals);
      activityDays.set(date, day);
    }

    const location = locationLabel(newest);
    const locationItem = locations.get(location) ?? emptyStatsItem(location);
    locationItem.conversations += 1;
    locationItem.runs += runs.length;
    locationItem.durationMs += durationMs;
    addItemTokens(locationItem, tokens);
    locationItem.active += signals.active ? 1 : 0;
    locationItem.failed += signals.failed ? 1 : 0;
    locationItem.hung += signals.hung ? 1 : 0;
    locations.set(location, locationItem);

    const surface = surfaceLabel(newest);
    const surfaceItem = surfaces.get(surface) ?? emptyStatsItem(surface);
    surfaceItem.conversations += 1;
    surfaceItem.runs += runs.length;
    surfaceItem.durationMs += durationMs;
    addItemTokens(surfaceItem, tokens);
    surfaceItem.active += signals.active ? 1 : 0;
    surfaceItem.failed += signals.failed ? 1 : 0;
    surfaceItem.hung += signals.hung ? 1 : 0;
    surfaces.set(surface, surfaceItem);
  }

  totals.activeDays = activeDates.size;
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 365);

  return {
    activityDays: profileActivityDays(nowMs, activityDays),
    generatedAt: feed.generatedAt,
    locations: statsItems(locations),
    recentConversations: recentConversations
      .sort(
        (left, right) =>
          (reportTime(right.lastSeenAt) ?? 0) -
            (reportTime(left.lastSeenAt) ?? 0) ||
          right.conversationId.localeCompare(left.conversationId),
      )
      .slice(0, 25),
    requester: requester ?? { email: normalized },
    sampleLimit: groups.length,
    sampleSize: groups.length,
    source: "conversation_index",
    surfaces: statsItems(surfaces),
    totals,
    truncated: false,
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}

function mergeRequesterDirectories(
  mockDirectory: DashboardRequesterDirectoryReport,
  realDirectory: DashboardRequesterDirectoryReport,
): DashboardRequesterDirectoryReport {
  const people = new Map(
    mockDirectory.people.map((person) => [person.requester.email, person]),
  );
  for (const person of realDirectory.people) {
    const existing = people.get(person.requester.email);
    if (!existing) {
      people.set(person.requester.email, person);
      continue;
    }
    people.set(person.requester.email, {
      active: existing.active + person.active,
      activeDays: Math.min(
        existing.activeDays + person.activeDays,
        existing.conversations + person.conversations,
      ),
      conversations: existing.conversations + person.conversations,
      durationMs: existing.durationMs + person.durationMs,
      failed: existing.failed + person.failed,
      firstSeenAt:
        (reportTime(existing.firstSeenAt) ?? 0) <=
        (reportTime(person.firstSeenAt) ?? 0)
          ? existing.firstSeenAt
          : person.firstSeenAt,
      hung: existing.hung + person.hung,
      lastSeenAt:
        (reportTime(existing.lastSeenAt) ?? 0) >=
        (reportTime(person.lastSeenAt) ?? 0)
          ? existing.lastSeenAt
          : person.lastSeenAt,
      requester: mergeIdentity(existing.requester, person.requester),
      runs: existing.runs + person.runs,
      ...(existing.tokens !== undefined || person.tokens !== undefined
        ? { tokens: (existing.tokens ?? 0) + (person.tokens ?? 0) }
        : {}),
    });
  }
  const mergedPeople = [...people.values()];
  return {
    ...realDirectory,
    generatedAt: realDirectory.generatedAt,
    people: mergedPeople,
    sampleSize: mergedPeople.reduce(
      (total, person) => total + person.conversations,
      0,
    ),
    truncated: mockDirectory.truncated || realDirectory.truncated,
  };
}

function isLocalPersistenceUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "REDIS_URL is required for durable Slack thread state",
    )
  );
}

/** Layer visual-QA conversation fixtures over a real read-only reporting source. */
export function createMockConversationReporting(
  reporting: JuniorReporting,
): JuniorReporting {
  const overlay: JuniorReporting = {
    getHealth: reporting.getHealth,
    getRuntimeInfo: reporting.getRuntimeInfo,
    getPlugins: reporting.getPlugins,
    getSkills: reporting.getSkills,
    listRecentConversations: reporting.listRecentConversations,
    async listConversations() {
      const mockFeed = mockConversationFeed(Date.now());
      try {
        return mergeConversationFeeds(
          mockFeed,
          await reporting.listConversations(),
        );
      } catch (error) {
        if (!isLocalPersistenceUnavailable(error)) {
          throw error;
        }
        return mockFeed;
      }
    },
    async getConversationStats() {
      const nowMs = Date.now();
      const mockFeed = mockConversationFeed(nowMs);
      try {
        const mergedFeed = mergeConversationFeeds(
          mockFeed,
          await reporting.listConversations(),
        );
        return conversationStatsReportFromSummaries(
          nowMs,
          mergedFeed.conversations,
        );
      } catch (error) {
        if (!isLocalPersistenceUnavailable(error)) {
          throw error;
        }
        return conversationStatsReportFromSummaries(
          nowMs,
          mockFeed.conversations,
        );
      }
    },
    async listRequesters() {
      const nowMs = Date.now();
      const mockDirectory = requesterDirectoryFromFeed(
        nowMs,
        mockConversationFeed(nowMs),
      );
      try {
        if (!reporting.listRequesters) {
          return mockDirectory;
        }
        return mergeRequesterDirectories(
          mockDirectory,
          await reporting.listRequesters(),
        );
      } catch (error) {
        if (!isLocalPersistenceUnavailable(error)) {
          throw error;
        }
        return mockDirectory;
      }
    },
    async getRequesterProfile(email: string) {
      const nowMs = Date.now();
      const mockProfile = requesterProfileFromFeed(
        nowMs,
        email,
        mockConversationFeed(nowMs),
      );
      if (mockProfile.totals.conversations > 0) {
        return mockProfile;
      }
      if (reporting.getRequesterProfile) {
        return await reporting.getRequesterProfile(email);
      }
      return mockProfile;
    },
    async getConversation(conversationId: string) {
      const conversation = mockConversationMap(Date.now()).get(conversationId);
      if (conversation) {
        return conversation;
      }
      return reporting.getConversation(conversationId);
    },
    async getConversationSubagentTranscript(
      conversationId: string,
      _runId: string,
      subagentId: string,
    ) {
      if (conversationId === DASHBOARD_QA_CONVERSATION_ID) {
        const transcript = dashboardQaAdvisorTranscript(Date.now(), subagentId);
        if (transcript) return transcript;
      }
      return reporting.getConversationSubagentTranscript(
        conversationId,
        _runId,
        subagentId,
      );
    },
  };
  if (reporting.getPluginOperationalReports) {
    overlay.getPluginOperationalReports = reporting.getPluginOperationalReports;
  }
  return overlay;
}
