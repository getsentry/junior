import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ActorProfileReport,
  ConversationReportEvent,
  ConversationReportEventData,
  ConversationSummaryReport,
  LocationDetailReport,
  LocationDirectoryReport,
} from "@sentry/junior/api/schema";

import { client } from "../src/client/api";
import { HighlightedCode } from "../src/client/code";
import { Button } from "../src/client/components/Button";
import { ConversationTranscriptView } from "../src/client/components/ConversationTranscript";
import { PluginReports } from "../src/client/components/PluginReports";
import {
  SubagentTranscriptDrawer,
  type SubagentTranscriptTarget,
} from "../src/client/components/SubagentTranscriptDrawer";
import { TranscriptHeader } from "../src/client/components/TranscriptHeader";
import { TranscriptToolView } from "../src/client/components/TranscriptToolView";
import { ToolValueInspector } from "../src/client/components/ToolValueInspector";
import { TranscriptSearchProvider } from "../src/client/components/transcriptSearch";
import { ConversationPage } from "../src/client/pages/ConversationPage";
import { LocationDetailPageContent } from "../src/client/pages/locations/LocationDetailPage";
import { LocationsPageContent } from "../src/client/pages/locations/LocationsPage";
import { Profile } from "../src/client/pages/people/PersonProfilePage";
import { SystemPage } from "../src/client/pages/system/SystemPage";
import type { ConversationTranscript, SystemData } from "../src/client/types";

afterEach(() => client.clear());

function event(
  seq: number,
  data: ConversationReportEventData,
  createdAt = `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
): ConversationReportEvent {
  return { seq, contextEpoch: 0, createdAt, data };
}

function conversation(
  events: ConversationReportEvent[],
  overrides: Partial<ConversationTranscript> = {},
): ConversationTranscript {
  return {
    conversationId: "conversation-1",
    cumulativeDurationMs: 3_000,
    displayTitle: "Conversation",
    eventHistory: { status: "available" },
    events,
    generatedAt: "2026-01-01T00:01:00.000Z",
    lastProgressAt: "2026-01-01T00:00:10.000Z",
    lastSeenAt: "2026-01-01T00:00:10.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    surface: "internal",
    ...overrides,
  };
}

function renderTranscript(detail: ConversationTranscript): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TranscriptSearchProvider query="">
        <ConversationTranscriptView conversation={detail} view="rich" />
      </TranscriptSearchProvider>
    </QueryClientProvider>,
  );
}

function systemData(): SystemData {
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
      conversations: 2,
      costUsd: 1.25,
      durationMs: 2_000,
      failed: 0,
      generatedAt: "2026-01-01T00:00:00.000Z",
      locations: [],
      source: "conversation_index",
      tokens: 1_200,
      windowEnd: "2026-01-01T00:00:00.000Z",
      windowStart: "2025-10-03T00:00:00.000Z",
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
    skills: [],
  };
}

describe("dashboard canonical-event components", () => {
  it("keeps shared buttons out of form-submit mode", () => {
    expect(renderToStaticMarkup(<Button>Copy</Button>)).toContain(
      'type="button"',
    );
  });

  it("exposes pressed state for transcript view controls", () => {
    const html = renderToStaticMarkup(
      <TranscriptHeader redacted={false} value="raw" onChange={() => {}} />,
    );
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g) ?? []).toHaveLength(1);
  });

  it("renders visible messages once and keeps API order over timestamps", () => {
    const html = renderTranscript(
      conversation([
        event(
          0,
          {
            type: "visible_message",
            messageId: "first",
            role: "user",
            text: "first by sequence",
          },
          "2026-01-01T00:00:09.000Z",
        ),
        event(1, { type: "model_activity", activities: ["thinking"] }),
        event(
          2,
          {
            type: "visible_message",
            messageId: "second",
            role: "assistant",
            text: "second by sequence",
          },
          "2026-01-01T00:00:01.000Z",
        ),
      ]),
    );
    expect(html.indexOf("first by sequence")).toBeLessThan(
      html.indexOf("second by sequence"),
    );
    expect(html.match(/second by sequence/g)).toHaveLength(1);
  });

  it("renders redacted visible events without exposing text", () => {
    const html = renderTranscript(
      conversation(
        [
          event(0, {
            type: "visible_message",
            messageId: "private",
            role: "user",
            redacted: true,
          }),
        ],
        {
          eventHistory: {
            status: "redacted",
            reason: "non_public_conversation",
          },
        },
      ),
    );
    expect(html).toContain("&lt;redacted&gt;");
  });

  it("renders failure and context lifecycle rows", () => {
    const html = renderTranscript(
      conversation([
        event(0, { type: "context_compacted" }),
        event(1, { type: "model_handoff" }),
        event(2, {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "failed",
        }),
      ]),
    );
    expect(html).toContain("Context compacted");
    expect(html).toContain("Model handoff");
    expect(html).toContain("Agent response failed");
  });

  it("renders failed delivery history without treating accepted delivery as failure", () => {
    const html = renderTranscript(
      conversation([
        event(0, {
          type: "delivery",
          deliveryId: "delivery-1",
          state: "accepted",
        }),
        event(1, {
          type: "delivery",
          deliveryId: "delivery-2",
          state: "failed",
        }),
      ]),
    );
    expect(html).toContain("Message delivery failed");
    expect(html).toContain(
      "Junior could not deliver this message to its destination.",
    );
    expect(html.match(/data-transcript-failure/g)).toHaveLength(1);
    expect(html).not.toContain("Agent response failed");
  });

  it("renders tool starts as started rather than running", () => {
    const html = renderTranscript(
      conversation([event(0, { type: "tool_started", name: "search" })]),
    );
    expect(html).toContain("search");
    expect(html).toContain("started");
    expect(html).not.toContain("running");
    expect(html).not.toContain("missing result");
  });

  it("renders redacted tool starts as started rather than missing", () => {
    const html = renderTranscript(
      conversation([event(0, { type: "tool_started", name: "search" })], {
        eventHistory: {
          status: "redacted",
          reason: "non_public_conversation",
        },
      }),
    );
    expect(html).toContain("search");
    expect(html).toContain("started");
    expect(html).not.toContain("running");
    expect(html).not.toContain("missing result");
  });

  it("renders canonical child rows as inspectable conversation events", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptSearchProvider query="">
          <ConversationTranscriptView
            conversation={conversation([
              event(0, {
                type: "subagent_started",
                childConversationId: "child-1",
                subagentKind: "advisor",
                historyMode: "shared",
              }),
              event(1, {
                type: "subagent_ended",
                childConversationId: "child-1",
                subagentKind: "advisor",
                historyMode: "shared",
                outcome: "success",
              }),
            ])}
            onOpenSubagentTranscript={() => {}}
            view="rich"
          />
        </TranscriptSearchProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain("advisor");
    expect(html).toContain('aria-label="Open advisor transcript"');
    expect(html).toContain('data-transcript-rail-event="subagent"');
  });

  it("loads child drawers from the ordinary conversation query", () => {
    const child = conversation(
      [
        event(0, {
          type: "visible_message",
          messageId: "child-answer",
          role: "assistant",
          text: "child detail answer",
        }),
      ],
      { conversationId: "child-1", displayTitle: "Advisor review" },
    );
    client.setQueryData(["conversation", "child-1"], child);
    const target: SubagentTranscriptTarget = {
      conversationId: "child-1",
      part: {
        type: "subagent",
        id: "child-1",
        childConversationId: "child-1",
        status: "completed",
        outcome: "success",
        subagentKind: "advisor",
      },
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <SubagentTranscriptDrawer target={target} onClose={() => {}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("Advisor review");
    expect(html).toContain("child detail answer");
    expect(html).toContain("/conversations/child-1");
    expect(html).toContain("Open conversation");
  });

  it("announces child conversation load failures with an error tone", () => {
    const errorClient = new QueryClient({
      defaultOptions: {
        queries: { refetchOnMount: false, retry: false, retryOnMount: false },
      },
    });
    const error = new Error("unavailable");
    errorClient.getQueryCache().build(
      errorClient,
      { queryKey: ["conversation", "child-error"] },
      {
        data: undefined,
        dataUpdateCount: 0,
        dataUpdatedAt: 0,
        error,
        errorUpdateCount: 1,
        errorUpdatedAt: Date.now(),
        fetchFailureCount: 1,
        fetchFailureReason: error,
        fetchMeta: null,
        fetchStatus: "idle",
        isInvalidated: false,
        status: "error",
      },
    );
    const target: SubagentTranscriptTarget = {
      conversationId: "child-error",
      part: {
        type: "subagent",
        id: "child-error",
        childConversationId: "child-error",
        status: "completed",
        outcome: "error",
        subagentKind: "advisor",
      },
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={errorClient}>
          <SubagentTranscriptDrawer target={target} onClose={() => {}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("Conversation failed to load.");
    expect(html).toContain('data-tone="error"');
    expect(html).toContain('role="alert"');
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

  it("renders Location directory and preserves stale rows on refresh failure", () => {
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
      <MemoryRouter>
        <LocationsPageContent data={data} error={new Error("refresh failed")} />
      </MemoryRouter>,
    );
    expect(html).toContain("Location telemetry refresh failed");
    expect(html).toContain("#proj-alpha");
    expect(html).toContain("Private activity");
    expect(html).toContain("Public and private conversations per day");
  });

  it("renders Location detail actors and recent conversations through stale data", () => {
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
          conversationId: "slack:C1:100",
          cumulativeDurationMs: 1_000,
          displayTitle: "Investigate checkout",
          lastProgressAt: "2026-01-05T00:00:00.000Z",
          lastSeenAt: "2026-01-05T00:00:00.000Z",
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
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LocationDetailPageContent
          data={detail}
          error={new Error("refresh failed")}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Location telemetry refresh failed");
    expect(html).toContain("Investigate checkout");
    expect(html).toContain("avery@example.com");
  });

  it("keeps plugin loading, failure, and stale data states distinct", () => {
    const loading = systemData();
    loading.pluginReportsLoading = true;
    loading.plugins = [{ name: "github" }];
    const loadingHtml = renderToStaticMarkup(
      <MemoryRouter>
        <SystemPage data={loading} />
      </MemoryRouter>,
    );
    expect(loadingHtml).toContain("Loading plugin stats.");

    const stale = systemData();
    stale.pluginReportsError = true;
    stale.pluginReports!.reports = [
      {
        metrics: [{ label: "active", value: "1" }],
        pluginName: "scheduler",
        title: "Scheduler",
      },
    ];
    const staleHtml = renderToStaticMarkup(
      <MemoryRouter>
        <SystemPage data={stale} />
      </MemoryRouter>,
    );
    expect(staleHtml).toContain("Plugin stats failed to load.");
    expect(staleHtml).toContain("Scheduler");
  });

  it("renders plugin records without declared fields safely", () => {
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

  it("renders structured tool inspector values without dumping one JSON blob", () => {
    const toolHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptToolView
          call={{
            input: { query: "checkout", filters: { environment: "prod" } },
            name: "search",
            type: "tool_call",
          }}
          result={{
            name: "search",
            output: { rows: [{ count: 12, endpoint: "/checkout" }] },
            type: "tool_result",
          }}
        />
      </QueryClientProvider>,
    );
    expect(toolHtml).toContain("arguments");
    expect(toolHtml).toContain("result");
    expect(toolHtml).toContain("<table");
    expect(toolHtml).toContain("/checkout");

    const valueHtml = renderToStaticMarkup(
      <ToolValueInspector
        value={{ command: "pnpm test", files: [{ path: "src/a.ts" }] }}
      />,
    );
    expect(valueHtml).toContain("pnpm test");
    expect(valueHtml).toContain("src/a.ts");
    expect(valueHtml).not.toContain("{&quot;command&quot;");
  });

  it("contains highlighted code so long mobile lines cannot widen transcripts", () => {
    const code = '{ "message": "CACHE_URL is required" }';
    client.setQueryData(
      ["highlight", "json", code],
      '<pre><code><span class="line">CACHE_URL is required</span></code></pre>',
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <HighlightedCode code={code} language="json" />
      </QueryClientProvider>,
    );
    expect(html).toContain("overflow-hidden");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("[&amp;_.line]:whitespace-pre-wrap");
  });

  it("renders cached canonical conversation detail through decoded routing", () => {
    const summary: ConversationSummaryReport = {
      conversationId: "slack:C1:123",
      cumulativeDurationMs: 1_000,
      displayTitle: "Cached conversation",
      lastProgressAt: "2026-01-01T00:00:01.000Z",
      lastSeenAt: "2026-01-01T00:00:01.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
    };
    const detail = conversation(
      [
        event(0, {
          type: "visible_message",
          messageId: "cached-answer",
          role: "assistant",
          text: "cached canonical answer",
        }),
      ],
      {
        conversationId: summary.conversationId,
        displayTitle: summary.displayTitle,
      },
    );
    client.setQueryData(["conversation", summary.conversationId], detail);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/conversations/slack%3AC1%3A123"]}>
          <Routes>
            <Route
              path="/conversations/:conversationId"
              element={
                <ConversationPage
                  conversationId={summary.conversationId}
                  data={{
                    conversations: {
                      conversations: [summary],
                      generatedAt: "2026-01-01T00:00:01.000Z",
                      source: "conversation_index",
                    },
                  }}
                />
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("Cached conversation");
    expect(html).toContain("cached canonical answer");
  });
});
