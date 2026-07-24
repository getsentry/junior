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
import { ContributionGrid } from "../src/client/components/ContributionGrid";
import { PluginReports } from "../src/client/components/PluginReports";
import {
  SubagentTranscriptDrawer,
  type SubagentTranscriptTarget,
} from "../src/client/components/SubagentTranscriptDrawer";
import { Transcript } from "../src/client/components/Transcript";
import { TranscriptHeader } from "../src/client/components/TranscriptHeader";
import { TranscriptMarkdown } from "../src/client/components/TranscriptMarkdown";
import { TranscriptSearchProvider } from "../src/client/components/transcriptSearch";
import { ConversationPage } from "../src/client/pages/ConversationPage";
import { LocationDetailPageContent } from "../src/client/pages/locations/LocationDetailPage";
import { LocationsPageContent } from "../src/client/pages/locations/LocationsPage";
import { Profile } from "../src/client/pages/people/PersonProfilePage";
import { SkillInventory } from "../src/client/pages/system/SkillInventory";
import { SystemPage } from "../src/client/pages/system/SystemPage";
import type { ConversationTranscript, SystemData } from "../src/client/types";

afterEach(() => client.clear());

function event(
  seq: number,
  data: ConversationReportEventData,
  createdAt = `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
): ConversationReportEvent {
  return { seq, createdAt, data };
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
    isParticipant: false,
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
      componentGallery: false,
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
      metricDays: [
        {
          costUsd: 4.56,
          date: "2026-01-01",
          durationMs: 12_000,
          tokens: 12_345,
        },
      ],
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
  it("renders transcript markdown with hard breaks and safe links", () => {
    const html = renderToStaticMarkup(
      <TranscriptSearchProvider query="line">
        <TranscriptMarkdown
          text={"line one\nline two\n\n[docs](https://docs.sentry.io)"}
        />
      </TranscriptSearchProvider>,
    );

    expect(html.match(/<br\/>/g)).toHaveLength(1);
    expect(html).toContain('href="https://docs.sentry.io"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("<mark");
  });

  it("highlights a markdown link label when search matches its URL", () => {
    const html = renderToStaticMarkup(
      <TranscriptSearchProvider query="docs.sentry.io">
        <TranscriptMarkdown text="[product docs](https://docs.sentry.io/platforms/)" />
      </TranscriptSearchProvider>,
    );

    expect(html).toContain("<mark");
    expect(html).toContain("product docs");
    expect(html).toContain(
      'title="Matched URL: https://docs.sentry.io/platforms/"',
    );
  });

  it("preserves snake_case identifiers while rendering emphasis", () => {
    const html = renderToStaticMarkup(
      <TranscriptSearchProvider query="">
        <TranscriptMarkdown text="some_var_name and *italic text*" />
      </TranscriptSearchProvider>,
    );

    expect(html).toContain("some_var_name");
    expect(html).not.toContain("some<em");
    expect(html).toContain("<em");
    expect(html).toContain("italic text");
  });

  it("renders labeled event sections followed by semantic lists", () => {
    const html = renderToStaticMarkup(
      <TranscriptSearchProvider query="">
        <TranscriptMarkdown text={"Handling:\n- first item\n- second item"} />
      </TranscriptSearchProvider>,
    );

    expect(html).toContain("<p");
    expect(html).toContain("Handling:");
    expect(html).toContain("<ul");
    expect(html.match(/<li/g)).toHaveLength(2);
  });

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

  it("shows responding state independently from live transcript following", () => {
    const active = conversation([], { status: "active" });
    const liveHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Transcript live transcript={active} />
      </QueryClientProvider>,
    );
    const quietHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Transcript live responding={false} transcript={active} />
      </QueryClientProvider>,
    );
    const completedHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Transcript transcript={{ ...active, status: "completed" }} />
      </QueryClientProvider>,
    );

    expect(liveHtml).toContain('role="status"');
    expect(liveHtml).toContain("Junior is responding");
    expect(liveHtml).not.toContain(">active</span>");
    expect(quietHtml).not.toContain("Junior is responding");
    expect(completedHtml).not.toContain("Junior is responding");
  });

  it("omits status badges from conversation detail while retaining progress", () => {
    const activeClient = conversationQueryClient();
    activeClient.setQueryData(
      ["conversation", "conversation-1"],
      conversation([], { status: "active" }),
    );
    const failedClient = conversationQueryClient();
    failedClient.setQueryData(
      ["conversation", "conversation-1"],
      conversation([], { status: "failed" }),
    );

    const activeHtml = renderConversationPageWithClient(activeClient);
    const failedHtml = renderConversationPageWithClient(failedClient);

    expect(activeHtml).not.toContain(">active</span>");
    expect(activeHtml).toContain("Junior is responding");
    expect(failedHtml).not.toContain(">error</span>");
  });

  it("distinguishes initial detail failures from stale refresh failures", () => {
    const initialClient = conversationQueryClient();
    const initialError = new Error("initial detail failed");
    const initialQuery = initialClient.getQueryCache().build(initialClient, {
      queryKey: ["conversation", "conversation-1"],
    });
    initialQuery.setState({
      ...initialQuery.state,
      error: initialError,
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
      status: "error",
    });

    const initialHtml = renderConversationPageWithClient(initialClient);
    expect(initialHtml).toContain("initial detail failed");
    expect(initialHtml).not.toContain(
      "Transcript refresh failed. Showing the latest available data.",
    );

    const staleClient = conversationQueryClient();
    const staleDetail = conversation(
      [
        event(0, {
          type: "message",
          messageId: "cached-answer",
          role: "assistant",
          text: "cached canonical answer",
        }),
      ],
      { status: "active" },
    );
    staleClient.setQueryData(["conversation", "conversation-1"], staleDetail);
    const staleQuery = staleClient.getQueryCache().find({
      queryKey: ["conversation", "conversation-1"],
    });
    staleQuery?.setState({
      ...staleQuery.state,
      error: new Error("refresh failed"),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
      status: "error",
    });

    const staleHtml = renderConversationPageWithClient(staleClient);
    expect(staleHtml).toContain("cached canonical answer");
    expect(staleHtml).toContain(
      "Transcript refresh failed. Showing the latest available data.",
    );
    expect(staleHtml).not.toContain("Junior is responding");
  });

  it("renders redacted visible events without exposing text", () => {
    const html = renderTranscript(
      conversation(
        [
          event(0, {
            type: "message",
            messageId: "private",
            role: "user",
            redacted: true,
          }),
          event(1, {
            type: "message",
            messageId: "resource-event",
            role: "user",
            eventType: "pull_request.merged",
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
    expect(html.match(/&lt;redacted&gt;/g)).toHaveLength(2);
    expect(html).toContain("pull_request.merged");
  });

  it("renders failure and context lifecycle rows", () => {
    const html = renderTranscript(
      conversation([
        event(0, { type: "compaction" }),
        event(1, {
          type: "handoff",
          modelProfile: "fast",
          modelId: "openai/gpt-5-mini",
        }),
        event(2, {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "failed",
          failureKind: "agent",
        }),
      ]),
    );
    expect(html).toContain("Context compacted");
    expect(html).toContain("Model handoff");
    expect(html).toContain("Agent response failed");
  });

  it("renders a delivery terminal failure without treating it as an agent failure", () => {
    const html = renderTranscript(
      conversation([
        event(0, {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "failed",
          failureKind: "delivery",
        }),
      ]),
    );
    expect(html).toContain("Message delivery failed");
    expect(html).toContain(
      "Junior could not deliver this message to its destination.",
    );
    expect(html).not.toContain("Agent response failed");
  });

  it("renders one in-progress row for a tool start", () => {
    const html = renderTranscript(
      conversation(
        [
          event(0, {
            type: "tool_started",
            toolCallId: "search-1",
            name: "search",
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
    expect(html).toContain("search");
    expect(html).toContain("running");
    expect(html).not.toContain("started");
    expect(html).not.toContain("missing result");
  });

  it("replaces the running treatment with details on the same completed row", () => {
    const html = renderTranscript(
      conversation([
        event(0, {
          type: "tool_started",
          toolCallId: "search-1",
          name: "search",
        }),
        event(1, {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              input: { query: "regression" },
            },
          ],
        }),
        event(2, {
          type: "tool_result",
          toolCallId: "search-1",
          outcome: "completed",
          output: { matches: 2 },
        }),
      ]),
    );

    expect(html).toContain("arguments");
    expect(html).toContain("result");
    expect(html).toContain("regression");
    expect(html).toContain("matches");
    expect(html).not.toContain("running");
    expect(html).not.toContain("completed");
  });

  it("renders a terminal tool error with its result details", () => {
    const html = renderTranscript(
      conversation([
        event(0, {
          type: "tool_started",
          toolCallId: "search-1",
          name: "search",
        }),
        event(1, {
          type: "tool_result",
          toolCallId: "search-1",
          outcome: "error",
          output: { error: "timed out" },
        }),
      ]),
    );

    expect(html).toContain("search");
    expect(html).toContain("error");
    expect(html).toContain("result");
    expect(html).toContain("timed out");
    expect(html).not.toContain("running");
  });

  it.each([
    ["running", undefined],
    ["aborted", "aborted"],
  ] as const)("renders the %s child lifecycle status", (status, outcome) => {
    const events: ConversationReportEvent[] = [
      event(0, {
        type: "subagent_started",
        childConversationId: "child-1",
        subagentKind: "advisor",
      }),
    ];
    if (outcome) {
      events.push(
        event(1, {
          type: "subagent_ended",
          startedSeq: 0,
          outcome,
        }),
      );
    }

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptSearchProvider query="">
          <ConversationTranscriptView
            conversation={conversation(events)}
            onOpenSubagentTranscript={() => {}}
            view="rich"
          />
        </TranscriptSearchProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain("advisor");
    expect(html).toContain(status);
    expect(html).toContain('aria-label="Open advisor transcript"');
  });

  it("loads child drawers from the ordinary conversation query", () => {
    const child = conversation(
      [
        event(0, {
          type: "message",
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

  it("keeps the terminal parent error when child detail says completed", () => {
    const child = conversation([], {
      conversationId: "child-1",
      displayTitle: "Advisor review",
      status: "completed",
    });
    client.setQueryData(["conversation", "child-1"], child);
    const target: SubagentTranscriptTarget = {
      conversationId: "child-1",
      part: {
        type: "subagent",
        id: "child-1",
        childConversationId: "child-1",
        status: "error",
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
    expect(html).toContain("error ·");
    expect(html).not.toContain("completed ·");
  });

  it("keeps a child transcript openable when its end event is missing", () => {
    const parentHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptSearchProvider query="">
          <ConversationTranscriptView
            conversation={conversation([
              event(0, {
                type: "subagent_started",
                childConversationId: "child-1",
                subagentKind: "advisor",
              }),
            ])}
            onOpenSubagentTranscript={() => {}}
            view="rich"
          />
        </TranscriptSearchProvider>
      </QueryClientProvider>,
    );

    expect(parentHtml).toContain('aria-label="Open advisor transcript"');

    const child = conversation([], {
      conversationId: "child-1",
      displayTitle: "Advisor review",
      status: "completed",
    });
    client.setQueryData(["conversation", "child-1"], child);
    const drawerHtml = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <SubagentTranscriptDrawer
            target={{
              conversationId: "child-1",
              part: {
                type: "subagent",
                id: "invocation-1",
                childConversationId: "child-1",
                status: "running",
                subagentKind: "advisor",
              },
            }}
            onClose={() => {}}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(drawerHtml).toContain("completed ·");
    expect(drawerHtml).not.toContain("running ·");
    expect(drawerHtml).toContain("Open conversation");
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
        status: "error",
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
          isParticipant: false,
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
          isParticipant: false,
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
    expect(loadingHtml).not.toContain("Loading plugin stats.");
    expect(loadingHtml).toContain(">github<");

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

  it("renders system metrics and capability inventories", () => {
    const data = systemData();
    data.plugins = [{ name: "github" }];
    data.skills = [{ name: "triage", pluginProvider: "github" }];

    const systemHtml = renderToStaticMarkup(
      <MemoryRouter>
        <SystemPage data={data} />
      </MemoryRouter>,
    );
    expect(systemHtml).toContain("Usage over time");
    expect(systemHtml).toContain("Token usage");
    expect(systemHtml).toContain("Model spend");
    expect(systemHtml).toContain("Runtime");
    expect(
      systemHtml.match(/aria-label="Reporting period"/g) ?? [],
    ).toHaveLength(1);
    expect(systemHtml).toContain('role="tablist"');
    expect(systemHtml).toContain('aria-selected="true"');
    expect(systemHtml).toContain(">Plugins<");
    expect(systemHtml).toContain(">Skills<");
    expect(systemHtml).toContain(">github<");
    expect(systemHtml).not.toContain(">loaded<");
    expect(systemHtml).not.toContain(">quiet<");
    expect(systemHtml).not.toContain(">metrics<");
    expect(systemHtml).not.toContain(">datasets<");
    expect(systemHtml).not.toContain(">triage<");

    const skillsHtml = renderToStaticMarkup(
      <SkillInventory skills={data.skills} />,
    );
    expect(skillsHtml).toContain(">github<");
    expect(skillsHtml).toContain(">triage<");
  });

  it("renders plugin chart widgets with accessible values", () => {
    const html = renderToStaticMarkup(
      <PluginReports
        reports={[
          {
            pluginName: "github",
            widgets: [
              {
                categories: [
                  {
                    id: "30d",
                    label: "30d",
                    values: { created: 4.5, merged: -1.25 },
                  },
                ],
                id: "pull-request-outcomes",
                series: [
                  { key: "created", label: "Created" },
                  { key: "merged", label: "Merged", tone: "good" },
                ],
                title: "Pull request outcomes",
                type: "bar_chart",
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain("Pull request outcomes");
    expect(html).toContain('aria-label="Chart legend"');
    expect(html).toContain('aria-label="30d, Created: 4.5"');
    expect(html).toContain('aria-label="30d, Merged: -1.25"');
  });

  it("prioritizes plugin report content at mobile widths", () => {
    const html = renderToStaticMarkup(
      <PluginReports
        reports={[
          {
            generatedAt: "2026-07-24T21:15:00.000Z",
            metrics: [
              { label: "Primary", value: "1" },
              { label: "Secondary", value: "2" },
            ],
            pluginName: "github",
            recordSets: [
              {
                fields: [
                  { key: "repository", label: "Repository" },
                  { key: "created", label: "Created" },
                  { key: "juniorOnly", label: "Junior-only merges" },
                  { key: "merged", label: "Merged" },
                ],
                records: [
                  {
                    id: "getsentry/junior",
                    values: {
                      created: "2",
                      juniorOnly: "1",
                      merged: "1",
                      repository: "getsentry/junior",
                    },
                  },
                ],
                title: "Pull request repositories · 30d",
              },
            ],
            title: "GitHub activity",
          },
        ]}
      />,
    );

    expect(html).toContain(
      'class="mt-1 hidden font-mono text-[0.62rem] text-white/30 sm:block"',
    );
    expect(html).toContain(
      'class="hidden shrink-0 font-mono text-[0.62rem] text-white/30 sm:block"',
    );
    expect(html).toContain(
      'class="min-w-0 bg-[#09090b] px-4 py-4 hidden sm:block"',
    );
    expect(html).toContain(
      'class="w-full table-fixed border-collapse text-left sm:min-w-[36rem] sm:table-auto"',
    );
    expect(html.match(/hidden sm:table-cell/g) ?? []).toHaveLength(2);
  });

  it("formats fractional chart ticks without floating-point noise", () => {
    const html = renderToStaticMarkup(
      <PluginReports
        reports={[
          {
            pluginName: "github",
            widgets: [
              {
                categories: [
                  { id: "7d", label: "7d", values: { created: 0.1 } },
                  { id: "30d", label: "30d", values: { created: 0.2 } },
                ],
                id: "fractional-outcomes",
                series: [{ key: "created", label: "Created" }],
                title: "Pull request outcomes",
                type: "bar_chart",
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain(">0.1</text>");
    expect(html).not.toContain("0.10000000000000002");
    expect(html).not.toContain('aria-label="Chart legend"');
  });

  it("keeps dense chart bars within their allocated slots", () => {
    const categories = Array.from({ length: 24 }, (_, index) => ({
      id: String(index),
      label: String(index),
      values: Object.fromEntries(
        Array.from({ length: 8 }, (__, seriesIndex) => [
          `series-${seriesIndex}`,
          seriesIndex + 1,
        ]),
      ),
    }));
    const series = Array.from({ length: 8 }, (_, index) => ({
      key: `series-${index}`,
      label: `Series ${index}`,
    }));
    const html = renderToStaticMarkup(
      <PluginReports
        reports={[
          {
            pluginName: "github",
            widgets: [
              {
                categories,
                id: "dense-outcomes",
                series,
                title: "Dense outcomes",
                type: "bar_chart",
              },
            ],
          },
        ]}
      />,
    );
    expect(html).not.toContain('width="2"');
  });

  it("renders daily chart ranges from the shared page selection", () => {
    const categories = Array.from({ length: 90 }, (_, index) => {
      const date = new Date("2026-05-03T00:00:00.000Z");
      date.setUTCDate(date.getUTCDate() + index);
      const label = date.toISOString().slice(0, 10);
      return {
        id: label,
        label,
        values: { created: index },
      };
    });
    const html = renderToStaticMarkup(
      <PluginReports
        range={7}
        reports={[
          {
            pluginName: "github",
            widgets: [
              {
                categories,
                id: "daily-outcomes",
                series: [{ key: "created", label: "Created" }],
                timeRangeDays: [7, 30, 90],
                title: "Pull request outcomes",
                type: "bar_chart",
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain('aria-label="2026-07-31, Created: 89"');
    expect(html).toContain('aria-label="2026-07-25, Created: 83"');
    expect(html).not.toContain('aria-label="2026-07-24, Created: 82"');
    expect(html).not.toContain('aria-label="Reporting period"');
  });

  it("renders an all-zero chart with a stable zero scale", () => {
    const html = renderToStaticMarkup(
      <PluginReports
        reports={[
          {
            pluginName: "github",
            widgets: [
              {
                categories: [
                  { id: "7d", label: "7d", values: { created: 0 } },
                  { id: "30d", label: "30d", values: { created: 0 } },
                ],
                id: "zero-outcomes",
                series: [{ key: "created", label: "Created" }],
                title: "Pull request outcomes",
                type: "bar_chart",
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain(">1</text>");
    expect(html).toContain(">0.5</text>");
    expect(html).toContain(">0</text>");
  });

  it("keeps chart chrome visible for empty widget data", () => {
    const html = renderToStaticMarkup(
      <PluginReports
        reports={[
          {
            pluginName: "github",
            widgets: [
              {
                categories: [],
                description: "Rolling outcomes",
                emptyText: "No outcomes yet.",
                id: "empty-outcomes",
                series: [{ key: "created", label: "Created" }],
                title: "Pull request outcomes",
                type: "bar_chart",
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain("Pull request outcomes");
    expect(html).toContain("Rolling outcomes");
    expect(html).toContain("No outcomes yet.");
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
      isParticipant: false,
      lastProgressAt: "2026-01-01T00:00:01.000Z",
      lastSeenAt: "2026-01-01T00:00:01.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
    };
    const detail = conversation(
      [
        event(0, {
          type: "message",
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

function conversationQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnMount: false, retry: false, retryOnMount: false },
    },
  });
}

function renderConversationPageWithClient(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/conversations/conversation-1"]}>
        <ConversationPage conversationId="conversation-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
