import type {
  ConversationStatsItem,
  ConversationStatsReport,
} from "@sentry/junior/api/schema";
import type {
  ActorActivityDayReport,
  ActorDirectoryReport,
  ActorIdentity,
  ActorProfileReport,
  ActorSummaryReport,
  ConversationFeed,
  ConversationSummaryReport,
  ConversationUsage,
  PeopleActivityDayReport,
} from "@sentry/junior/api/schema";
import type {
  ConversationDetailReport,
  TranscriptMessage,
} from "@sentry/junior/api/schema";
import type {
  DailyConversationActivity,
  LocationActorSummaryReport,
  LocationActivityDayReport,
  LocationDetailReport,
  LocationDirectoryReport,
  LocationSummaryReport,
} from "@sentry/junior/api/schema";
import type { ConversationSubagentTranscriptReport } from "@sentry/junior/api/schema";

import { longReleaseConversation } from "./mock-release-conversation";
import {
  mockSubagentActivity,
  mockToolActivity,
} from "./mock-reporting/activity";
import {
  mockToolCallPart,
  mockToolResultPart,
  mockTranscriptMessage,
} from "./mock-reporting/transcript";

const INCIDENT_CONVERSATION_ID = "slack:CQA123:1770000000.000100";
const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const PRIVATE_CONVERSATION_ID = "slack:DQA123:1770007200.000300";
const SANDBOX_CONVERSATION_ID = "slack:CQA999:1770010800.000400";
const FAILED_CONVERSATION_ID = "slack:CQA777:1770014400.000500";
const SCHEDULER_CONVERSATION_ID = "scheduler:daily-ops-digest";
export const DASHBOARD_QA_CONVERSATION_ID = "internal:dashboard-qa";
const DASHBOARD_QA_ADVISOR_CONVERSATION_ID = `junior:${DASHBOARD_QA_CONVERSATION_ID}:advisor_session`;
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

function sentryTraceUrl(traceId: string): string {
  return `https://sentry.example.com/performance/trace/${traceId}/`;
}

function summaryFromConversation(
  conversation: ConversationDetailReport,
): ConversationSummaryReport {
  return {
    displayTitle: conversation.displayTitle,
    cumulativeDurationMs: conversation.cumulativeDurationMs,
    conversationId: conversation.conversationId,
    status: conversation.status,
    startedAt: conversation.startedAt,
    lastSeenAt: conversation.lastSeenAt,
    lastProgressAt: conversation.lastProgressAt,
    surface: conversation.surface,
    ...(conversation.cumulativeUsage
      ? { cumulativeUsage: conversation.cumulativeUsage }
      : {}),
    ...(conversation.actorIdentity
      ? { actorIdentity: conversation.actorIdentity }
      : {}),
    ...(conversation.channel ? { channel: conversation.channel } : {}),
    ...(conversation.channelName
      ? { channelName: conversation.channelName }
      : {}),
    ...(conversation.channelNameRedacted !== undefined
      ? { channelNameRedacted: conversation.channelNameRedacted }
      : {}),
    ...(conversation.channel &&
    PUBLIC_MOCK_CHANNEL_IDS.has(conversation.channel)
      ? { locationId: mockLocationId(conversation.channel) }
      : {}),
    ...(conversation.sentryTraceUrl
      ? { sentryTraceUrl: conversation.sentryTraceUrl }
      : {}),
    ...(conversation.traceId ? { traceId: conversation.traceId } : {}),
  };
}

function publicIncidentConversation(nowMs: number): ConversationDetailReport {
  const traceId = "5f2c7f7df83e4a37a03c9d4a14f4c991";
  const secondStartedAt = iso(nowMs, -44 * 60_000);

  return {
    conversationId: INCIDENT_CONVERSATION_ID,
    displayTitle: "Checkout latency triage",
    generatedAt: iso(nowMs),
    sentryConversationUrl: sentryConversationUrl(INCIDENT_CONVERSATION_ID),
    status: "completed",
    startedAt: secondStartedAt,
    lastProgressAt: iso(nowMs, -42 * 60_000),
    lastSeenAt: iso(nowMs, -41 * 60_000),
    cumulativeDurationMs: 206_000,
    cumulativeUsage: {
      cachedInputTokens: 3100,
      inputTokens: 5200,
      outputTokens: 950,
      reasoningTokens: 420,
      totalTokens: 9250,
      cost: {
        input: 0.0156,
        output: 0.0114,
        cacheRead: 0.0062,
        total: 0.0332,
      },
    },
    surface: "slack",
    actorIdentity: {
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
  };
}

function activeConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -6 * 60_000);

  return {
    conversationId: ACTIVE_CONVERSATION_ID,
    displayTitle: "Deploy rollout watch",
    generatedAt: iso(nowMs),
    sentryConversationUrl: sentryConversationUrl(ACTIVE_CONVERSATION_ID),
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
    actorIdentity: {
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
  };
}

function privateConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -24 * 60_000);

  return {
    conversationId: PRIVATE_CONVERSATION_ID,
    displayTitle: "Direct Message",
    generatedAt: iso(nowMs),
    status: "completed",
    startedAt,
    lastProgressAt: iso(nowMs, -23 * 60_000),
    lastSeenAt: iso(nowMs, -22 * 60_000),
    cumulativeDurationMs: 94_000,
    cumulativeUsage: {
      inputTokens: 3100,
      outputTokens: 440,
      totalTokens: 3540,
    },
    surface: "slack",
    actorIdentity: {
      email: "private-user@sentry.io",
      slackUserId: "UQA444",
      slackUserName: "private-user",
    },
    channel: "DQA123",
    channelName: "Direct Message",
    channelNameRedacted: true,
    transcriptAvailable: false,
    transcriptMessageCount: 4,
    transcriptMetadata: redactedPrivateTranscript(Date.parse(startedAt)),
    transcriptRedacted: true,
    transcriptRedactionReason: "non_public_conversation",
    transcript: [],
  };
}

function redactedPrivateTranscript(startedAtMs: number): TranscriptMessage[] {
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

function sandboxConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -18 * 60_000);

  return {
    conversationId: SANDBOX_CONVERSATION_ID,
    displayTitle: "Sandbox QA run",
    generatedAt: iso(nowMs),
    sentryConversationUrl: sentryConversationUrl(SANDBOX_CONVERSATION_ID),
    status: "active",
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
    actorIdentity: {
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
  };
}

function failedConversation(nowMs: number): ConversationDetailReport {
  const traceId = "29bbf789f14b469cb4f6ed830a47224d";
  const startedAt = iso(nowMs, -36 * 60_000);

  return {
    conversationId: FAILED_CONVERSATION_ID,
    displayTitle: "OAuth callback investigation",
    generatedAt: iso(nowMs),
    sentryConversationUrl: sentryConversationUrl(FAILED_CONVERSATION_ID),
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
    actorIdentity: {
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
      {
        role: "assistant",
        outcome: "error",
        timestamp: Date.parse(startedAt) + 72_000,
        parts: [],
      },
    ],
  };
}

function schedulerConversation(nowMs: number): ConversationDetailReport {
  const startedAt = iso(nowMs, -2 * 60 * 60_000);

  return {
    conversationId: SCHEDULER_CONVERSATION_ID,
    displayTitle: "Daily operations digest",
    generatedAt: iso(nowMs),
    status: "completed",
    startedAt,
    lastProgressAt: iso(nowMs, -119 * 60_000),
    lastSeenAt: iso(nowMs, -118 * 60_000),
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
  };
}

function dashboardQaConversation(nowMs: number): ConversationDetailReport {
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

  return {
    conversationId,
    displayTitle,
    generatedAt: iso(nowMs),
    status: "completed",
    startedAt: activityStartedAt,
    lastProgressAt: iso(nowMs, -5 * 60_000),
    lastSeenAt: iso(nowMs, -5 * 60_000),
    cumulativeDurationMs: 180_000,
    surface: "internal",
    transcriptAvailable: true,
    transcriptMessageCount: 12,
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
                "Review the dashboard plan before editing. Focus on whether actor email can be trusted, what profile metrics are useful, and what UI risks to avoid.",
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
                "Use trusted actorIdentity.email, keep metrics to conversations/runtime/tokens, and make profile activity scannable before adding heavier analytics.",
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
              path: "packages/junior-dashboard/src/client/pages/people/PeoplePage.tsx",
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
                "Add actor activity grid, recent conversations, and email profile links.",
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
                  "actor emails are trusted from normalized reporting identity",
              },
            },
          }),
          mockToolResultPart({
            id: editFileToolId,
            name: "editFile",
            output: {
              filesChanged: [
                {
                  path: "packages/junior-dashboard/src/client/pages/people/PeoplePage.tsx",
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
            text: "Implemented the people profile route, linked actor emails, and tightened the dashboard widgets based on the advisor review.",
          },
        ],
      }),
    ],
    activity: [
      mockToolActivity({
        id: runningToolId,
        toolCallId: runningToolId,
        toolName: "mock.dashboard_running_tool",
        createdAt: iso(nowMs, -10 * 60_000),
        status: "running",
        args: { query: "activity-only edge case" },
      }),
      mockToolActivity({
        id: invertedToolId,
        toolCallId: invertedToolId,
        toolName: "mock.inverted_timestamp_tool",
        createdAt: transcriptStartedAt,
        status: "completed",
      }),
      mockToolActivity({
        id: advisorPlanToolId,
        toolCallId: advisorPlanToolId,
        toolName: "advisor",
        createdAt: iso(nowMs, -8 * 60_000 + 4_000),
        status: "completed",
        args: {
          question:
            "Review the dashboard plan before editing. Focus on whether actor email can be trusted, what profile metrics are useful, and what UI risks to avoid.",
        },
        subagents: [
          mockSubagentActivity({
            id: advisorPlanToolId,
            modelId: "openai/gpt-5.6-sol",
            parentToolCallId: advisorPlanToolId,
            reasoningLevel: "high",
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
          path: "packages/junior-dashboard/src/client/pages/people/PeoplePage.tsx",
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
            modelId: "openai/gpt-5.6-sol",
            parentToolCallId: advisorReviewToolId,
            reasoningLevel: "high",
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
  };
}

function dashboardQaAdvisorTranscript(
  nowMs: number,
  subagentId: string,
): ConversationSubagentTranscriptReport | undefined {
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

  const sharedAdvisorSession: TranscriptMessage[] = [
    mockTranscriptMessage({
      role: "user",
      timestamp: Date.parse(createdAt),
      parts: [
        {
          type: "text",
          text: "Review the dashboard plan before editing. Focus on whether actor email can be trusted, what profile metrics are useful, and what UI risks to avoid.",
        },
      ],
    }),
    mockTranscriptMessage({
      role: "assistant",
      timestamp: Date.parse(createdAt) + 23_000,
      parts: [
        {
          type: "text",
          text: "Actor identity email is a reasonable profile key because reporting already normalizes trusted identities. Keep the first cut narrow: total conversations, runtime, token volume, recent conversations, and a contribution-style activity grid. Avoid attention widgets until there is an explicit operator workflow.",
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
    modelId: "openai/gpt-5.6-sol",
    outcome: "success",
    parentToolCallId: subagentId,
    reasoningLevel: "high",
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

function mockConversations(nowMs: number): ConversationDetailReport[] {
  return [
    activeConversation(nowMs),
    dashboardQaConversation(nowMs),
    longReleaseConversation(nowMs),
    publicIncidentConversation(nowMs),
    privateConversation(nowMs),
    failedConversation(nowMs),
    sandboxConversation(nowMs),
    schedulerConversation(nowMs),
  ].map((conversation) => ({
    modelId: "openai/gpt-5.6-sol",
    reasoningLevel: "high",
    ...conversation,
  }));
}

function mockConversationMap(
  nowMs: number,
): Map<string, ConversationDetailReport> {
  return new Map(
    mockConversations(nowMs).map((conversation) => [
      conversation.conversationId,
      conversation,
    ]),
  );
}

function mockConversationFeed(nowMs: number): ConversationFeed {
  return {
    source: "conversation_index",
    generatedAt: iso(nowMs),
    conversations: mockConversations(nowMs).map(summaryFromConversation),
  };
}

function mockPeopleActivityDays(
  nowMs: number,
  conversations: ConversationSummaryReport[],
): PeopleActivityDayReport[] {
  const sparse = new Map<
    string,
    { actors: Set<string>; conversations: number }
  >();
  for (const conversation of conversations) {
    const email = conversation.actorIdentity?.email?.trim().toLowerCase();
    if (!email) continue;
    const date = conversation.lastSeenAt.slice(0, 10);
    const day = sparse.get(date) ?? { actors: new Set(), conversations: 0 };
    day.actors.add(email);
    day.conversations += 1;
    sparse.set(date, day);
  }

  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (PEOPLE_ACTIVITY_DAYS - 1));
  const days: PeopleActivityDayReport[] = [];
  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    const day = sparse.get(date);
    days.push({
      activePeople: day?.actors.size ?? 0,
      conversations: day?.conversations ?? 0,
      date,
    });
  }
  return days;
}

/** Build mock People analytics from the explicit visual-QA conversation feed. */
export function readMockPeopleDirectory(): ActorDirectoryReport {
  const nowMs = Date.now();
  const conversations = mockConversationFeed(nowMs).conversations;
  const people = new Map<string, ActorSummaryReport & { dates: Set<string> }>();
  for (const conversation of conversations) {
    const actor = conversation.actorIdentity;
    const email = actor?.email?.trim().toLowerCase();
    if (!actor || !email) continue;
    const existing = people.get(email) ?? {
      active: 0,
      activeDays: 0,
      conversations: 0,
      dates: new Set<string>(),
      durationMs: 0,
      failed: 0,
      firstSeenAt: conversation.startedAt,
      lastSeenAt: conversation.lastSeenAt,
      actor: { ...actor, email },
    };
    existing.active += conversation.status === "active" ? 1 : 0;
    existing.conversations += 1;
    existing.dates.add(conversation.lastSeenAt.slice(0, 10));
    existing.activeDays = existing.dates.size;
    existing.durationMs += conversation.cumulativeDurationMs;
    existing.failed += conversation.status === "failed" ? 1 : 0;
    existing.firstSeenAt =
      Date.parse(conversation.startedAt) < Date.parse(existing.firstSeenAt)
        ? conversation.startedAt
        : existing.firstSeenAt;
    existing.lastSeenAt =
      Date.parse(conversation.lastSeenAt) > Date.parse(existing.lastSeenAt)
        ? conversation.lastSeenAt
        : existing.lastSeenAt;
    const tokens = usageTokenTotal(conversation.cumulativeUsage);
    if (tokens !== undefined) {
      existing.tokens = (existing.tokens ?? 0) + tokens;
    }
    people.set(email, existing);
  }
  const activityDays = mockPeopleActivityDays(nowMs, conversations);
  return {
    activityDays,
    generatedAt: iso(nowMs),
    people: [...people.values()]
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

/** Build one mock People profile from the explicit visual-QA conversation feed. */
export function readMockPeopleProfile(
  email: string,
): ActorProfileReport | undefined {
  const nowMs = Date.now();
  const normalizedEmail = email.trim().toLowerCase();
  const conversations = mockConversationFeed(nowMs).conversations.filter(
    (conversation) =>
      conversation.actorIdentity?.email?.trim().toLowerCase() ===
      normalizedEmail,
  );
  const actor = conversations[0]?.actorIdentity;
  if (!actor?.email) return undefined;

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

  for (const conversation of conversations) {
    totals.active += conversation.status === "active" ? 1 : 0;
    totals.conversations += 1;
    totals.durationMs += conversation.cumulativeDurationMs;
    totals.failed += conversation.status === "failed" ? 1 : 0;
    const tokens = usageTokenTotal(conversation.cumulativeUsage);
    if (tokens !== undefined) totals.tokens = (totals.tokens ?? 0) + tokens;

    const date = conversation.lastSeenAt.slice(0, 10);
    activeDates.add(date);
    const day = sparseDays.get(date) ?? {
      active: 0,
      conversations: 0,
      date,
      durationMs: 0,
      failed: 0,
    };
    day.active += conversation.status === "active" ? 1 : 0;
    day.conversations += 1;
    day.durationMs += conversation.cumulativeDurationMs;
    day.failed += conversation.status === "failed" ? 1 : 0;
    if (tokens !== undefined) day.tokens = (day.tokens ?? 0) + tokens;
    sparseDays.set(date, day);

    const place = locationLabel(conversation);
    const location = locations.get(place) ?? emptyStatsItem(place);
    addConversationStats(location, conversation);
    locations.set(place, location);

    const surfaceLabel =
      conversation.surface === "api"
        ? "API"
        : `${conversation.surface.charAt(0).toUpperCase()}${conversation.surface.slice(1)}`;
    const surface = surfaces.get(surfaceLabel) ?? emptyStatsItem(surfaceLabel);
    addConversationStats(surface, conversation);
    surfaces.set(surfaceLabel, surface);
  }
  totals.activeDays = activeDates.size;

  const activityDays: ActorActivityDayReport[] = [];
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  for (
    let offset = PEOPLE_PROFILE_ACTIVITY_DAYS - 1;
    offset >= 0;
    offset -= 1
  ) {
    const cursor = new Date(end);
    cursor.setUTCDate(cursor.getUTCDate() - offset);
    const date = cursor.toISOString().slice(0, 10);
    activityDays.push(
      sparseDays.get(date) ?? {
        active: 0,
        conversations: 0,
        date,
        durationMs: 0,
        failed: 0,
      },
    );
  }

  return {
    activityDays,
    generatedAt: iso(nowMs),
    locations: statsItems(locations).map(
      ({ costUsd: _costUsd, ...item }) => item,
    ),
    recentConversations: conversations.map(
      ({
        cumulativeUsage: _usage,
        sentryTraceUrl: _url,
        traceId: _trace,
        ...item
      }) => item,
    ),
    actor: { ...actor, email: normalizedEmail },
    source: "conversation_index",
    surfaces: statsItems(surfaces).map(
      ({ costUsd: _costUsd, ...item }) => item,
    ),
    totals,
    windowEnd: `${activityDays.at(-1)!.date}T00:00:00.000Z`,
    windowStart: `${activityDays[0]!.date}T00:00:00.000Z`,
  };
}

function conversationStatsReportFromSummaries(
  nowMs: number,
  summaries: ConversationSummaryReport[],
): ConversationStatsReport {
  const windowStart = new Date(nowMs);
  windowStart.setUTCHours(0, 0, 0, 0);
  windowStart.setUTCDate(windowStart.getUTCDate() - 89);
  const windowStartMs = windowStart.getTime();
  const conversations = summaries.filter((conversation) => {
    const lastSeenAt = Date.parse(conversation.lastSeenAt);
    return lastSeenAt >= windowStartMs && lastSeenAt <= nowMs;
  });
  const actors = new Map<string, ConversationStatsItem>();
  const locations = new Map<string, ConversationStatsItem>();
  const metricDays = new Map<
    string,
    { costUsd?: number; date: string; durationMs: number; tokens?: number }
  >();
  for (let offset = 89; offset >= 0; offset -= 1) {
    const date = new Date(nowMs);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    metricDays.set(key, { date: key, durationMs: 0 });
  }
  let durationMs = 0;
  let costUsd: number | undefined;
  let tokens: number | undefined;
  let active = 0;
  let failed = 0;

  for (const conversation of conversations) {
    const conversationCostUsd = usageCostTotal(conversation.cumulativeUsage);
    const conversationTokens = usageTokenTotal(conversation.cumulativeUsage);
    durationMs += conversation.cumulativeDurationMs;
    const date = conversation.lastSeenAt.slice(0, 10);
    const metricDay = metricDays.get(date);
    if (metricDay) {
      metricDay.durationMs += conversation.cumulativeDurationMs;
      if (conversationCostUsd !== undefined) {
        metricDay.costUsd = addUsd(metricDay.costUsd, conversationCostUsd);
      }
      if (conversationTokens !== undefined) {
        metricDay.tokens = (metricDay.tokens ?? 0) + conversationTokens;
      }
    }
    costUsd =
      conversationCostUsd === undefined
        ? costUsd
        : addUsd(costUsd, conversationCostUsd);
    tokens = addTokenTotal(tokens, conversationTokens);
    active += conversation.status === "active" ? 1 : 0;
    failed += conversation.status === "failed" ? 1 : 0;

    const actor = actorLabel(conversation.actorIdentity) ?? "Unknown";
    const actorItem = actors.get(actor) ?? emptyStatsItem(actor);
    addConversationStats(actorItem, conversation);
    actors.set(actor, actorItem);

    const location = locationLabel(conversation);
    const locationItem = locations.get(location) ?? emptyStatsItem(location);
    addConversationStats(locationItem, conversation);
    locations.set(location, locationItem);
  }

  return {
    active,
    conversations: conversations.length,
    durationMs,
    failed,
    generatedAt: iso(nowMs),
    metricDays: [...metricDays.values()],
    locations: statsItems(locations),
    actors: statsItems(actors),
    source: "conversation_index",
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    windowEnd: iso(nowMs),
    windowStart: iso(windowStartMs),
  };
}

/** Build mock dashboard stats from the explicit mock conversation feed. */
export function readMockConversationStats(): ConversationStatsReport {
  const feed = mockConversationFeed(Date.now());
  return conversationStatsReportFromSummaries(Date.now(), feed.conversations);
}

function mockLocationId(channel: string): string {
  return `mock:${channel}`;
}

/** Admit only explicitly public mock destinations as named locations. */
function publicMockLocation(
  conversation: ConversationSummaryReport,
): LocationSummaryReport | undefined {
  const channel = conversation.channel;
  if (!channel || !PUBLIC_MOCK_CHANNEL_IDS.has(channel)) return undefined;
  return {
    ...emptyStatsItem(locationLabel(conversation)),
    firstSeenAt: conversation.startedAt,
    id: mockLocationId(channel),
    kind: "channel",
    lastSeenAt: conversation.lastSeenAt,
    provider: "slack",
    providerDestinationId: channel,
    visibility: "public",
  };
}

/** Aggregate the typed mock feed into the location directory wire report. */
function mockLocationDirectory(nowMs: number): LocationDirectoryReport {
  const summaries = mockConversationFeed(nowMs).conversations;
  const locations = new Map<string, LocationSummaryReport>();
  const privateActivity = emptyStatsItem("Private activity");
  const sparseActivity = new Map<string, LocationActivityDayReport>();

  for (const conversation of summaries) {
    const initial = publicMockLocation(conversation);
    const date = conversation.lastSeenAt.slice(0, 10);
    const day = sparseActivity.get(date) ?? {
      date,
      privateConversations: 0,
      publicConversations: 0,
    };
    if (initial) day.publicConversations += 1;
    else day.privateConversations += 1;
    sparseActivity.set(date, day);
    if (!initial) {
      addConversationStats(privateActivity, conversation);
      continue;
    }
    const location = locations.get(initial.id) ?? initial;
    addConversationStats(location, conversation);
    if (Date.parse(conversation.startedAt) < Date.parse(location.firstSeenAt)) {
      location.firstSeenAt = conversation.startedAt;
    }
    if (Date.parse(conversation.lastSeenAt) > Date.parse(location.lastSeenAt)) {
      location.lastSeenAt = conversation.lastSeenAt;
    }
    locations.set(location.id, location);
  }

  const activityDays: LocationActivityDayReport[] = [];
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  for (let offset = 89; offset >= 0; offset -= 1) {
    const cursor = new Date(end);
    cursor.setUTCDate(cursor.getUTCDate() - offset);
    const date = cursor.toISOString().slice(0, 10);
    activityDays.push(
      sparseActivity.get(date) ?? {
        date,
        privateConversations: 0,
        publicConversations: 0,
      },
    );
  }

  return {
    activityDays,
    generatedAt: iso(nowMs),
    locations: [...locations.values()].sort(
      (left, right) =>
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt),
    ),
    privateActivity,
    source: "conversation_index",
    windowEnd: `${activityDays.at(-1)!.date}T00:00:00.000Z`,
    windowStart: `${activityDays[0]!.date}T00:00:00.000Z`,
  };
}

/** Fill the fixed 90-day activity series used by mock location detail. */
function mockLocationActivityDays(
  nowMs: number,
  conversations: ConversationSummaryReport[],
): DailyConversationActivity[] {
  const days = new Map<string, DailyConversationActivity>();
  for (const conversation of conversations) {
    const date = conversation.lastSeenAt.slice(0, 10);
    const day = days.get(date) ?? {
      active: 0,
      conversations: 0,
      date,
      durationMs: 0,
      failed: 0,
    };
    day.conversations += 1;
    day.durationMs += conversation.cumulativeDurationMs;
    day.active += conversation.status === "active" ? 1 : 0;
    day.failed += conversation.status === "failed" ? 1 : 0;
    const tokens = usageTokenTotal(conversation.cumulativeUsage);
    if (tokens !== undefined) day.tokens = (day.tokens ?? 0) + tokens;
    days.set(date, day);
  }
  const result: DailyConversationActivity[] = [];
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  for (let offset = 89; offset >= 0; offset -= 1) {
    const cursor = new Date(end);
    cursor.setUTCDate(cursor.getUTCDate() - offset);
    const date = cursor.toISOString().slice(0, 10);
    result.push(
      days.get(date) ?? {
        active: 0,
        conversations: 0,
        date,
        durationMs: 0,
        failed: 0,
      },
    );
  }
  return result;
}

/** Build the typed mock location directory used by dashboard visual QA. */
export function readMockLocationDirectory(): LocationDirectoryReport {
  return mockLocationDirectory(Date.now());
}

/** Build one typed public-location detail report for dashboard visual QA. */
export function readMockLocationDetail(
  locationId: string,
): LocationDetailReport | undefined {
  const nowMs = Date.now();
  const location = mockLocationDirectory(nowMs).locations.find(
    (item) => item.id === locationId,
  );
  if (!location) return undefined;
  const conversations = mockConversationFeed(nowMs).conversations.filter(
    (conversation) =>
      conversation.channel === location.providerDestinationId &&
      PUBLIC_MOCK_CHANNEL_IDS.has(conversation.channel ?? ""),
  );
  const actors = new Map<string, LocationActorSummaryReport>();
  for (const conversation of conversations) {
    const actor = conversation.actorIdentity;
    const key = actor?.email ?? actor?.slackUserId;
    if (!actor || !key) continue;
    const label = actorLabel(actor) ?? "Unknown";
    const item = actors.get(key) ?? {
      ...emptyStatsItem(label),
      actor,
    };
    addConversationStats(item, conversation);
    actors.set(key, item);
  }
  const activityDays = mockLocationActivityDays(nowMs, conversations);
  return {
    ...location,
    activityDays,
    actors: [...actors.values()].sort(
      (left, right) =>
        right.conversations - left.conversations ||
        left.label.localeCompare(right.label),
    ),
    generatedAt: iso(nowMs),
    recentConversations: conversations,
    source: "conversation_index",
    windowEnd: `${activityDays.at(-1)?.date}T00:00:00.000Z`,
    windowStart: `${activityDays[0]?.date}T00:00:00.000Z`,
  };
}

function usageTokenTotal(usage: ConversationUsage | undefined) {
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

function usageCostTotal(usage: ConversationUsage | undefined) {
  if (!usage?.cost) return undefined;
  if (
    typeof usage.cost.total === "number" &&
    Number.isFinite(usage.cost.total)
  ) {
    return Math.max(0, usage.cost.total);
  }
  return [
    usage.cost.input,
    usage.cost.output,
    usage.cost.cacheRead,
    usage.cost.cacheWrite,
  ].reduce<number | undefined>((sum, value) => {
    const amount =
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, value)
        : undefined;
    return amount === undefined ? sum : (sum ?? 0) + amount;
  }, undefined);
}

function addUsd(left: number | undefined, right: number): number {
  return Math.round(((left ?? 0) + right) * 1e12) / 1e12;
}

function addTokenTotal(
  total: number | undefined,
  tokens: number | undefined,
): number | undefined {
  return tokens === undefined ? total : (total ?? 0) + tokens;
}

function actorLabel(actor: ActorIdentity | undefined): string | undefined {
  const email = actor?.email?.trim() || undefined;
  const fullName = actor?.fullName?.trim() || undefined;
  const slackUserName = actor?.slackUserName?.trim() || undefined;
  return email ?? fullName ?? slackUserName ?? actor?.slackUserId;
}

function locationLabel(conversation: ConversationSummaryReport): string {
  const channelId = conversation.channel;
  const name = conversation.channelName?.replace(/^#/, "");
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
  return conversation.surface === "scheduler"
    ? "Scheduler"
    : conversation.surface === "api"
      ? "API"
      : conversation.surface === "internal"
        ? "Internal"
        : (name ?? channelId ?? "Unknown");
}

function emptyStatsItem(label: string): ConversationStatsItem {
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    label,
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

function addItemCost(
  item: ConversationStatsItem,
  costUsd: number | undefined,
): void {
  if (costUsd !== undefined) {
    item.costUsd = addUsd(item.costUsd, costUsd);
  }
}

function addConversationStats(
  item: ConversationStatsItem,
  conversation: ConversationSummaryReport,
): void {
  item.conversations += 1;
  item.durationMs += conversation.cumulativeDurationMs;
  item.active += conversation.status === "active" ? 1 : 0;
  item.failed += conversation.status === "failed" ? 1 : 0;
  addItemTokens(item, usageTokenTotal(conversation.cumulativeUsage));
  addItemCost(item, usageCostTotal(conversation.cumulativeUsage));
}

function statsItems(map: Map<string, ConversationStatsItem>) {
  return [...map.values()].sort(
    (left, right) =>
      right.conversations - left.conversations ||
      right.durationMs - left.durationMs ||
      left.label.localeCompare(right.label),
  );
}

/** Return the explicit visual-QA conversation feed, optionally scoped by actor. */
export function readMockConversationFeed(
  actorEmail?: string,
): ConversationFeed {
  const feed = mockConversationFeed(Date.now());
  if (!actorEmail) return feed;
  return {
    ...feed,
    conversations: feed.conversations.filter(
      (conversation) =>
        conversation.actorIdentity?.email?.toLowerCase() === actorEmail,
    ),
  };
}

/** Return one explicit visual-QA conversation detail fixture. */
export function readMockConversationDetail(
  conversationId: string,
): ConversationDetailReport | undefined {
  const conversation = mockConversationMap(Date.now()).get(conversationId);
  if (!conversation) return undefined;
  return conversation.channel &&
    PUBLIC_MOCK_CHANNEL_IDS.has(conversation.channel)
    ? { ...conversation, locationId: mockLocationId(conversation.channel) }
    : conversation;
}

/** Return one explicit visual-QA subagent transcript fixture. */
export function readMockConversationSubagent(
  conversationId: string,
  subagentId: string,
): ConversationSubagentTranscriptReport {
  if (conversationId === DASHBOARD_QA_CONVERSATION_ID) {
    const report = dashboardQaAdvisorTranscript(Date.now(), subagentId);
    if (report) return report;
  }
  return {
    type: "subagent",
    createdAt: new Date(0).toISOString(),
    id: subagentId,
    status: "error",
    subagentKind: "unknown",
    transcript: [],
    transcriptAvailable: false,
    unavailableReason: "not_found",
  };
}
