import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationFeed,
  ConversationSummaryReport,
} from "@sentry/junior/api/schema";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import type {
  ActorDirectoryReport,
  ActorProfileReport,
} from "@sentry/junior/api/schema";
import type { LocationDirectoryReport } from "@sentry/junior/api/schema";
import type { LocationDetailReport } from "@sentry/junior/api/schema";

import { HighlightedCode } from "../src/client/code";
import { ToolCallsMetric } from "../src/client/components/TelemetryMetrics";
import { Button } from "../src/client/components/Button";
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
import { ConversationTranscriptView } from "../src/client/components/ConversationTranscript";
import { TranscriptSearchProvider } from "../src/client/components/transcriptSearch";
import { client } from "../src/client/api";
import { ContributionGrid } from "../src/client/components/ContributionGrid";
import { ConversationPage } from "../src/client/pages/ConversationPage";
import { ConversationWorkspace } from "../src/client/pages/ConversationWorkspace";
import { PeoplePageContent } from "../src/client/pages/people/PeoplePage";
import { PeopleDirectory } from "../src/client/pages/people/PeopleDirectory";
import { Profile } from "../src/client/pages/people/PersonProfilePage";
import {
  LocationDetailPage,
  LocationDetailPageContent,
} from "../src/client/pages/locations/LocationDetailPage";
import { LocationsPageContent } from "../src/client/pages/locations/LocationsPage";
import { SystemPage } from "../src/client/pages/system/SystemPage";
import type { ConversationTranscript, SystemData } from "../src/client/types";

afterEach(() => {
  client.clear();
  vi.useRealTimers();
});

function dashboardData(
  conversationSummaries: ConversationSummaryReport[],
): SystemData & { conversations: ConversationFeed } {
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
    me: { user: { email: "viewer@example.com" } },
    conversationStats: {
      active: 0,
      actors: [],
      conversations: conversationSummaries.length,
      durationMs: conversationSummaries.reduce(
        (sum, conversation) => sum + conversation.cumulativeDurationMs,
        0,
      ),
      failed: conversationSummaries.filter(
        (conversation) => conversation.status === "failed",
      ).length,
      generatedAt: "2026-01-01T00:00:00.000Z",
      locations: [],
      source: "conversation_index",
      tokens: 12_345,
      costUsd: 4.56,
      windowEnd: "2026-01-01T00:00:00.000Z",
      windowStart: "2025-12-25T00:00:00.000Z",
    },
    conversationStatsError: false,
    conversationStatsLoading: false,
    pluginReports: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      reports: [],
      source: "plugins",
    },
    pluginReportsError: false,
    pluginReportsLoading: false,
    plugins: [],
    conversations: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      conversations: conversationSummaries,
      source: "conversation_index",
    },
    skills: [],
  };
}

function renderConversationPage(data: {
  conversations: ConversationFeed;
}): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/conversations/conversation-1"]}>
        <Routes>
          <Route
            element={
              <ConversationPage conversationId="conversation-1" data={data} />
            }
            path="/conversations/:conversationId"
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function toolRunTurn(
  toolCount: number,
  finalMessage = false,
): ConversationTranscript {
  return {
    conversationId: "conversation-1",
    lastProgressAt: "2026-01-01T00:00:10.000Z",
    lastSeenAt: "2026-01-01T00:00:10.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    surface: "slack",
    displayTitle: "Conversation",
    transcript: [
      ...Array.from({ length: toolCount }, (_, index) => ({
        role: "assistant",
        timestamp: Date.parse("2026-01-01T00:00:10.000Z") + index,
        parts: [
          {
            id: `call-${index}`,
            name: `tool-${index}`,
            type: "tool_call" as const,
          },
        ],
      })),
      ...(finalMessage
        ? [
            {
              role: "assistant" as const,
              timestamp: Date.parse("2026-01-01T00:00:11.000Z"),
              parts: [{ type: "text" as const, text: "done" }],
            },
          ]
        : []),
    ],
    transcriptAvailable: true,
  } as ConversationTranscript;
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

  it("places subagent and context-change icons on the transcript rail", () => {
    const turn = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 3_000,
      displayTitle: "Conversation",
      lastProgressAt: "2026-01-01T00:00:03.000Z",
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "internal",
      transcript: [
        {
          role: "assistant",
          parts: [
            {
              id: "advisor-call",
              status: "success",
              subagentKind: "advisor",
              type: "subagent",
            },
            {
              type: "context_event",
              event: {
                createdAt: "2026-01-01T00:00:02.000Z",
                transcriptIndex: 0,
                type: "context_compacted",
              },
            },
            {
              type: "context_event",
              event: {
                createdAt: "2026-01-01T00:00:03.000Z",
                fromModelId: "openai/gpt-5.4",
                toModelId: "openai/gpt-5.6-sol",
                transcriptIndex: 0,
                type: "model_handoff",
              },
            },
          ],
        },
      ],
      transcriptAvailable: true,
    } as unknown as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-transcript-rail-event="subagent"');
    expect(html).toContain('data-transcript-rail-event="compaction"');
    expect(html).toContain('data-transcript-rail-event="handoff"');
    expect(html.match(/-left-\[1\.95rem\]/g) ?? []).toHaveLength(3);
  });

  it("renders advisor drawer headers with conversation identity", () => {
    const target = {
      conversationId: "parent-conversation",
      part: {
        id: "advisor-call",
        modelId: "openai/gpt-5.6-sol",
        outcome: "success",
        parentToolCallId: "advisor-call",
        reasoningLevel: "high",
        status: "success",
        subagentKind: "advisor",
        transcriptAvailable: true,
        type: "subagent",
      },
      conversation: {
        conversationId: "parent-conversation",
        cumulativeDurationMs: 1000,
        displayTitle: "Parent conversation",
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
      ["conversation-subagent", "parent-conversation", "advisor-call"],
      {
        type: "subagent",
        createdAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        id: "advisor-call",
        modelId: "openai/gpt-5.6-sol",
        outcome: "success",
        parentToolCallId: "advisor-call",
        reasoningLevel: "high",
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
    expect(html).toContain("junior:");
    expect(html).toContain("parent-conversation:");
    expect(html).toContain("advisor_session");
    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("(high)");
    expect(html).toContain("high");
    expect(html).toContain("View in Sentry");
    expect(html).toContain('aria-label="Copy as Markdown"');
    expect(html).toContain("disabled");
    expect(html).toContain(
      "https://sentry.example/explore/conversations/advisor",
    );
  });

  it("shows subagent execution settings while the drawer is loading", () => {
    const target = {
      conversationId: "parent-conversation",
      part: {
        id: "advisor-loading",
        modelId: "openai/gpt-5.6-sol",
        reasoningLevel: "high",
        status: "running",
        subagentKind: "advisor",
        type: "subagent",
      },
      conversation: {
        conversationId: "parent-conversation",
        cumulativeDurationMs: 0,
        displayTitle: "Parent conversation",
        lastProgressAt: "2026-01-01T00:00:01.000Z",
        lastSeenAt: "2026-01-01T00:00:01.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        surface: "internal",
        transcript: [],
        transcriptAvailable: true,
      },
    } satisfies SubagentTranscriptTarget;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SubagentTranscriptDrawer target={target} onClose={() => {}} />
      </QueryClientProvider>,
    );

    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("(high)");
  });

  it("renders actor profiles with activity without recent conversations", () => {
    const profile: ActorProfileReport = {
      activityDays: [
        {
          active: 0,
          conversations: 0,
          date: "2026-01-01",
          durationMs: 0,
          failed: 0,
        },
        {
          active: 0,
          conversations: 2,
          date: "2026-01-02",
          durationMs: 1_200,
          failed: 0,
        },
      ],
      generatedAt: "2026-01-02T00:00:00.000Z",
      locations: [
        {
          active: 0,
          conversations: 2,
          durationMs: 1_200,
          failed: 0,
          label: "#proj-alpha",
        },
      ],
      recentConversations: [
        {
          conversationId: "slack:C1:123",
          cumulativeDurationMs: 1_200,
          displayTitle: "Incident triage",
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
      source: "conversation_index",
      surfaces: [
        {
          active: 0,
          conversations: 2,
          durationMs: 1_200,
          failed: 0,
          label: "Conversation",
        },
      ],
      totals: {
        active: 0,
        activeDays: 1,
        conversations: 2,
        durationMs: 1_200,
        failed: 0,
      },
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
    expect(html).not.toContain("Incident triage");
    expect(html).toContain("Daily Junior conversation activity");
    expect(html).toContain("52 weeks");
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
          html.indexOf('aria-label="2026-01-01: 0 conversations, 0ms"'),
        )
        .match(/class="size-3 border border-black\/40 bg-\[#101010\]"/g),
    ).toHaveLength(4);
    expect(html).not.toContain('href="/people/avery%40example.com"');
    expect(html).not.toContain('aria-label="Search recent conversations"');
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

  it("renders people analytics with range controls and daily activity", () => {
    const data: ActorDirectoryReport = {
      activityDays: [
        { activePeople: 1, conversations: 2, date: "2026-01-01" },
        { activePeople: 2, conversations: 3, date: "2026-01-02" },
      ],
      generatedAt: "2026-01-02T12:00:00.000Z",
      people: [
        {
          active: 0,
          activeDays: 2,
          conversations: 3,
          durationMs: 1_200,
          failed: 0,
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-02T00:00:00.000Z",
          actor: {
            email: "avery@example.com",
            fullName: "Avery Example",
            slackUserName: "avery",
          },
        },
      ],
      source: "conversation_index",
      windowEnd: "2026-01-02T00:00:00.000Z",
      windowStart: "2025-10-05T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PeoplePageContent data={data} error={undefined} />
      </MemoryRouter>,
    );

    expect(html).toContain("Who&#x27;s been around");
    expect(html).toContain("Active people per day");
    expect(html).toContain('aria-label="Reporting period"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(">90d</button>");
    expect(html).toContain("Peak daily active");
    expect(html).toContain("Avery Example");
    expect(html).not.toContain("@avery");
    expect(html).not.toContain("last 1 day ago");
  });

  it("renders a stable skeleton while directory sorting catches up", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PeopleDirectory
          loading
          onQueryChange={() => {}}
          onSortChange={() => {}}
          people={[]}
          query=""
          sort="runtime"
          totalPeople={2}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Loading sorted results"');
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
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      sentryTraceUrl: "https://sentry.example/trace/abc",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [],
      transcriptAvailable: true,
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <ConversationTranscriptView conversation={turn} view="rich" />,
    );

    expect(html).toContain("View in Sentry");
    expect(html).toContain("https://sentry.example/trace/abc");
  });

  it("renders terminal assistant outcomes as distinct safe callouts", () => {
    const turn = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      lastProgressAt: "2026-01-01T00:00:02.000Z",
      lastSeenAt: "2026-01-01T00:00:02.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          outcome: "error",
          timestamp: 1_000,
          parts: [],
        },
        {
          role: "assistant",
          outcome: "aborted",
          timestamp: 2_000,
          parts: [],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <ConversationTranscriptView conversation={turn} view="rich" />,
    );

    expect(html).toContain('data-transcript-failure="error"');
    expect(html).toContain('data-transcript-failure="aborted"');
    expect(html).toContain("Agent response failed");
    expect(html).toContain("Agent response stopped");
  });

  it("renders terminal assistant outcomes from redacted transcript metadata", () => {
    const turn = {
      conversationId: "conversation-private",
      cumulativeDurationMs: 0,
      lastProgressAt: "2026-01-01T00:00:01.000Z",
      lastSeenAt: "2026-01-01T00:00:01.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Private conversation",
      transcript: [],
      transcriptAvailable: false,
      transcriptMetadata: [
        {
          role: "assistant",
          outcome: "error",
          timestamp: 1_000,
          parts: [],
        },
      ],
      transcriptRedacted: true,
      transcriptRedactionReason: "non_public_conversation",
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <ConversationTranscriptView conversation={turn} view="rich" />,
    );

    expect(html).toContain('data-transcript-failure="error"');
    expect(html).toContain("Agent response failed");
  });

  it("removes residual grid row gap from collapsed system prompts", () => {
    const turn = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
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
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
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
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
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
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
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
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-cached="yes"');
    expect(html).toContain('href="https://cached.example/trace"');
    expect(html).toContain(">cached trace</a>");
    expect(html).not.toContain("[cached trace]");
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
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "not-a-date",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "internal",
      displayTitle: "Conversation",
    } satisfies ConversationSummaryReport;
    const detail = {
      ...session,
      generatedAt: "2026-01-01T00:00:00.000Z",
      transcript: [],
      transcriptAvailable: true,
    } satisfies ConversationDetailReport;
    client.setQueryData(["conversation", "conversation-1"], detail);

    const html = renderConversationPage(dashboardData([session]));

    expect(html).not.toContain("turn");
    expect(html).not.toContain("tool call");
  });

  it("counts actor turns and omits the redundant started header item", () => {
    const session = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 60_000,
      lastProgressAt: "2026-01-01T00:01:00.000Z",
      lastSeenAt: "2026-01-01T00:01:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "internal",
      displayTitle: "Conversation",
    } satisfies ConversationSummaryReport;
    const detail = {
      ...session,
      generatedAt: "2026-01-01T00:01:00.000Z",
      transcript: [
        { role: "user", parts: [{ type: "text", text: "first" }] },
        { role: "assistant", parts: [{ type: "text", text: "done" }] },
        { role: "user", parts: [{ type: "text", text: "second" }] },
        { role: "assistant", parts: [{ type: "text", text: "done" }] },
      ],
      transcriptAvailable: true,
    } satisfies ConversationDetailReport;
    client.setQueryData(["conversation", "conversation-1"], detail);

    const html = renderConversationPage(dashboardData([session]));
    const header = html.slice(0, html.indexOf('aria-label="Transcript view"'));
    const transcript = html.slice(html.indexOf('aria-label="Transcript view"'));

    expect(header).toContain("2 turns");
    expect(header).not.toContain("4 messages");
    expect(header).not.toContain("started Jan");
    expect(transcript).toContain("2 turns");
    expect(transcript).not.toContain("4 messages");
  });

  it("shows the conversation model and thinking level in the transcript header", () => {
    const session = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "internal",
      displayTitle: "Conversation",
    } satisfies ConversationSummaryReport;
    const detail = {
      ...session,
      generatedAt: "2026-01-01T00:00:00.000Z",
      modelId: "openai/gpt-5.6-sol",
      reasoningLevel: "high",
      transcript: [],
      transcriptAvailable: true,
    } satisfies ConversationDetailReport;
    client.setQueryData(["conversation", "conversation-1"], detail);

    const html = renderConversationPage(dashboardData([session]));
    const transcriptStart = html.indexOf('aria-label="Transcript view"');
    const detailHeader = html.slice(0, transcriptStart);
    const transcript = html.slice(transcriptStart);

    expect(detailHeader).not.toContain("gpt-5.6-sol");
    expect(transcript).toContain(
      'aria-label="Execution settings: openai/gpt-5.6-sol, high"',
    );
    expect(transcript).toContain("break-all font-mono");
    expect(transcript).toContain("gpt-5.6-sol");
    expect(transcript).toContain("(high)");
  });

  it("renders execution activity inside the transcript", () => {
    const session = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "internal",
      displayTitle: "Conversation",
    } satisfies ConversationSummaryReport;
    const detail = {
      ...session,
      generatedAt: "2026-01-01T00:00:00.000Z",
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
    } satisfies ConversationDetailReport;
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
    } satisfies ConversationSummaryReport;
    const detail = {
      ...summary,
      generatedAt: "2026-01-01T00:00:00.000Z",
      sentryConversationUrl:
        "https://sentry.example/explore/conversations/conversation-1/?project=1",
      transcript: [],
      transcriptAvailable: true,
    } satisfies ConversationDetailReport;
    client.setQueryData(["conversation", "conversation-1"], detail);

    const html = renderConversationPage(dashboardData([summary]));

    expect(html).toContain('href="/people/avery%40example.com"');
    expect(html).toContain("View in Sentry");
    expect(html).toContain(
      "https://sentry.example/explore/conversations/conversation-1/?project=1",
    );
  });

  it("renders the selected personal conversation in the home workspace", () => {
    const summary = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 1_000,
      displayTitle: "Personal conversation",
      lastProgressAt: "2026-01-01T00:00:01.000Z",
      lastSeenAt: "2026-01-01T00:00:02.000Z",
      actorIdentity: { email: "morgan@example.com", fullName: "Morgan" },
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
    } satisfies ConversationSummaryReport;
    const data = dashboardData([summary]);
    data.config.authRequired = true;
    data.me = { user: { email: "morgan@example.com" } };
    client.setQueryData(
      ["dashboard", "conversations", "morgan@example.com"],
      data.conversations,
    );
    client.setQueryData(["conversation", "conversation-1"], {
      ...summary,
      generatedAt: "2026-01-01T00:00:02.000Z",
      transcript: [],
      transcriptAvailable: true,
    } satisfies ConversationDetailReport);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/conversations/conversation-1"]}>
          <Routes>
            <Route
              element={<ConversationWorkspace data={data} />}
              path="/conversations/:conversationId"
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(html).toContain("Your conversations");
    expect(html).toContain('aria-label="Search your conversations"');
    expect(html).toContain('href="/conversations/conversation-1"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Personal conversation");
  });

  it("uses React Router's decoded conversation id without decoding it again", () => {
    const summary = {
      conversationId: "conversation%one",
      cumulativeDurationMs: 1_000,
      displayTitle: "Percent conversation",
      lastProgressAt: "2026-01-01T00:00:01.000Z",
      lastSeenAt: "2026-01-01T00:00:01.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
    } satisfies ConversationSummaryReport;
    const data = dashboardData([summary]);
    data.config.authRequired = true;
    client.setQueryData(
      ["dashboard", "conversations", "viewer@example.com"],
      data.conversations,
    );
    client.setQueryData(["conversation", "conversation%one"], {
      ...summary,
      generatedAt: "2026-01-01T00:00:01.000Z",
      transcript: [],
      transcriptAvailable: true,
    } satisfies ConversationDetailReport);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/conversations/conversation%25one"]}>
          <Routes>
            <Route
              element={<ConversationWorkspace data={data} />}
              path="/conversations/:conversationId"
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(html).toContain("Percent conversation");
  });

  it("shows the global feed when dashboard auth is disabled", () => {
    const summary = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 1_000,
      displayTitle: "Local conversation",
      lastProgressAt: "2026-01-01T00:00:01.000Z",
      lastSeenAt: "2026-01-01T00:00:01.000Z",
      actorIdentity: { email: "actor@example.com" },
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
    } satisfies ConversationSummaryReport;
    const data = dashboardData([summary]);
    client.setQueryData(
      ["dashboard", "conversations", "all"],
      data.conversations,
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ConversationWorkspace data={data} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(html).toContain("Local conversation");
  });

  it("renders system conversation metrics and plugin reports", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00.000Z"));

    const conversationSummaries: ConversationSummaryReport[] = [
      {
        channel: "C1",
        channelName: "proj-alpha",
        conversationId: "slack:C1:100",
        cumulativeDurationMs: 1_000,
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
    data.plugins = [{ name: "github" }];
    data.pluginReports!.reports = [
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

    const systemHtml = renderToStaticMarkup(
      <MemoryRouter>
        <SystemPage data={data} />
      </MemoryRouter>,
    );

    expect(systemHtml).toContain(">System<");
    expect(systemHtml).toContain(">conversations<");
    expect(systemHtml).toContain(">12k<");
    expect(systemHtml).toContain(">$4.56<");
    expect(systemHtml).toContain(">Plugins<");
    expect(systemHtml).toContain(">Scheduler<");
    expect(systemHtml).toContain("github");
    expect(systemHtml).toContain("triage");
    expect(systemHtml).toContain("scheduler");
    expect(systemHtml).toContain("sched_1");
  });

  it("renders public locations as primary rows and collapses private activity", () => {
    const data: LocationDirectoryReport = {
      activityDays: [
        {
          date: "2026-01-05",
          privateConversations: 3,
          publicConversations: 6,
        },
      ],
      generatedAt: "2026-01-05T00:00:00.000Z",
      locations: [
        {
          active: 1,
          conversations: 4,
          durationMs: 12_000,
          failed: 1,
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          id: "destination-1",
          kind: "channel",
          label: "#proj-alpha",
          lastSeenAt: "2026-01-05T00:00:00.000Z",
          provider: "slack",
          providerDestinationId: "C1",
          tokens: 12_500,
          visibility: "public",
        },
        {
          active: 0,
          conversations: 2,
          durationMs: 4_000,
          failed: 0,
          firstSeenAt: "2026-01-02T00:00:00.000Z",
          id: "destination-2",
          kind: "channel",
          label: "#other",
          lastSeenAt: "2026-01-04T00:00:00.000Z",
          provider: "slack",
          providerDestinationId: "C2",
          visibility: "public",
        },
      ],
      privateActivity: {
        active: 0,
        conversations: 3,
        durationMs: 2_000,
        failed: 0,
        label: "Private activity",
      },
      source: "conversation_index",
      windowEnd: "2026-01-05T00:00:00.000Z",
      windowStart: "2025-10-08T00:00:00.000Z",
    };
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/locations?q=proj-alpha"]}>
        <LocationsPageContent data={data} error={null} />
      </MemoryRouter>,
    );
    expect(html).toContain("1 of 2 public locations");
    expect(html).toContain("#proj-alpha");
    expect(html).not.toContain("#other");
    expect(html).not.toContain("C1");
    expect(html).toContain(">13k<");
    expect(html).not.toContain(">Errors<");
    expect(html).not.toContain(">Active<");
    expect(html).toContain("Private activity");
    expect(html).toContain("DMs, private channels, and unknown visibility");
    expect(html).toContain("Public and private conversations per day");
  });

  it("keeps cached location rows visible after a refresh failure", () => {
    const data: LocationDirectoryReport = {
      activityDays: [],
      generatedAt: "2026-01-05T00:00:00.000Z",
      locations: [
        {
          active: 0,
          conversations: 1,
          durationMs: 1_000,
          failed: 0,
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          id: "destination-1",
          kind: "channel",
          label: "#proj-alpha",
          lastSeenAt: "2026-01-05T00:00:00.000Z",
          provider: "slack",
          providerDestinationId: "C1",
          visibility: "public",
        },
      ],
      privateActivity: {
        active: 0,
        conversations: 0,
        durationMs: 0,
        failed: 0,
        label: "Private activity",
      },
      source: "conversation_index",
      windowEnd: "2026-01-05T00:00:00.000Z",
      windowStart: "2025-10-08T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LocationsPageContent data={data} error={new Error("refresh failed")} />
      </MemoryRouter>,
    );

    expect(html).toContain("Location telemetry refresh failed");
    expect(html).toContain("#proj-alpha");
  });

  it("renders public location detail with people and recent conversations", () => {
    const detail: LocationDetailReport = {
      active: 0,
      activityDays: [],
      actors: [
        {
          active: 0,
          actor: { email: "avery@example.com", fullName: "Avery" },
          conversations: 1,
          durationMs: 1_000,
          failed: 0,
          label: "avery@example.com",
        },
      ],
      conversations: 1,
      durationMs: 1_000,
      failed: 0,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      generatedAt: "2026-01-05T00:00:00.000Z",
      id: "destination-1",
      kind: "channel",
      label: "#proj-alpha",
      lastSeenAt: "2026-01-05T00:00:00.000Z",
      provider: "slack",
      providerDestinationId: "C1",
      recentConversations: [
        {
          channel: "C1",
          channelName: "proj-alpha",
          conversationId: "slack:C1:100",
          cumulativeDurationMs: 1_000,
          displayTitle: "Investigate checkout",
          lastProgressAt: "2026-01-05T00:00:00.000Z",
          lastSeenAt: "2026-01-05T00:00:00.000Z",
          locationId: "destination-1",
          startedAt: "2026-01-05T00:00:00.000Z",
          status: "completed",
          surface: "slack",
        },
      ],
      source: "conversation_index",
      visibility: "public",
      windowEnd: "2026-01-05T00:00:00.000Z",
      windowStart: "2025-12-07T00:00:00.000Z",
    };
    client.setQueryData(["dashboard", "locations", "destination-1"], detail);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/locations/destination-1"]}>
          <Routes>
            <Route
              element={<LocationDetailPage />}
              path="/locations/:locationId"
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("#proj-alpha");
    expect(html).toContain("Investigate checkout");
    expect(html).toContain('href="/people/avery%40example.com"');
    expect(html).toContain("Recent conversations");

    const staleHtml = renderToStaticMarkup(
      <MemoryRouter>
        <LocationDetailPageContent
          data={detail}
          error={new Error("refresh failed")}
        />
      </MemoryRouter>,
    );
    expect(staleHtml).toContain("Location telemetry refresh failed");
    expect(staleHtml).toContain("#proj-alpha");
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

  it("keeps plugin inventory available when conversation metrics fail", () => {
    const data = dashboardData([]);
    data.conversationStats = undefined;
    data.conversationStatsError = true;
    data.plugins = [{ name: "github" }];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SystemPage data={data} />
      </MemoryRouter>,
    );

    expect(html).toContain("Conversation metrics failed to load.");
    expect(html).toContain(">Plugins<");
    expect(html).toContain(">github<");
  });

  it("keeps cached conversation metrics visible after a refresh failure", () => {
    const data = dashboardData([]);
    data.conversationStatsError = true;

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SystemPage data={data} />
      </MemoryRouter>,
    );

    expect(html).toContain(
      "Conversation metrics refresh failed. Showing cached data.",
    );
    expect(html).toContain("90-day pulse");
  });

  it("does not report a completion rate before any conversation finishes", () => {
    const data = dashboardData([]);
    data.conversationStats = {
      ...data.conversationStats!,
      active: 2,
      conversations: 2,
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SystemPage data={data} />
      </MemoryRouter>,
    );

    expect(html).toContain("No terminal outcomes");
    expect(html).not.toContain("100% healthy completion");
    expect(html).not.toContain("undefined%");
  });

  it("renders system page when plugin reports are absent", () => {
    const data = dashboardData([]);
    data.plugins = [{ name: "github" }];
    delete data.pluginReports;

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SystemPage data={data} />
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
        <SystemPage data={data} />
      </MemoryRouter>,
    );

    expect(html).toContain("Loading plugin stats.");
    expect(html).toContain(">…<");
    expect(html).not.toContain(">none<");
    expect(html).not.toContain("No plugins have been reported yet.");
  });

  it("shows plugin report failures without looking empty", () => {
    const data = dashboardData([]);
    data.pluginReportsError = true;

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SystemPage data={data} />
      </MemoryRouter>,
    );

    expect(html).toContain("Plugin stats failed to load.");
    expect(html).not.toContain("No plugins have been reported yet.");
  });

  it("shows plugin report failures while keeping stale reports visible", () => {
    const data = dashboardData([]);
    data.pluginReportsError = true;
    data.pluginReports!.reports = [
      {
        metrics: [{ label: "active", value: "1" }],
        pluginName: "scheduler",
        title: "Scheduler",
      },
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SystemPage data={data} />
      </MemoryRouter>,
    );

    expect(html).toContain("Plugin stats failed to load.");
    expect(html).toContain(">Scheduler<");
  });

  it("preserves unknown runtime in shared activity tooltips", () => {
    const html = renderToStaticMarkup(
      <ContributionGrid
        days={[
          {
            conversations: 1,
            date: "2026-01-01",
            durationMs: 0,
          },
        ]}
      />,
    );

    expect(html).toContain('aria-label="2026-01-01: 1 conversations, unknown"');
  });
  it("renders transcript copy as an icon-only control", () => {
    const session = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 0,
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Readable transcript",
    } satisfies ConversationSummaryReport;
    const detail = {
      ...session,
      generatedAt: "2026-01-01T00:00:00.000Z",
      transcript: [
        {
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        },
      ],
      transcriptAvailable: true,
    } satisfies ConversationDetailReport;
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
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="raw" />
      </QueryClientProvider>,
    );

    expect(html).toContain("[&amp;_code]:whitespace-normal");
    expect(html).toContain("[&amp;_pre]:whitespace-normal");
    expect(html).toContain("Checking MCP output");
  });

  it("renders four consecutive tool calls behind a reveal disclosure", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView
          conversation={toolRunTurn(4, true)}
          view="rich"
        />
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
        <ConversationTranscriptView conversation={toolRunTurn(3)} view="rich" />
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
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
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
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
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

  it("does not render empty thinking as JSON", () => {
    const turn = {
      conversationId: "conversation-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          parts: [{ type: "thinking" }],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).not.toContain("{}");
    expect(html).toContain("thinking");
  });

  it("expands thinking rows during transcript search", () => {
    const turn = {
      conversationId: "conversation-1",
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
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptSearchProvider query="deploy">
          <ConversationTranscriptView conversation={turn} view="rich" />
        </TranscriptSearchProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain("checking the rollout");
    expect(html).toContain("listing <mark");
    expect(html).toContain(">deploy<");
  });

  it("keeps execution settings visible when transcript search has no matches", () => {
    const turn = {
      conversationId: "conversation-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      modelId: "openai/gpt-5.6-sol",
      reasoningLevel: "high",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "internal",
      displayTitle: "Conversation",
      transcript: [
        {
          role: "assistant",
          parts: [{ type: "text", text: "A visible response" }],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptSearchProvider query="not-present">
          <ConversationTranscriptView conversation={turn} view="rich" />
        </TranscriptSearchProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("(high)");
    expect(html).toContain("No events match your search.");
    expect(html).not.toContain("A visible response");
  });

  it("consolidates mixed tool-and-thinking run at threshold behind a reveal", () => {
    // 2 tool calls + 2 thinking entries = 4 total = at threshold
    const turn = {
      conversationId: "conversation-1",
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
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:11.000Z"),
          parts: [{ type: "text", text: "done" }],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
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
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).not.toContain("show");
    expect(html).toContain("tool-0");
    expect(html).toContain("first thought");
    expect(html).toContain("second thought");
  });

  it("keeps a trailing tool-and-thinking run expanded without a final message", () => {
    const turn = {
      conversationId: "conversation-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "failed",
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
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).not.toContain("show 2 tool calls and 2 thinking entries");
    expect(html).toContain("tool-0");
    expect(html).toContain("tool-1");
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
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:11.000Z"),
          parts: [{ type: "text", text: "done" }],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain("show 5 tool calls and 2 thinking entries");
  });

  it("collapses four consecutive pure-thinking entries behind a reveal", () => {
    // 4 consecutive thinking entries collapse the same as tool runs
    const turn = {
      conversationId: "conversation-1",
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
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:11.000Z"),
          parts: [{ type: "text", text: "done" }],
        },
      ],
      transcriptAvailable: true,
    } as ConversationTranscript;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptView conversation={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain('<details class="min-w-0"><summary');
    expect(html).toContain("show 4 thinking entries");
    expect(html).toContain("thought 1");
    expect(html).toContain("thought 4");
  });
});
