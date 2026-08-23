/** Deterministic reporting fixtures for local dashboard development and QA. */
import type {
  ActorDirectoryReport,
  ActorActivityDayReport,
  ActorIdentity,
  ActorProfileReport,
  ActorSummaryReport,
  ConversationDetailReport,
  ConversationEventPage,
  ConversationFeed,
  ConversationPendingMessagesReport,
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
  PersonalSpendReport,
  PluginOperationalReportFeed,
  TaskExecutionList,
  TaskList,
  TaskSummary,
} from "@sentry/junior/api/schema";

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const INCIDENT_CONVERSATION_ID = "slack:CQA123:1770000000.000100";
const PRIVATE_CONVERSATION_ID = "slack:DQA123:1770007200.000300";
const SANDBOX_CONVERSATION_ID = "slack:CQA999:1770010800.000400";
const FAILED_CONVERSATION_ID = "slack:CQA777:1770014400.000500";
const LONG_CONVERSATION_ID = "slack:CQA456:1770021600.000600";
const SCHEDULER_CONVERSATION_ID = "scheduler:daily-ops-digest";
export const DASHBOARD_QA_CONVERSATION_ID = "internal:dashboard-qa";
export const ARCHIVED_CONVERSATION_ID = "internal:archived-restore-qa";
const DASHBOARD_QA_PLAN_ID = "junior:internal:dashboard-qa:advisor-plan";
const DASHBOARD_QA_REVIEW_ID = "junior:internal:dashboard-qa:advisor-review";
/** Process-local archive state so mock restore can be exercised in visual QA. */
const mockArchivedConversationIds = new Set<string>([ARCHIVED_CONVERSATION_ID]);
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

function slackSourceUrl(channelId: string, threadTs: string): string {
  const [seconds, fraction = ""] = threadTs.split(".");
  const pathTs = `p${seconds}${(fraction ?? "").padEnd(6, "0").slice(0, 6)}`;
  return `https://sentry.slack.com/archives/${channelId}/${pathTs}?thread_ts=${threadTs}&cid=${channelId}`;
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
  | "isParticipant"
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
    isParticipant: options.isParticipant ?? false,
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
        kind: "resource_link",
        key: "getsentry/payments#42",
        label: "getsentry/payments#42",
        plugin: "github",
        status: "open",
        url: "https://github.com/getsentry/payments/pull/42",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 12_000),
      },
    ],
    auxiliaryCosts: {
      costUsd: 0.0021,
      operations: [
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
    modelUsage: [
      {
        modelId: "openai/gpt-5.6-sol",
        usage: usage(0.041),
      },
    ],
    sentryConversationUrl: sentryConversationUrl(ACTIVE_CONVERSATION_ID),
    sourceUrl: slackSourceUrl("CQA123", "1770003600.000200"),
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
      reportEvent(3, iso(Date.parse(startedAt), 9_000), {
        type: "turn_routed",
        turnId: "active-turn",
        modelProfile: "handoff",
        modelId: "openai/gpt-5.6-sol",
        reasoningLevel: "high",
        confidence: 0.93,
        source: "router",
      }),
      reportEvent(4, iso(Date.parse(startedAt), 10_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "active-search",
            name: "webSearch",
            status: "running",
          },
        ],
      }),
      reportEvent(5, iso(Date.parse(startedAt), 14_000), {
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
      }),
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
          "| Window | p95 | Errors |",
          "| --- | ---: | ---: |",
          "| pre-deploy | 210ms | 0.4% |",
          "| post-deploy | **890ms** | 0.5% |",
          "| canary only | 860ms | 0.5% |",
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
        text: "Compare the pre/post deploy spans next.",
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
        plugin: "github",
        status: "merged",
        url: "https://github.com/getsentry/sentry/pull/121727",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 20_000),
      },
    ],
    cumulativeDurationMs: 98_000,
    events: [
      reportEvent(0, startedAt, {
        type: "message",
        messageId: "qa-user",
        role: "user",
        text: "Review the dashboard plan before editing.",
        actorIdentity: actor(undefined, "Taylor Chen", "taylor"),
      }),
      reportEvent(1, iso(Date.parse(startedAt), 2_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "qa-advisor",
            name: "advisor",
            status: "running",
          },
        ],
      }),
      reportEvent(2, iso(Date.parse(startedAt), 3_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "qa-advisor",
            name: "advisor",
            status: "running",
            startedSeq: 1,
            startedAt: iso(Date.parse(startedAt), 2_000),
            input: { task: "Review the dashboard plan" },
          },
        ],
      }),
      reportEvent(3, iso(Date.parse(startedAt), 4_000), {
        type: "subagent",
        startedSeq: 3,
        startedAt: iso(Date.parse(startedAt), 4_000),
        childConversationId: DASHBOARD_QA_PLAN_ID,
        subagentKind: "advisor",
        parentToolCallId: "qa-advisor",
        status: "running",
      }),
      reportEvent(4, iso(Date.parse(startedAt), 20_000), {
        type: "subagent",
        startedSeq: 3,
        startedAt: iso(Date.parse(startedAt), 4_000),
        childConversationId: DASHBOARD_QA_PLAN_ID,
        subagentKind: "advisor",
        parentToolCallId: "qa-advisor",
        status: "completed",
      }),
      reportEvent(5, iso(Date.parse(startedAt), 21_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "qa-advisor",
            name: "advisor",
            status: "completed",
            startedSeq: 1,
            startedAt: iso(Date.parse(startedAt), 2_000),
            output: { child_conversation_id: DASHBOARD_QA_PLAN_ID },
          },
        ],
      }),
      reportEvent(6, iso(Date.parse(startedAt), 25_000), {
        type: "subagent",
        startedSeq: 6,
        startedAt: iso(Date.parse(startedAt), 25_000),
        childConversationId: DASHBOARD_QA_REVIEW_ID,
        subagentKind: "advisor",
        status: "running",
      }),
      reportEvent(7, iso(Date.parse(startedAt), 44_000), {
        type: "subagent",
        startedSeq: 6,
        startedAt: iso(Date.parse(startedAt), 25_000),
        childConversationId: DASHBOARD_QA_REVIEW_ID,
        subagentKind: "advisor",
        status: "completed",
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
        modelProfile: "standard",
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
            id: "qa-notes-txt",
            filename: "notes.txt",
            contentType: "text/plain",
            bytes: 42,
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
      modelProfile: "standard",
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
    reportEvent(nextSeq, iso(Date.parse(startedAt), 90_000), {
      type: "handoff",
      modelProfile: "fast",
      modelId: "openai/gpt-5-mini",
      reasoningLevel: "medium",
      summary:
        "Investigate the remaining deployment checks and report any actionable failure.",
    }),
  );
  nextSeq += 1;
  events.push(
    reportEvent(nextSeq, iso(Date.parse(startedAt), 166_000), {
      type: "message",
      messageId: "release-assistant",
      role: "assistant",
      text: "Released the package.\nOpened the update pull request.\nDeployment is ready.",
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
        icon: "circle-dashed",
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
        plugin: "github",
        status: "draft",
        url: "https://github.com/getsentry/junior/pull/2201",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 80_000),
      },
      {
        kind: "resource_link",
        key: "getsentry/payments#91",
        label: "getsentry/payments#91",
        plugin: "github",
        status: "open",
        url: "https://github.com/getsentry/payments/pull/91",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 75_000),
      },
      {
        kind: "resource_link",
        key: "getsentry/relay#44",
        label: "getsentry/relay#44",
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
        kind: "resource_link",
        key: "getsentry/payments#77",
        label: "getsentry/payments#77",
        plugin: "github",
        status: "merged",
        url: "https://github.com/getsentry/payments/pull/77",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 30_000),
      },
      {
        kind: "resource_link",
        key: "getsentry/payments#61",
        label: "getsentry/payments#61",
        plugin: "github",
        status: "closed",
        url: "https://github.com/getsentry/payments/issues/61",
        createdAt: startedAt,
        updatedAt: iso(Date.parse(startedAt), 28_000),
      },
    ],
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
        type: "tool_calls",
        calls: [
          {
            toolCallId: "incident-issue",
            name: "sentry.get_issue",
            status: "running",
          },
        ],
      }),
      reportEvent(2, iso(Date.parse(startedAt), 13_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "incident-issue",
            name: "sentry.get_issue",
            status: "running",
            startedSeq: 1,
            startedAt: iso(Date.parse(startedAt), 12_000),
            input: { issueId: "PAYMENTS-42" },
          },
        ],
      }),
      reportEvent(3, iso(Date.parse(startedAt), 28_000), {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "incident-issue",
            name: "sentry.get_issue",
            status: "completed",
            startedSeq: 1,
            startedAt: iso(Date.parse(startedAt), 12_000),
            output: {
              culprit: "payments-v42",
              eventCount: 418,
            },
          },
        ],
      }),
      reportEvent(4, iso(Date.parse(startedAt), 35_000), {
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
    visibility: "private",
    channel: "DQA123",
    // Owner-visible private DM: type label, not a privacy restatement.
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
      sourceTask: {
        id: "scheduled-1",
        kind: "scheduled",
        label:
          "Send the weekly project summary with release blockers, owner follow-ups, and next-week risks for every tracked workstream",
        title: "Weekly project summary",
      },
    }),
    simpleConversation(nowMs, {
      conversationId: ARCHIVED_CONVERSATION_ID,
      displayTitle: "Archived restore target",
      surface: "internal",
      archivedAt: iso(nowMs, -2 * 24 * 60 * 60_000),
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
    previousCursor: _previousCursor,
    sentryConversationUrl: _sentryConversationUrl,
    sourceTask: _sourceTask,
    ...summary
  } = conversation;
  const withArchiveState = mockArchivedConversationIds.has(
    conversation.conversationId,
  )
    ? {
        ...summary,
        archivedAt:
          summary.archivedAt ?? iso(Date.now(), -2 * 24 * 60 * 60_000),
      }
    : { ...summary, archivedAt: undefined };
  return withArchiveState.channel &&
    PUBLIC_MOCK_CHANNEL_IDS.has(withArchiveState.channel)
    ? { ...withArchiveState, locationId: `mock:${withArchiveState.channel}` }
    : withArchiveState;
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

/** Active root summaries used by mock aggregates and directories. */
function activeMockSummaries(nowMs: number): ConversationSummaryReport[] {
  return mockConversationFeed(nowMs).conversations.filter(
    (summary) => !summary.archivedAt,
  );
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
    days.set(key, { conversations: 0, date: key, durationMs: 0 });
  }
  for (const summary of summaries) {
    const day = days.get(summary.lastSeenAt.slice(0, 10));
    if (!day) continue;
    day.conversations += 1;
    day.durationMs += summary.cumulativeDurationMs;
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
  }
  return [...days.values()];
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
  return metricDays.reduce<ConversationStatsReport["guardian"]>(
    (result, day) => ({
      allow: result.allow + day.allow,
      ask: result.ask + day.ask,
      costUsd: (result.costUsd ?? 0) + (day.costUsd ?? 0),
      deny: result.deny + day.deny,
      metricDays,
      requests: result.requests + day.requests,
    }),
    { allow: 0, ask: 0, costUsd: 0, deny: 0, metricDays, requests: 0 },
  );
}

/** Return the explicit canonical-event visual-QA feed, optionally scoped by actor. */
export function readMockConversationFeed(
  actorEmail?: string,
  status: "active" | "archived" = "active",
): ConversationFeed {
  const feed = mockConversationFeed(Date.now());
  const conversations = feed.conversations
    .filter((conversation) =>
      status === "archived"
        ? Boolean(conversation.archivedAt)
        : !conversation.archivedAt,
    )
    .filter(
      (conversation) =>
        !actorEmail ||
        conversation.actorIdentity?.email?.toLowerCase() ===
          actorEmail.toLowerCase(),
    );
  return { ...feed, conversations };
}

/** Archive or restore one mock conversation for local dashboard visual QA. */
export function setMockConversationArchived(
  conversationId: string,
  archived: boolean,
): { archivedAt: string | null } | undefined {
  const exists = mockConversations(Date.now()).some(
    (conversation) => conversation.conversationId === conversationId,
  );
  if (!exists) return undefined;
  if (archived) mockArchivedConversationIds.add(conversationId);
  else mockArchivedConversationIds.delete(conversationId);
  return { archivedAt: archived ? new Date().toISOString() : null };
}

/** Return accepted mailbox rows for local dashboard visual QA. */
export function readMockConversationPendingMessages(
  conversationId: string,
): ConversationPendingMessagesReport | undefined {
  const conversation = mockConversations(Date.now()).find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;

  const nowMs = Date.now();
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
        ]
      : [];

  return {
    conversationId,
    generatedAt: iso(nowMs),
    messages,
  };
}

/** Return one canonical-event visual-QA conversation detail fixture. */
export function readMockConversationDetail(
  conversationId: string,
  limit = 500,
): ConversationDetailReport | undefined {
  const conversation = mockConversations(Date.now()).find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;
  const { parentConversationId: _parentConversationId, ...detail } =
    conversation;
  const withArchiveState = mockArchivedConversationIds.has(conversationId)
    ? {
        ...detail,
        archivedAt: detail.archivedAt ?? iso(Date.now(), -2 * 24 * 60 * 60_000),
      }
    : { ...detail, archivedAt: undefined };
  const events = withArchiveState.events.slice(-limit);
  const bounded =
    events.length < withArchiveState.events.length && events[0]
      ? {
          ...withArchiveState,
          events,
          previousCursor: mockBeforeCursor(conversationId, events[0].seq),
        }
      : withArchiveState;
  return bounded.channel && PUBLIC_MOCK_CHANNEL_IDS.has(bounded.channel)
    ? { ...bounded, locationId: `mock:${bounded.channel}` }
    : bounded;
}

/** Return the deterministic older page used to exercise transcript pagination. */
export function readMockConversationEvents(
  conversationId: string,
  before: string,
  limit = 500,
): ConversationEventPage | undefined {
  const conversation = mockConversations(Date.now()).find(
    (candidate) => candidate.conversationId === conversationId,
  );
  if (!conversation) return undefined;
  if (before === conversation.previousCursor) {
    return {
      events: [
        reportEvent(0, iso(Date.parse(conversation.startedAt), -60_000), {
          type: "message",
          messageId: `${conversationId}:earlier`,
          role: "user",
          text: "Prepare the release and include the complete earlier context.",
        }),
      ],
      eventHistory: conversation.eventHistory,
      generatedAt: new Date().toISOString(),
    };
  }

  const beforeSeq = parseMockBeforeCursor(conversationId, before);
  if (beforeSeq === undefined) return undefined;
  const olderEvents = conversation.events.filter(
    (event) => event.seq < beforeSeq,
  );
  const events = olderEvents.slice(-limit);
  return {
    events,
    eventHistory: conversation.eventHistory,
    generatedAt: new Date().toISOString(),
    ...(events.length < olderEvents.length && events[0]
      ? { previousCursor: mockBeforeCursor(conversationId, events[0].seq) }
      : conversation.previousCursor
        ? { previousCursor: conversation.previousCursor }
        : {}),
  };
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
  const nowMs = Date.now();
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
  const summaries = activeMockSummaries(nowMs);
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

/** Build mock person-scoped plugin reports for local profile QA. */
export function readMockPeoplePluginReports(
  email: string,
): PluginOperationalReportFeed {
  const nowMs = Date.now();
  const directory = readMockPeopleDirectory();
  const person = directory.people.find(
    (entry) => entry.actor.email.toLowerCase() === email.trim().toLowerCase(),
  );
  if (!person) {
    return {
      generatedAt: new Date(nowMs).toISOString(),
      reports: [],
      source: "plugins",
    };
  }

  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: 90 }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - (89 - index));
    const key = date.toISOString().slice(0, 10);
    const wave = (index % 7) + (index % 3);
    return {
      id: key,
      label: key,
      values: {
        created: wave === 0 ? 0 : wave % 4,
      },
    };
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    source: "plugins",
    reports: [
      {
        pluginName: "github",
        title: "GitHub",
        generatedAt: new Date(nowMs).toISOString(),
        metrics: [
          { label: "PRs opened · 30d", value: "12" },
          { label: "PRs merged · 30d", value: "9" },
          { label: "Issues opened · 30d", value: "4" },
          { label: "PR merge rate · 30d", value: "75%" },
        ],
        widgets: [
          {
            id: "pull-requests-created",
            type: "bar_chart",
            title: "Pull requests opened",
            description:
              "Junior-owned pull requests opened for this person per day",
            timeRangeDays: [7, 30, 90],
            series: [{ key: "created", label: "Opened" }],
            categories: days,
          },
          {
            id: "issues-created",
            type: "bar_chart",
            title: "Issues opened",
            description: "Junior-owned issues opened for this person per day",
            timeRangeDays: [7, 30, 90],
            series: [{ key: "created", label: "Opened" }],
            categories: days.map((day, index) => ({
              ...day,
              values: { created: index % 5 === 0 ? 1 : 0 },
            })),
          },
        ],
      },
    ],
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
  const nowMs = Date.now();
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
  const nowMs = Date.now();
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

function mockTaskExecutionDays(nowMs: number): TaskList["executionDays"] {
  return Array.from({ length: 90 }, (_, index) => {
    const date = new Date(nowMs - (89 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return {
      date,
      event: index % 11 === 0 ? 1 : 0,
      scheduled: index % 5 === 0 ? 2 : index % 3 === 0 ? 1 : 0,
    };
  });
}

function mockTasks(): TaskSummary[] {
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
      instruction: "Send the weekly project summary",
      kind: "scheduled",
      lastConversationId: "scheduler:daily-ops-digest",
      lastRunAt: "2026-08-06T16:00:00.000Z",
      nextRunAt: "2026-08-10T16:00:00.000Z",
      ownedByViewer: true,
      runsLast7Days: 3,
      schedule: "Every Monday at 9:00 AM",
      status: "active",
      title: "Weekly project summary",
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
      events: ["issue.closed"],
      id: "event-1",
      instruction: "Summarize the closed issue",
      kind: "event",
      ownedByViewer: true,
      resource: "Issue · ACME-42",
      runsLast7Days: 1,
      source: "github",
      title: "Closed issue summary",
      totalRuns: 7,
      triggerAvailable: true,
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
      events: ["incident.updated"],
      id: "event-2",
      instruction: "Notify responders when the incident changes",
      kind: "event",
      ownedByViewer: false,
      resource: "Incident · INC-17",
      runsLast7Days: 0,
      source: "pagerduty",
      title: "Incident change alerts",
      totalRuns: 0,
      triggerAvailable: false,
    },
  ];
}

/** Build mock Tasks list for local dashboard development. */
export function readMockTaskList(nowMs = Date.now()): TaskList {
  return {
    executionDays: mockTaskExecutionDays(nowMs),
    tasks: mockTasks(),
    truncated: false,
  };
}

function mockStatusDays(nowMs: number): TaskExecutionList["executionDays"] {
  return Array.from({ length: 90 }, (_, index) => {
    const date = new Date(nowMs - (89 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const completed = index % 4 === 0 ? 2 : index % 2 === 0 ? 1 : 0;
    const failed = index % 9 === 0 ? 1 : 0;
    const blocked = index % 13 === 0 ? 1 : 0;
    return { blocked, completed, date, failed };
  });
}

/** Build mock terminal executions for one viewer-visible task. */
export function readMockTaskExecutions(
  kind: "scheduled" | "event",
  id: string,
  nowMs = Date.now(),
): TaskExecutionList | undefined {
  const task = mockTasks().find(
    (candidate) => candidate.kind === kind && candidate.id === id,
  );
  if (!task) return undefined;
  if (task.totalRuns === 0) {
    return {
      executionDays: mockStatusDays(nowMs),
      executions: [],
      task,
      truncated: false,
    };
  }
  const titles = [
    "Weekly project summary",
    "Ship notes for the release train",
    "Ops digest for #project-updates",
  ];
  const statuses = ["completed", "failed", "blocked", "completed"] as const;
  const executions = Array.from({ length: 8 }, (_, index) => {
    const status = statuses[index % statuses.length]!;
    const hasConversation = index !== 5;
    return {
      ...(hasConversation
        ? {
            conversationId:
              index % 2 === 0
                ? SCHEDULER_CONVERSATION_ID
                : ACTIVE_CONVERSATION_ID,
            title: titles[index % titles.length],
          }
        : undefined),
      executedAt: new Date(
        nowMs - index * 86_400_000 - 3_600_000,
      ).toISOString(),
      executionId: `${id}-run-${index + 1}`,
      status,
    };
  });
  return {
    executionDays: mockStatusDays(nowMs),
    executions,
    task,
    truncated: task.totalRuns > executions.length,
  };
}
