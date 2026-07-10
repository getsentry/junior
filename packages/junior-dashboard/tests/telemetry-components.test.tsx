import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HighlightedCode } from "../src/client/code";
import { ToolCallsMetric } from "../src/client/components/TelemetryMetrics";
import { Button } from "../src/client/components/Button";
import { FilterTabs } from "../src/client/components/FilterTabs";
import { PluginReports } from "../src/client/components/PluginReports";
import { StatusBadge } from "../src/client/components/StatusBadge";
import {
  SubagentTranscriptDrawer,
  type SubagentTranscriptTarget,
} from "../src/client/components/SubagentTranscriptDrawer";
import { ToolValueInspector } from "../src/client/components/ToolValueInspector";
import { TranscriptHeader } from "../src/client/components/TranscriptHeader";
import { TranscriptSubagentView } from "../src/client/components/TranscriptSubagentView";
import { TranscriptToolView } from "../src/client/components/TranscriptToolView";
import { ConversationTranscriptSegment } from "../src/client/components/TranscriptTurn";
import { TranscriptSearchProvider } from "../src/client/components/transcriptSearch";
import { ConversationDurationChart } from "../src/client/components/ConversationDurationChart";
import { client } from "../src/client/api";
import { CommandCenter } from "../src/client/pages/CommandCenter";
import { ConversationPage } from "../src/client/pages/ConversationPage";
import { ConversationsPage } from "../src/client/pages/ConversationsPage";
import { PeoplePageContent, Profile } from "../src/client/pages/PeoplePage";
import { PluginsPage } from "../src/client/pages/PluginsPage";
import type {
  ConversationDetailFeed,
  ConversationSummary,
  ConversationTurn,
  DashboardData,
  ActorProfile,
} from "../src/client/types";

afterEach(() => {
  client.clear();
  vi.useRealTimers();
});

function dashboardData(
  conversationSummaries: ConversationSummary[],
): DashboardData {
  return {
    config: {
      allowedEmailCount: 0,
      allowedGoogleDomainCount: 0,
      authPath: "/api/auth",
      authRequired: false,
      basePath: "/",
      sentryConversationLinks: false,
      timeZone: "UTC",
    },
    health: {
      service: "junior",
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    conversationStats: {
      active: 0,
      conversations: 0,
      durationMs: 0,
      failed: 0,
      generatedAt: "2026-01-01T00:00:00.000Z",
      hung: 0,
      locations: [],
      actors: [],
      sampleLimit: 0,
      sampleSize: 0,
      source: "conversation_index",
      truncated: false,
      runs: 0,
      windowEnd: "2026-01-01T00:00:00.000Z",
      windowStart: "2025-12-25T00:00:00.000Z",
    },
    conversationStatsError: false,
    conversationStatsLoading: false,
    me: { user: {} },
    pluginReports: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      reports: [],
      source: "plugins",
    },
    pluginReportsError: false,
    pluginReportsLoading: false,
    plugins: [],
    runtime: {
      cwd: "/repo",
      homeDir: "/home",
      packagedContent: {
        packageNames: [],
        packages: [],
        manifestRoots: [],
        skillRoots: [],
        tracingIncludes: [],
      },
      providers: [],
      skills: [],
    },
    conversations: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      conversations: conversationSummaries,
      source: "conversation_index",
    },
    skills: [],
  } as DashboardData;
}

function renderConversationPage(data: DashboardData): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/conversations/conversation-1"]}>
        <Routes>
          <Route
            element={<ConversationPage data={data} />}
            path="/conversations/:conversationId"
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function toolRunTurn(toolCount: number): ConversationTurn {
  return {
    conversationId: "conversation-1",
    id: "turn-1",
    lastProgressAt: "2026-01-01T00:00:10.000Z",
    lastSeenAt: "2026-01-01T00:00:10.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    surface: "slack",
    displayTitle: "Conversation",
    transcript: Array.from({ length: toolCount }, (_, index) => ({
      role: "assistant",
      timestamp: Date.parse("2026-01-01T00:00:10.000Z") + index,
      parts: [
        {
          id: `call-${index}`,
          name: `tool-${index}`,
          type: "tool_call",
        },
      ],
    })),
    transcriptAvailable: true,
  } as ConversationTurn;
}

describe("dashboard telemetry components", () => {
  it("keeps shared command buttons out of form-submit mode", () => {
    const html = renderToStaticMarkup(<Button>Copy as Markdown</Button>);
    const iconHtml = renderToStaticMarkup(
      <Button aria-label="Log out" disabled size="icon" />,
    );

    expect(html).toContain('type="button"');
    expect(iconHtml).toContain('disabled=""');
    expect(iconHtml).toContain("size-9");
  });

  it("exposes pressed state for dashboard toggle controls", () => {
    const filters = renderToStaticMarkup(
      <FilterTabs current="failed" onChange={() => {}} />,
    );
    const transcript = renderToStaticMarkup(
      <TranscriptHeader
        actions={
          <Button aria-label="Copy conversation as Markdown" size="icon" />
        }
        onChange={() => {}}
        redacted={false}
        value="raw"
      />,
    );

    expect(filters).toContain('role="group"');
    expect(filters).toContain('aria-label="Conversation filter"');
    expect(filters.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(filters.match(/aria-pressed="false"/g) ?? []).toHaveLength(4);
    expect(transcript).toContain('aria-label="Transcript view"');
    expect(transcript).toContain('aria-label="Copy conversation as Markdown"');
    expect(transcript).not.toContain(">Transcript<");
    expect(transcript.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(transcript.match(/aria-pressed="false"/g) ?? []).toHaveLength(1);
  });

  it("renders transcript-backed subagent rows as inspectable events", () => {
    const html = renderToStaticMarkup(
      <TranscriptSubagentView
        onOpenTranscript={() => {}}
        part={{
          id: "advisor-call",
          outcome: "success",
          parentToolCallId: "advisor-call",
          status: "success",
          subagentKind: "advisor",
          transcriptAvailable: true,
          type: "subagent",
        }}
        timestamp={Date.parse("2026-01-01T00:00:00.000Z")}
      />,
    );

    expect(html).toContain("advisor");
    expect(html).not.toContain("advisor subagent");
    expect(html).toContain('aria-label="Open advisor transcript"');
  });

  it("renders advisor drawer headers with conversation identity", () => {
    const target = {
      conversationId: "parent-conversation",
      part: {
        id: "advisor-call",
        outcome: "success",
        parentToolCallId: "advisor-call",
        status: "success",
        subagentKind: "advisor",
        transcriptAvailable: true,
        type: "subagent",
      },
      turn: {
        conversationId: "parent-conversation",
        cumulativeDurationMs: 1000,
        displayTitle: "Parent conversation",
        id: "turn-1",
        lastProgressAt: "2026-01-01T00:00:01.000Z",
        lastSeenAt: "2026-01-01T00:00:01.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        surface: "internal",
        transcript: [],
        transcriptAvailable: true,
      },
    } satisfies SubagentTranscriptTarget;
    client.setQueryData(
      [
        "conversation-subagent",
        "parent-conversation",
        "turn-1",
        "advisor-call",
      ],
      {
        type: "subagent",
        createdAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        id: "advisor-call",
        outcome: "success",
        parentToolCallId: "advisor-call",
        status: "success",
        subagentConversationId: "junior:parent-conversation:advisor_session",
        subagentKind: "advisor",
        subagentSentryConversationUrl:
          "https://sentry.example/explore/conversations/advisor",
        transcript: [],
        transcriptAvailable: false,
      },
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SubagentTranscriptDrawer target={target} onClose={() => {}} />
      </QueryClientProvider>,
    );

    expect(html).toContain(">advisor<");
    expect(html).not.toContain("advisor subagent");
    expect(html).toContain("Conversation ID");
    expect(html).toContain("junior:parent-conversation:advisor_session");
    expect(html).toContain("View in Sentry");
    expect(html).toContain('aria-label="Copy as Markdown"');
    expect(html).toContain("disabled");
    expect(html).toContain(
      "https://sentry.example/explore/conversations/advisor",
    );
  });

  it("renders actor profiles with activity and recent conversations", () => {
    const profile: ActorProfile = {
      activityDays: [
        {
          active: 0,
          conversations: 0,
          date: "2026-01-01",
          durationMs: 0,
          failed: 0,
          hung: 0,
          runs: 0,
        },
        {
          active: 0,
          conversations: 2,
          date: "2026-01-02",
          durationMs: 1_200,
          failed: 0,
          hung: 0,
          runs: 2,
        },
      ],
      generatedAt: "2026-01-02T00:00:00.000Z",
      locations: [
        {
          active: 0,
          conversations: 2,
          durationMs: 1_200,
          failed: 0,
          hung: 0,
          label: "#proj-alpha",
          runs: 2,
        },
      ],
      recentConversations: [
        {
          conversationId: "slack:C1:123",
          cumulativeDurationMs: 1_200,
          displayTitle: "Incident triage",
          id: "turn-1",
          lastProgressAt: "2026-01-02T00:00:00.000Z",
          lastSeenAt: "2026-01-02T00:00:00.000Z",
          actorIdentity: {
            email: "avery@example.com",
            fullName: "Avery Example",
          },
          startedAt: "2026-01-02T00:00:00.000Z",
          status: "completed",
          surface: "slack",
        },
      ],
      actor: {
        email: "avery@example.com",
        fullName: "Avery Example",
        slackUserName: "avery",
      },
      sampleLimit: 10,
      sampleSize: 1,
      source: "conversation_index",
      surfaces: [
        {
          active: 0,
          conversations: 2,
          durationMs: 1_200,
          failed: 0,
          hung: 0,
          label: "Conversation",
          runs: 2,
        },
      ],
      totals: {
        active: 0,
        activeDays: 1,
        conversations: 2,
        durationMs: 1_200,
        failed: 0,
        hung: 0,
        runs: 2,
      },
      truncated: false,
      windowEnd: "2026-01-02T00:00:00.000Z",
      windowStart: "2025-01-02T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Profile profile={profile} />
      </MemoryRouter>,
    );

    expect(html).toContain("Avery Example");
    expect(html).toContain("avery@example.com");
    expect(html).toContain("Activity");
    expect(html).toContain("Incident triage");
    expect(html).toContain("Daily Junior conversation activity");
    expect(html).toContain(">Jan<");
    expect(html).toContain(">Less<");
    expect(html).toContain(">More<");
    const activityStart = html.indexOf(
      'aria-label="Daily Junior conversation activity"',
    );
    expect(
      html
        .slice(
          activityStart,
          html.indexOf('aria-label="2026-01-01: 0 conversations"'),
        )
        .match(/class="size-3 border border-black\/40 bg-\[#101010\]"/g),
    ).toHaveLength(4);
    expect(html).toContain('href="/people/avery%40example.com"');
    expect(html).toContain('aria-label="Search recent conversations"');
    expect(html).not.toContain(">Places<");
    expect(html).not.toContain(">active days<");
    expect(html).not.toContain(">runs<");
    expect(html).not.toContain(">attention<");
    expect(html).not.toContain(">People</a>");
  });

  it("renders people load failures separately from empty telemetry", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PeoplePageContent
          data={undefined}
          error={new Error("people failed")}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("People failed to load");
    expect(html).toContain("People telemetry is unavailable");
    expect(html).not.toContain("No actor telemetry with trusted email");
  });

  it("keeps completed status badges quiet unless explicitly requested", () => {
    expect(renderToStaticMarkup(<StatusBadge status="idle" />)).toBe("");
    expect(
      renderToStaticMarkup(<StatusBadge showCompleted status="idle" />),
    ).toContain("completed");
    expect(
      renderToStaticMarkup(<StatusBadge label="checking" status="idle" />),
    ).toContain("checking");
    expect(renderToStaticMarkup(<StatusBadge status="failed" />)).toContain(
      "error",
    );
  });

  it("keeps the Sentry trace link in transcript headers", () => {
    const turn = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      sentryTraceUrl: "https://sentry.example/trace/abc",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <ConversationTranscriptSegment turn={turn} view="rich" />,
    );

    expect(html).toContain("View in Sentry");
    expect(html).toContain("https://sentry.example/trace/abc");
  });

  it("removes residual grid row gap from collapsed system prompts", () => {
    const turn = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "system",
          parts: [{ type: "text", text: "System prompt" }],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain("gap-y-0");
    expect(html).toContain("flex min-w-0 items-center justify-between gap-3");
    expect(html).toContain(
      'font-mono leading-none text-[0.78rem] text-[#888]">13b',
    );
  });

  it("keeps message timestamps in a shared heading row without elapsed offsets", () => {
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "user",
          timestamp: Date.parse("2026-01-01T00:00:10.000Z"),
          parts: [{ type: "text", text: "Can you check this?" }],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain("flex min-w-0 items-center justify-between gap-3");
    expect(html).toContain("font-mono leading-none text-[0.78rem] text-[#888]");
    expect(html).toContain("flex flex-col items-center pt-1.5");
    expect(html).not.toContain("+10s");
    expect(html).not.toContain("· +");
    expect(html).not.toContain("items-baseline gap-2 text-[0.88rem]");
  });

  it("renders safe markdown links as transcript anchors", () => {
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:10.000Z"),
          parts: [
            {
              type: "text",
              text: "See [the trace](https://sentry.example/trace/abc), [wiki](https://en.wikipedia.org/wiki/Foo_(bar)), https://docs.example/Foo_(bar)., https://., https://after-invalid.example/ok, [broken [real](https://nested.example/ok), [local](/api/me), and [bad](javascript:alert).",
            },
          ],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain('href="https://sentry.example/trace/abc"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain(">the trace</a>");
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
    expect(html).toContain(">wiki</a>");
    expect(html).toContain('href="https://docs.example/Foo_(bar)"');
    expect(html).toContain(">https://docs.example/Foo_(bar)</a>.");
    expect(html).toContain("https://.");
    expect(html).toContain('href="https://after-invalid.example/ok"');
    expect(html).toContain(">https://after-invalid.example/ok</a>");
    expect(html).toContain("[broken ");
    expect(html).toContain('href="https://nested.example/ok"');
    expect(html).toContain(">real</a>");
    expect(html).not.toContain(">broken [real</a>");
    expect(html).toContain("[local](/api/me)");
    expect(html).toContain("[bad](javascript:alert)");
    expect(html).not.toContain('href="/api/me"');
    expect(html).not.toContain('href="javascript:alert"');
  });

  it("renders cached highlighted markdown links", () => {
    const text =
      "## Trace summary\n- [cached trace](https://cached.example/trace).";
    client.setQueryData(
      ["highlight", "markdown", text, "transcript-markdown"],
      '<pre><code><span class="line"><span style="color:#79B8FF;font-weight:bold">## Trace summary</span></span>\n<span class="line">- <a data-cached="yes" href="https://cached.example/trace" rel="noreferrer" target="_blank">cached trace</a>.</span></code></pre>',
    );
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:10.000Z"),
          parts: [{ type: "text", text }],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-cached="yes"');
    expect(html).toContain('href="https://cached.example/trace"');
    expect(html).toContain(">cached trace</a>");
    expect(html).not.toContain("[cached trace]");
  });

  it("renders the conversation duration chart title", () => {
    const session = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 3_000,
      id: "turn-1",
      completedAt: "2026-01-01T00:00:03.000Z",
      lastProgressAt: "2026-01-01T00:00:03.000Z",
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
    } satisfies ConversationSummary;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ConversationDurationChart
            nowMs={Date.parse("2026-01-05T00:00:00.000Z")}
            conversationSummaries={[session]}
            timeZone="UTC"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(html).not.toContain("Durations");
    expect(html).toContain("Conversations");
    expect(html).not.toContain("Turns");
    expect(html).not.toContain('aria-label="Duration chart mode"');
    expect(html).toContain(
      'aria-label="conversations by duration over the last 7 days"',
    );
  });

  it("omits empty tool-call summaries", () => {
    expect(
      renderToStaticMarkup(
        <ToolCallsMetric summary={{ items: [], total: 0 }} />,
      ),
    ).toBe("");
  });

  it("omits the conversation tool-call metric slot when the loaded detail has no tool calls", () => {
    const session = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "not-a-date",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "internal",
      displayTitle: "Conversation",
    } satisfies ConversationSummary;
    const detail = {
      conversationId: "conversation-1",
      displayTitle: session.displayTitle,
      generatedAt: "2026-01-01T00:00:00.000Z",
      runs: [
        {
          ...session,
          transcript: [],
          transcriptAvailable: true,
        },
      ],
    } satisfies ConversationDetailFeed;
    client.setQueryData(["conversation", "conversation-1"], detail);

    const html = renderConversationPage(dashboardData([session]));

    expect(html).not.toContain("turn");
    expect(html).not.toContain("tool call");
  });

  it("renders execution activity inside the transcript", () => {
    const session = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "internal",
      displayTitle: "Conversation",
    } satisfies ConversationSummary;
    const detail = {
      conversationId: "conversation-1",
      displayTitle: session.displayTitle,
      generatedAt: "2026-01-01T00:00:00.000Z",
      runs: [
        {
          ...session,
          activity: [
            {
              type: "tool_execution",
              id: "advisor-call-1",
              toolCallId: "advisor-call-1",
              toolName: "advisor",
              createdAt: "2026-01-01T00:00:01.000Z",
              status: "running",
              subagents: [
                {
                  type: "subagent",
                  id: "advisor-call-1",
                  subagentKind: "advisor",
                  parentToolCallId: "advisor-call-1",
                  createdAt: "2026-01-01T00:00:01.000Z",
                  status: "running",
                },
              ],
            },
          ],
          transcript: [],
          transcriptAvailable: true,
        },
      ],
    } satisfies ConversationDetailFeed;
    client.setQueryData(["conversation", "conversation-1"], detail);

    const html = renderConversationPage(dashboardData([session]));

    expect(html).not.toContain('aria-label="Execution activity"');
    expect(html).not.toContain("Execution Activity");
    expect(html).toContain("advisor");
    expect(html).not.toContain("advisor subagent");
    expect(html).toContain("running");
    expect(html.indexOf("advisor")).toBeGreaterThan(
      html.indexOf('aria-label="Transcript view"'),
    );
  });

  it("uses the detail report for the View in Sentry conversation link", () => {
    const summary = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      actorIdentity: {
        email: "avery@example.com",
        fullName: "Avery Example",
      },
    } satisfies ConversationSummary;
    const detail = {
      conversationId: "conversation-1",
      displayTitle: summary.displayTitle,
      generatedAt: "2026-01-01T00:00:00.000Z",
      sentryConversationUrl:
        "https://sentry.example/explore/conversations/conversation-1/?project=1",
      runs: [
        {
          ...summary,
          transcript: [],
          transcriptAvailable: true,
        },
      ],
    } satisfies ConversationDetailFeed;
    client.setQueryData(["conversation", "conversation-1"], detail);

    const html = renderConversationPage(dashboardData([summary]));

    expect(html).toContain('href="/people/avery%40example.com"');
    expect(html).toContain("View in Sentry");
    expect(html).toContain(
      "https://sentry.example/explore/conversations/conversation-1/?project=1",
    );
  });

  it("caps dashboard route pages at a readable width", () => {
    const session = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Readable transcript",
    } satisfies ConversationSummary;

    const data = dashboardData([session]);
    const conversation = renderConversationPage(data);
    const conversations = renderToStaticMarkup(
      <MemoryRouter>
        <ConversationsPage data={data} />
      </MemoryRouter>,
    );
    const command = renderToStaticMarkup(
      <MemoryRouter>
        <CommandCenter data={data} queryError={null} />
      </MemoryRouter>,
    );
    const plugins = renderToStaticMarkup(
      <MemoryRouter>
        <PluginsPage data={data} />
      </MemoryRouter>,
    );

    expect(conversation).toContain("mx-auto w-full min-w-0 max-w-screen-xl");
    expect(conversations).toContain("mx-auto w-full min-w-0 max-w-screen-xl");
    expect(command).toContain("mx-auto grid w-full min-w-0 max-w-screen-xl");
    expect(plugins).toContain("mx-auto w-full min-w-0 max-w-screen-xl");
  });

  it("filters the conversation list with search and facets", () => {
    const data = dashboardData([
      {
        channel: "C1",
        channelName: "proj-checkout",
        conversationId: "slack:C1:100",
        cumulativeDurationMs: 1_000,
        displayTitle: "Checkout latency triage",
        id: "turn-1",
        lastProgressAt: "2026-01-01T00:00:01.000Z",
        lastSeenAt: "2026-01-01T00:00:02.000Z",
        actorIdentity: {
          email: "morgan@example.com",
          fullName: "Morgan",
        },
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        surface: "slack",
      },
      {
        conversationId: "internal:memory:200",
        cumulativeDurationMs: 2_000,
        displayTitle: "Memory cleanup",
        id: "turn-2",
        lastProgressAt: "2026-01-01T00:02:01.000Z",
        lastSeenAt: "2026-01-01T00:02:02.000Z",
        actorIdentity: { fullName: "Casey" },
        startedAt: "2026-01-01T00:02:00.000Z",
        status: "completed",
        surface: "internal",
      },
    ]);

    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={[
          "/conversations?q=checkout&source=slack&actor=morgan%40example.com",
        ]}
      >
        <ConversationsPage data={data} />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Search conversations"');
    expect(html).toContain('aria-label="Source"');
    expect(html).toContain('aria-label="Actor"');
    expect(html).toContain("Checkout latency triage");
    expect(html).toContain("1 of 2 conversations");
    expect(html).not.toContain("Memory cleanup");
  });

  it("renders aggregate stats and plugin reports", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00.000Z"));

    const conversationSummaries: ConversationSummary[] = [
      {
        channel: "C1",
        channelName: "proj-alpha",
        conversationId: "slack:C1:100",
        cumulativeDurationMs: 1_000,
        id: "turn-1",
        lastProgressAt: "2026-01-01T00:00:01.000Z",
        lastSeenAt: "2026-01-01T00:00:02.000Z",
        actorIdentity: { fullName: "Avery" },
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        surface: "slack",
        displayTitle: "Conversation",
      },
      {
        channel: "D1",
        conversationId: "slack:D1:200",
        cumulativeDurationMs: 2_000,
        id: "turn-2",
        lastProgressAt: "2026-01-01T00:02:01.000Z",
        lastSeenAt: "2026-01-01T00:02:02.000Z",
        actorIdentity: { fullName: "Avery" },
        startedAt: "2026-01-01T00:02:00.000Z",
        status: "failed",
        surface: "slack",
        displayTitle: "Conversation",
      },
      {
        channel: "C2",
        channelName: "old-project",
        conversationId: "slack:C2:300",
        cumulativeDurationMs: 5_000,
        id: "old-turn",
        lastProgressAt: "2025-12-20T00:00:01.000Z",
        lastSeenAt: "2025-12-20T00:00:02.000Z",
        actorIdentity: { fullName: "Casey" },
        startedAt: "2025-12-20T00:00:00.000Z",
        status: "completed",
        surface: "slack",
        displayTitle: "Old thread",
      },
    ];
    const data = dashboardData(conversationSummaries);
    data.conversationStats = {
      active: 0,
      conversations: 2,
      durationMs: 3_000,
      failed: 1,
      generatedAt: "2026-01-05T00:00:00.000Z",
      hung: 0,
      locations: [
        {
          active: 0,
          conversations: 1,
          durationMs: 1_000,
          failed: 0,
          hung: 0,
          label: "#proj-alpha",
          runs: 1,
        },
      ],
      actors: [
        {
          active: 0,
          conversations: 2,
          durationMs: 3_000,
          failed: 1,
          hung: 0,
          label: "Avery",
          runs: 2,
        },
      ],
      sampleLimit: 2,
      sampleSize: 2,
      source: "conversation_index",
      truncated: false,
      runs: 2,
      windowEnd: "2026-01-05T00:00:00.000Z",
      windowStart: "2025-12-29T00:00:00.000Z",
    };
    data.plugins = [{ name: "github" }];
    data.pluginReports.reports = [
      {
        pluginName: "scheduler",
        title: "Scheduler",
        metrics: [{ label: "active", value: "2" }],
        recordSets: [
          {
            title: "Upcoming",
            fields: [{ key: "task", label: "Task" }],
            records: [{ id: "sched_1", values: { task: "sched_1" } }],
          },
        ],
      },
    ];
    data.skills = [{ name: "triage", pluginProvider: "github" }];

    const commandHtml = renderToStaticMarkup(
      <MemoryRouter>
        <CommandCenter data={data} queryError={null} />
      </MemoryRouter>,
    );
    const pluginHtml = renderToStaticMarkup(
      <MemoryRouter>
        <PluginsPage data={data} />
      </MemoryRouter>,
    );

    expect(commandHtml).toContain(">Stats<");
    expect(commandHtml).not.toContain(">People<");
    expect(commandHtml).not.toContain(">Places<");
    expect(commandHtml).not.toContain("Casey");
    expect(commandHtml).not.toContain("Old thread");
    expect(pluginHtml).toContain(">Plugins<");
    expect(pluginHtml).toContain(">Scheduler<");
    expect(pluginHtml).toContain("github");
    expect(pluginHtml).toContain("triage");
    expect(pluginHtml).toContain("scheduler");
    expect(pluginHtml).toContain("sched_1");
  });

  it("renders a clear fallback for plugin records without fields", () => {
    const html = renderToStaticMarkup(
      <PluginReports
        reports={[
          {
            pluginName: "scheduler",
            recordSets: [
              {
                title: "Malformed",
                records: [{ id: "row-1", values: { task: "sched_1" } }],
              },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain(
      "Report records are unavailable because no fields were declared.",
    );
  });

  it("renders plugins page when plugin reports are absent", () => {
    const data = dashboardData([]) as Partial<DashboardData>;
    data.plugins = [{ name: "github" }];
    delete data.pluginReports;

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PluginsPage data={data as DashboardData} />
      </MemoryRouter>,
    );

    expect(html).toContain(">Plugins<");
    expect(html).toContain("github");
    expect(html).toContain("No plugins have been reported yet.");
  });

  it("shows plugin reports as loading before the report query returns", () => {
    const data = dashboardData([]);
    data.pluginReportsLoading = true;
    data.plugins = [{ name: "github" }];
    data.skills = [{ name: "triage", pluginProvider: "github" }];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PluginsPage data={data} />
      </MemoryRouter>,
    );

    expect(html).toContain("Loading plugin stats.");
    expect(html).toContain(">...<");
    expect(html).not.toContain(">none<");
    expect(html).not.toContain("No plugins have been reported yet.");
  });

  it("shows plugin report failures without looking empty", () => {
    const data = dashboardData([]);
    data.pluginReportsError = true;

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PluginsPage data={data} />
      </MemoryRouter>,
    );

    expect(html).toContain("Plugin stats failed to load.");
    expect(html).not.toContain("No plugins have been reported yet.");
  });

  it("shows plugin report failures while keeping stale reports visible", () => {
    const data = dashboardData([]);
    data.pluginReportsError = true;
    data.pluginReports.reports = [
      {
        metrics: [{ label: "active", value: "1" }],
        pluginName: "scheduler",
        title: "Scheduler",
      },
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PluginsPage data={data} />
      </MemoryRouter>,
    );

    expect(html).toContain("Plugin stats failed to load.");
    expect(html).toContain(">Scheduler<");
  });

  it("shows conversation stats failures without hiding the command center", () => {
    const data = dashboardData([]);
    data.conversationStatsError = true;

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommandCenter data={data} queryError={null} />
      </MemoryRouter>,
    );

    expect(html).toContain(">Stats<");
    expect(html).toContain(">degraded<");
    expect(html).toContain(">Conversations<");
  });

  it("marks sampled conversation stats as limited", () => {
    const data = dashboardData([]);
    data.conversationStats.truncated = true;

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommandCenter data={data} queryError={null} />
      </MemoryRouter>,
    );

    expect(html).toContain(">limited sample<");
  });

  it("renders transcript copy as an icon-only control", () => {
    const session = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Readable transcript",
    } satisfies ConversationSummary;
    const detail = {
      conversationId: "conversation-1",
      displayTitle: session.displayTitle,
      generatedAt: "2026-01-01T00:00:00.000Z",
      runs: [
        {
          ...session,
          transcript: [
            {
              parts: [{ text: "hello", type: "text" }],
              role: "user",
            },
          ],
          transcriptAvailable: true,
        },
      ],
    } satisfies ConversationDetailFeed;
    client.setQueryData(["conversation", "conversation-1"], detail);

    const html = renderConversationPage(dashboardData([session]));
    const controls = html.slice(
      html.indexOf('aria-label="Transcript view"'),
      html.indexOf("hello"),
    );
    const pageHeader = html.slice(
      0,
      html.indexOf('aria-label="Transcript view"'),
    );

    expect(pageHeader).not.toContain('aria-label="Copy as Markdown"');
    expect(controls).toContain('aria-label="Copy as Markdown"');
    expect(controls).toContain("size-9");
    expect(controls).not.toContain(">Copy as Markdown<");
  });

  it("keeps zero timestamps in tool metadata", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptToolView
          call={{ type: "tool_call", name: "search" }}
          result={{ type: "tool_result", name: "search", output: "ok" }}
          resultTimestamp={5}
          timestamp={0}
        />
      </QueryClientProvider>,
    );

    expect(html.match(/·/g) ?? []).toHaveLength(5);
    expect(html).toContain("5ms · 2b ·");
    expect(html).toContain("hidden text-[#777] max-md:inline");
    expect(html).toContain(
      'hidden min-w-0 break-words text-[#888] max-md:inline">5ms',
    );
    expect(html).toContain("max-md:block");
  });

  it("highlights expandable tool summaries on hover", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptToolView
          call={{
            input: { query: "checkout" },
            name: "search",
            type: "tool_call",
          }}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("hover:text-white");
    expect(html).toContain("hover:[&amp;_*]:text-white");
    expect(html).toContain(
      'hidden min-w-0 break-words text-[#888] max-md:inline">missing result',
    );
    expect(html).toContain("<details");
  });

  it("renders expanded tool payloads as structured key/value rows", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptToolView
          call={{
            input: {
              filters: { environment: "production", release: "2026.1.0" },
              query: "checkout latency",
              teams: ["growth", "payments"],
            },
            name: "sentry.search_traces",
            type: "tool_call",
          }}
          result={{
            name: "sentry.search_traces",
            output: {
              rows: [
                { count: 12, endpoint: "/checkout", p95: 842 },
                { count: 5, endpoint: "/cart", p95: 310 },
              ],
              summary: "Checkout p95 regressed after deploy.",
            },
            type: "tool_result",
          }}
          resultTimestamp={10}
          timestamp={0}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain(">arguments<");
    expect(html).toContain(">result<");
    expect(html).toContain("checkout latency");
    expect(html).toContain("environment");
    expect(html).toContain("production");
    expect(html).toContain("<table");
    expect(html).toContain("/checkout");
    expect(html).not.toContain("language-json");
  });

  it("renders generic tool values without dumping one JSON blob", () => {
    const html = renderToStaticMarkup(
      <ToolValueInspector
        value={{
          command: "pnpm test",
          files: [
            { added: 12, path: "src/a.ts" },
            { added: 4, path: "src/b.ts" },
          ],
          stdout: "line one\nline two",
        }}
      />,
    );

    expect(html).toContain("command");
    expect(html).toContain("pnpm test");
    expect(html).toContain("<table");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("line one");
    expect(html).not.toContain("{&quot;command&quot;");
  });

  it("does not highlight static tool summaries as expandable", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptToolView />
      </QueryClientProvider>,
    );

    expect(html).not.toContain("hover:text-white");
    expect(html).not.toContain("<details");
  });

  it("contains highlighted code so long mobile lines cannot widen transcripts", () => {
    const code =
      '{ "message": "junior command failed: CACHE_URL is required" }';
    client.setQueryData(
      ["highlight", "json", code],
      '<pre><code><span class="line"><span>junior command failed: CACHE_URL is required</span></span></code></pre>',
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <HighlightedCode code={code} language="json" />
      </QueryClientProvider>,
    );

    expect(html).toContain("overflow-hidden");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("[&amp;_.line]:block");
    expect(html).toContain("[&amp;_.line]:whitespace-pre-wrap");
    expect(html).toContain("[&amp;_code]:whitespace-normal");
    expect(html).toContain("[&amp;_pre]:whitespace-normal");
    expect(html).not.toContain("[&amp;_code]:whitespace-pre-wrap");
  });

  it("uses compact highlighted code spacing for raw XML transcripts", () => {
    const rawText = "<root>\n  <message>Checking MCP output</message>\n</root>";
    client.setQueryData(
      ["highlight", "xml", rawText],
      '<pre><code><span class="line"><span>&lt;root&gt;</span></span>\n<span class="line"><span>  &lt;message&gt;Checking MCP output&lt;/message&gt;</span></span>\n<span class="line"><span>&lt;/root&gt;</span></span></code></pre>',
    );

    const turn = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "internal",
      displayTitle: "Raw XML",
      transcript: [
        {
          parts: [{ text: rawText, type: "text" }],
          role: "assistant",
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={turn} view="raw" />
      </QueryClientProvider>,
    );

    expect(html).toContain("[&amp;_code]:whitespace-normal");
    expect(html).toContain("[&amp;_pre]:whitespace-normal");
    expect(html).toContain("Checking MCP output");
  });

  it("renders four consecutive tool calls behind a reveal disclosure", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={toolRunTurn(4)} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain('<details class="min-w-0"><summary');
    expect(html).toContain("show 4 tool calls");
    expect(html).not.toContain("collapse");
    expect(html).not.toContain('aria-expanded="false"');
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("py-1.5 text-left font-mono");
    expect(html).not.toContain("pl-3 text-left font-mono");
    expect(html).toContain("tool-0");
    expect(html).toContain("tool-1");
    expect(html).toContain("tool-2");
    expect(html).toContain("tool-3");
  });

  it("keeps three consecutive tool calls expanded", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={toolRunTurn(3)} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).not.toContain("show");
    expect(html).toContain("tool-0");
    expect(html).toContain("tool-1");
    expect(html).toContain("tool-2");
  });

  it("renders thinking rows as collapsed disclosures", () => {
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:10.000Z"),
          parts: [
            {
              type: "thinking",
              output: "checking the rollout\nlisting deploy windows",
            },
          ],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain('aria-label="Thinking"');
    expect(html).toContain("<details");
    expect(html).toContain("py-1.5 text-[0.84rem] leading-relaxed");
    expect(html).toContain("grid-cols-[1rem_minmax(0,1fr)]");
    expect(html).toContain("inline-flex size-4 shrink-0 items-center");
    expect(html).toContain("not-italic text-[#777] max-md:hidden");
    expect(html).toContain("hidden min-w-0 grid-cols-[1rem_minmax(0,1fr)]");
    expect(html).toContain("not-italic leading-snug text-[#777]");
    expect(html).not.toContain("<details open");

    const summary = html.slice(
      html.indexOf("<summary"),
      html.indexOf("</summary>"),
    );
    // Summary shows truncated thinking text preview (not just a static label).
    expect(summary).toContain("checking the rollout");
    expect(summary).toContain("listing deploy windows");
  });

  it("collapses short thinking rows by default", () => {
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:10.000Z"),
          parts: [{ type: "thinking", output: "checking the rollout" }],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain("<details");
    expect(html).toContain("checking the rollout");

    const summary = html.slice(
      html.indexOf("<summary"),
      html.indexOf("</summary>"),
    );
    // Summary shows the truncated thinking text so users can scan before expanding.
    expect(summary).toContain("checking the rollout");
  });

  it("expands thinking rows during transcript search", () => {
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:10.000Z"),
          parts: [
            {
              type: "thinking",
              output: "checking the rollout\nlisting deploy windows",
            },
          ],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptSearchProvider query="deploy">
          <ConversationTranscriptSegment turn={turn} view="rich" />
        </TranscriptSearchProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain("checking the rollout");
    expect(html).toContain("listing <mark");
    expect(html).toContain(">deploy<");
  });

  it("consolidates mixed tool-and-thinking run at threshold behind a reveal", () => {
    // 2 tool calls + 2 thinking entries = 4 total = at threshold
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:10.000Z"),
          parts: [
            { id: "call-0", name: "tool-0", type: "tool_call" },
            { type: "thinking", output: "first thought" },
            { id: "call-1", name: "tool-1", type: "tool_call" },
            { type: "thinking", output: "second thought" },
          ],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={turn} view="rich" />
      </QueryClientProvider>,
    );

    // All four entries collapse into one reveal group.
    expect(html).toContain('<details class="min-w-0"><summary');
    expect(html).toContain("show 2 tool calls and 2 thinking entries");
    expect(html).toContain("tool-0");
    expect(html).toContain("tool-1");
    expect(html).toContain("first thought");
    expect(html).toContain("second thought");
  });

  it("keeps mixed tool-and-thinking run below threshold expanded flat", () => {
    // 1 tool + 2 thinking = 3 total, below threshold
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:10.000Z"),
          parts: [
            { id: "call-0", name: "tool-0", type: "tool_call" },
            { type: "thinking", output: "first thought" },
            { type: "thinking", output: "second thought" },
          ],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).not.toContain("show");
    expect(html).toContain("tool-0");
    expect(html).toContain("first thought");
    expect(html).toContain("second thought");
  });

  it("shows correct counts in mixed-run reveal label", () => {
    // 5 tool calls + 2 thinking entries
    const toolParts = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool-${i}`,
      type: "tool_call",
    }));
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:10.000Z"),
          parts: [
            ...toolParts,
            { type: "thinking", output: "thought a" },
            { type: "thinking", output: "thought b" },
          ],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain("show 5 tool calls and 2 thinking entries");
  });

  it("collapses four consecutive pure-thinking entries behind a reveal", () => {
    // 4 consecutive thinking entries collapse the same as tool runs
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:10.000Z"),
          parts: [
            { type: "thinking", output: "thought 1" },
            { type: "thinking", output: "thought 2" },
            { type: "thinking", output: "thought 3" },
            { type: "thinking", output: "thought 4" },
          ],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain('<details class="min-w-0"><summary');
    expect(html).toContain("show 4 thinking entries");
    expect(html).toContain("thought 1");
    expect(html).toContain("thought 4");
  });
});
