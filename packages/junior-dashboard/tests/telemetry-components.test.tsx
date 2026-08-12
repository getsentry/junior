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
  Plugin,
} from "@sentry/junior/api/schema";

import { conversationDetailQueryKey } from "../src/client/conversations/queries";
import { ConversationTranscriptView } from "../src/client/conversations/ConversationTranscript";
import {
  SubagentTranscriptDrawer,
  type SubagentTranscriptTarget,
} from "../src/client/conversations/SubagentTranscriptDrawer";
import { Transcript } from "../src/client/conversations/TranscriptView";
import { TranscriptHeader } from "../src/client/conversations/TranscriptHeader";
import { TranscriptMarkdown } from "../src/client/conversations/TranscriptMarkdown";
import { TranscriptText } from "../src/client/conversations/TranscriptText";
import { TranscriptToolView } from "../src/client/conversations/TranscriptToolView";
import { TranscriptSearchProvider } from "../src/client/conversations/transcriptSearch";
import { ConversationPage } from "../src/client/conversations/ConversationPage";
import { ToolCallGallery } from "../src/client/pages/dev/ComponentsPage";
import { LocationDetailPageContent } from "../src/client/pages/locations/LocationDetailPage";
import { LocationsPageContent } from "../src/client/pages/locations/LocationsPage";
import { Profile } from "../src/client/pages/people/PersonProfilePage";
import { ContributionGrid } from "../src/client/pages/people/ContributionGrid";
import { PluginReports } from "../src/client/pages/system/PluginReports";
import { SkillInventory } from "../src/client/pages/system/SkillInventory";
import { SystemPage } from "../src/client/pages/system/SystemPage";
import type { ConversationTranscript, SystemData } from "../src/client/types";

const client = new QueryClient();

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
      guardian: {
        allow: 3,
        ask: 1,
        costUsd: 0.08,
        deny: 1,
        metricDays: [
          {
            allow: 3,
            ask: 1,
            costUsd: 0.08,
            date: "2026-01-01",
            deny: 1,
            requests: 5,
          },
        ],
        requests: 5,
      },
      metricDays: [
        {
          cachedInputTokens: 9_000,
          conversations: 2,
          costUsd: 4.56,
          date: "2026-01-01",
          durationMs: 12_000,
          inputTokens: 3_000,
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

function plugin(name: string, overrides: Partial<Plugin> = {}): Plugin {
  return {
    configKeys: [],
    description: `${name} plugin description`,
    displayName:
      name === "github" ? "GitHub" : `${name[0].toUpperCase()}${name.slice(1)}`,
    name,
    ...overrides,
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

  it("renders bold-wrapped bare URLs without leaking emphasis markers into the href", () => {
    const html = renderToStaticMarkup(
      <TranscriptSearchProvider query="">
        <TranscriptMarkdown text="**PR is up: https://github.com/getsentry/getsentry/pull/21513**" />
      </TranscriptSearchProvider>,
    );

    expect(html).toContain(
      'href="https://github.com/getsentry/getsentry/pull/21513"',
    );
    expect(html).not.toContain("pull/21513**");
    expect(html).not.toContain(">**</");
    expect(html).toContain("<strong");
    expect(html).toContain("PR is up:");
  });

  it("renders code-like user prose as markdown", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptText
          role="user"
          text="The function reads a const value and returns it."
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("<p");
    expect(html).not.toContain("<pre");
    expect(html).toContain("function reads a const value");
  });

  it("renders fenced XML as highlighted code", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptText role="user" text={"```xml\n<root />\n```"} />
      </QueryClientProvider>,
    );

    expect(html).toContain("<pre");
    expect(html).not.toContain("<details");
    expect(html).toContain("&lt;root /&gt;");
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

  it("renders typed tool states in the component gallery", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ToolCallGallery />
      </QueryClientProvider>,
    );

    expect(html).toContain("webSearch");
    expect(html).toContain(
      "github_search, query: &quot;is:pr is:open&quot;, limit: 25",
    );
    expect(html).toContain("jr-rpc config get github.repo");
    expect(html).toContain("junior-qa");
    expect(html).toContain('aria-label="bash (failed)"');
  });

  it("keeps a running tool name searchable and accessible", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptSearchProvider query="search">
          <TranscriptToolView
            part={{
              id: "tool-1",
              input: { query: "regression" },
              name: "webSearch",
              status: "running",
              type: "tool_call",
            }}
          />
        </TranscriptSearchProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain('aria-label="webSearch (running)"');
    expect(html).toContain("query");
    expect(html).toContain("regression");
    expect(html).toContain("<mark");
  });

  it("shows response size beside tool duration", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TranscriptSearchProvider query="">
          <TranscriptToolView
            part={{
              id: "tool-1",
              name: "webSearch",
              output: "x".repeat(5_100),
              resultTimestamp: 6_000,
              status: "completed",
              type: "tool_call",
            }}
            timestamp={1_000}
          />
        </TranscriptSearchProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain("5.0s · 5kb");
  });

  it("exposes pressed state for transcript view controls", () => {
    const html = renderToStaticMarkup(
      <TranscriptHeader
        onChange={() => {}}
        onSearchChange={() => {}}
        redacted={false}
        search=""
        value="raw"
      />,
    );
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g) ?? []).toHaveLength(1);
    expect(html).toContain("Conversation");
    expect(html).toContain("Event log");
    expect(html).toContain('aria-label="Search transcript"');
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

  it("does not present partial event counts as conversation totals", () => {
    const events = [
      event(0, {
        type: "message",
        messageId: "user-1",
        role: "user",
        text: "Investigate",
      }),
      event(1, {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "search-1",
            name: "search",
            status: "running",
          },
        ],
      }),
    ];
    const partialClient = conversationQueryClient();
    partialClient.setQueryData(
      conversationDetailQueryKey("conversation-1"),
      conversation(events, { previousCursor: "older-events" }),
    );
    const completeClient = conversationQueryClient();
    completeClient.setQueryData(
      conversationDetailQueryKey("conversation-1"),
      conversation(events),
    );

    const partialHtml = renderConversationPageWithClient(partialClient);
    const completeHtml = renderConversationPageWithClient(completeClient);
    const partialTranscriptHtml = renderTranscript(
      conversation(events, { previousCursor: "older-events" }),
    );
    const completeTranscriptHtml = renderTranscript(conversation(events));

    // Conversation-level totals only render from complete history. Turns are the
    // unique header signal; tool chips may still label visible activity on partial pages.
    expect(partialHtml).not.toContain("1 turn");
    expect(completeHtml).toContain("1 turn");
    // Transcript does not mirror conversation turn totals in a segment row.
    expect(partialTranscriptHtml).not.toContain("1 turn");
    expect(completeTranscriptHtml).not.toContain("1 turn");
    expect(partialTranscriptHtml).toContain("1 tool call");
    expect(completeTranscriptHtml).toContain("1 tool call");
  });

  it("renders each user message with its own actor", () => {
    const html = renderTranscript(
      conversation(
        [
          event(0, {
            type: "message",
            messageId: "user-1",
            role: "user",
            text: "Good catch.",
            actorIdentity: {
              fullName: "Taylor Chen",
              slackUserName: "taylor",
            },
          }),
        ],
        { actorIdentity: { fullName: "Morgan Lee" } },
      ),
    );

    expect(html).toContain("Taylor Chen");
    expect(html).not.toContain("Morgan Lee");
  });

  it("shows a Slack icon for Slack-origin messages only", () => {
    const slackHtml = renderTranscript(
      conversation(
        [
          event(0, {
            messageId: "slack-user-history",
            role: "user",
            text: "From Slack history.",
            type: "message",
          }),
          event(1, {
            messageId: "slack-user-explicit",
            role: "user",
            source: "slack",
            text: "From Slack mailbox.",
            type: "message",
          }),
          event(2, {
            messageId: "slack-assistant",
            role: "assistant",
            text: "Posted to Slack.",
            type: "message",
          }),
          event(3, {
            messageId: "dashboard-user",
            role: "user",
            source: "web",
            text: "Continued from the dashboard.",
            type: "message",
          }),
          event(4, {
            messageId: "dashboard-assistant",
            role: "assistant",
            source: "web",
            text: "Stays in Junior.",
            type: "message",
          }),
        ],
        { surface: "slack" },
      ),
    );
    const dashboardRootHtml = renderTranscript(
      conversation([
        event(0, {
          messageId: "web-message",
          role: "user",
          source: "web",
          text: "From the dashboard.",
          type: "message",
        }),
      ]),
    );

    expect(slackHtml).toContain('aria-label="Slack"');
    expect(slackHtml).not.toContain(">Slack<");
    // History omit + explicit slack user + Slack-outbound assistant. Web is native.
    expect(slackHtml.match(/aria-label="Slack"/g)).toHaveLength(3);
    expect(dashboardRootHtml).not.toContain("Dashboard");
    expect(dashboardRootHtml).not.toContain('aria-label="Slack"');
  });

  it("omits status badges from conversation detail while retaining progress", () => {
    const activeClient = conversationQueryClient();
    activeClient.setQueryData(
      conversationDetailQueryKey("conversation-1"),
      conversation([], { status: "active" }),
    );
    const failedClient = conversationQueryClient();
    failedClient.setQueryData(
      conversationDetailQueryKey("conversation-1"),
      conversation([], { status: "failed" }),
    );

    const activeHtml = renderConversationPageWithClient(activeClient);
    const failedHtml = renderConversationPageWithClient(failedClient);

    expect(activeHtml).not.toContain(">active</span>");
    expect(activeHtml).toContain("Junior is responding");
    expect(failedHtml).not.toContain(">error</span>");
  });

  it("renders conversation resource links without pull request assumptions", () => {
    const queryClient = conversationQueryClient();
    queryClient.setQueryData(
      conversationDetailQueryKey("conversation-1"),
      conversation([], {
        annotations: [
          {
            kind: "resource_link",
            key: "getsentry/junior#1081",
            label: "getsentry/junior#1081",
            plugin: "github",
            status: "open",
            url: "https://github.com/getsentry/junior/issues/1081",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        ],
      }),
    );

    const html = renderConversationPageWithClient(queryClient);

    expect(html).toContain("getsentry/junior#1081");
    expect(html).toContain('title="Open"');
    expect(html).not.toContain("Linked resources");
    expect(html).not.toContain("Pull requests");
    expect(html).not.toContain("Open pull request");
  });

  it("distinguishes initial detail failures from stale refresh failures", () => {
    const initialClient = conversationQueryClient();
    const initialError = new Error("initial detail failed");
    const initialQuery = initialClient.getQueryCache().build(initialClient, {
      queryKey: conversationDetailQueryKey("conversation-1"),
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
    staleClient.setQueryData(
      conversationDetailQueryKey("conversation-1"),
      staleDetail,
    );
    const staleQuery = staleClient.getQueryCache().find({
      queryKey: conversationDetailQueryKey("conversation-1"),
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

  it("anchors structured events to the transcript rail", () => {
    const html = renderTranscript(
      conversation([
        event(0, {
          type: "structured_event",
          namespace: "memory",
          name: "memories_captured",
          version: 1,
          turnId: "turn-1",
          presentation: {
            icon: "brain",
            title: "2 memories captured",
          },
        }),
      ]),
    );

    expect(html).toContain('data-transcript-rail-event="structured_event"');
    expect(html).toContain("lucide-brain");
    expect(html).toContain("2 memories captured");
  });

  it("keeps recalled memory context collapsed on its user message", () => {
    const html = renderTranscript(
      conversation([
        event(0, {
          type: "message",
          messageId: "user-1",
          role: "user",
          text: "Prepare the release.",
        }),
        event(1, {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "started",
        }),
        event(2, {
          type: "turn_context",
          turnId: "turn-1",
          pluginName: "memory",
          kind: "recall",
          version: 1,
          content: {
            memories: [
              {
                id: "memory-1",
                content: "Release notes live in Notion.",
                observedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
                scope: "conversation",
                kind: "knowledge",
              },
            ],
          },
        }),
      ]),
    );

    expect(html).toContain('aria-label="View turn context"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Release notes live in Notion.");
    expect(html).not.toContain("memory-1");
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
            type: "tool_calls",
            calls: [
              {
                toolCallId: "search-1",
                name: "search",
                status: "running",
              },
            ],
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
    expect(html).toContain('aria-label="search (running)"');
    expect(html).not.toContain(">running<");
    expect(html).not.toContain("started");
    expect(html).not.toContain("missing result");
  });

  it("replaces the running treatment with details on the same completed row", () => {
    const html = renderTranscript(
      conversation([
        event(0, {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
            },
          ],
        }),
        event(1, {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
              input: { query: "regression" },
            },
          ],
        }),
        event(2, {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "completed",
              output: { matches: 2 },
            },
          ],
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
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
            },
          ],
        }),
        event(1, {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "error",
              output: { error: "timed out" },
            },
          ],
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
        type: "subagent",
        startedSeq: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
        childConversationId: "child-1",
        subagentKind: "advisor",
        status: "running",
      }),
    ];
    if (outcome) {
      events.push(
        event(1, {
          type: "subagent",
          startedSeq: 0,
          startedAt: "2026-01-01T00:00:00.000Z",
          childConversationId: "child-1",
          subagentKind: "advisor",
          status: outcome,
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
    client.setQueryData(conversationDetailQueryKey("child-1"), child);
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
    client.setQueryData(conversationDetailQueryKey("child-1"), child);
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
                type: "subagent",
                startedSeq: 0,
                startedAt: "2026-01-01T00:00:00.000Z",
                childConversationId: "child-1",
                subagentKind: "advisor",
                status: "running",
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
    client.setQueryData(conversationDetailQueryKey("child-1"), child);
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
      { queryKey: conversationDetailQueryKey("child-error") },
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

  it("keeps a cached child transcript visible after a refresh failure", () => {
    const staleClient = conversationQueryClient();
    const staleDetail = conversation(
      [
        event(0, {
          type: "message",
          messageId: "cached-child-answer",
          role: "assistant",
          text: "cached child answer",
        }),
      ],
      { conversationId: "child-stale", status: "active" },
    );
    staleClient.setQueryData(
      conversationDetailQueryKey("child-stale"),
      staleDetail,
    );
    const staleQuery = staleClient.getQueryCache().find({
      queryKey: conversationDetailQueryKey("child-stale"),
    });
    staleQuery?.setState({
      ...staleQuery.state,
      error: new Error("refresh failed"),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
      status: "error",
    });
    const target: SubagentTranscriptTarget = {
      conversationId: "child-stale",
      part: {
        type: "subagent",
        id: "child-stale",
        childConversationId: "child-stale",
        status: "running",
        subagentKind: "advisor",
      },
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={staleClient}>
          <SubagentTranscriptDrawer target={target} onClose={() => {}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(html).toContain("cached child answer");
    expect(html).not.toContain("Conversation failed to load.");
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
          costUsd: 0.42,
          date: "2026-01-02",
          durationMs: 1_200,
          failed: 0,
          tokens: 1_234,
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
        {
          active: 0,
          conversations: 1,
          durationMs: 400,
          failed: 0,
          label: "#proj-beta",
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
        {
          active: 0,
          conversations: 1,
          durationMs: 400,
          failed: 0,
          label: "API",
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
    expect(html).toContain("Usage over time");
    expect(html).toContain("Token usage");
    expect(html).toContain("Model spend");
    expect(html).toContain("Runtime");
    expect(html).toContain("1.2k");
    expect(html).toContain("$0.42");
    expect(html).toContain("30d");
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
          html.indexOf(
            'aria-label="2026-01-01: 0 conversations, 0ms, $0.00 spend, 0 tokens"',
          ),
        )
        .match(/class="size-3 border border-black\/40 bg-\[#101010\]"/g),
    ).toHaveLength(4);
    expect(html).not.toContain('href="/people/avery%40example.com"');
    expect(html).toContain('href="/system/people"');
    expect(html).toContain("Back to people");
    expect(html).not.toContain("System / people");
    expect(html).not.toContain('aria-label="Search recent conversations"');
    expect(html).toContain(">Places<");
    expect(html).toContain(">Surfaces<");
    expect(html.indexOf(">Places<")).toBeGreaterThan(activityStart);
    expect(html.indexOf(">Surfaces<")).toBeGreaterThan(activityStart);
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
    expect(html).toContain("Conversations: ");
  });

  it("renders Location detail actors without recent conversations through stale data", () => {
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
    expect(html).toContain("avery@example.com");
    expect(html).not.toContain("Investigate checkout");
    expect(html).not.toContain("Recent conversations");
  });

  it("keeps plugin loading, failure, and stale data states distinct", () => {
    const loading = systemData();
    loading.pluginReportsLoading = true;
    loading.plugins = [plugin("github")];
    const loadingHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/system/plugins/github"]}>
        <SystemPage data={loading} />
      </MemoryRouter>,
    );
    expect(loadingHtml).not.toContain("Loading plugin stats.");
    expect(loadingHtml).toContain(">GitHub<");
    expect(loadingHtml).toContain('href="/system/plugins"');
    expect(loadingHtml).not.toContain('href="/system/plugins/github"');
    expect(loadingHtml).not.toContain(
      "This plugin does not expose operational activity yet.",
    );

    const stale = systemData();
    stale.pluginReportsError = true;
    stale.plugins = [plugin("scheduler")];
    stale.pluginReports!.reports = [
      {
        metrics: [{ label: "active", value: "1" }],
        pluginName: "scheduler",
        title: "Scheduler",
      },
    ];
    const staleHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/system/plugins/scheduler"]}>
        <SystemPage data={stale} />
      </MemoryRouter>,
    );
    expect(staleHtml).toContain("Plugin stats failed to load.");
    expect(staleHtml).toContain("Scheduler");
    expect(staleHtml).toContain("active");
    expect(staleHtml).not.toContain(
      "This plugin does not expose operational activity yet.",
    );

    const overviewHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/system"]}>
        <SystemPage data={stale} />
      </MemoryRouter>,
    );
    expect(overviewHtml).not.toContain("Plugin stats failed to load.");

    const inventoryHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/system/plugins"]}>
        <SystemPage data={stale} />
      </MemoryRouter>,
    );
    expect(inventoryHtml).toContain("Plugin stats failed to load.");
    expect(inventoryHtml).toContain(
      "Showing the last operational reports Junior received.",
    );
  });

  it("renders system metrics and capability inventories", () => {
    const data = systemData();
    data.plugins = [plugin("github")];
    data.skills = [{ name: "triage", pluginProvider: "github" }];

    const systemHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/system"]}>
        <SystemPage data={data} />
      </MemoryRouter>,
    );
    expect(systemHtml).not.toContain("Usage over time");
    expect(systemHtml).toContain("Conversation activity");
    expect(systemHtml).toContain('aria-label="Conversations per day"');
    expect(systemHtml).toContain("Cache hit rate");
    expect(systemHtml).toContain("75.0%");
    expect(systemHtml).toContain("Input token cache");
    expect(systemHtml).toContain("Model spend");
    expect(systemHtml).toContain("Runtime");
    expect(systemHtml).toContain("Guardian reviews");
    expect(systemHtml).toContain("Daily Guardian review results");
    expect(systemHtml).toContain("Estimated cost");
    expect(systemHtml).toContain(
      'class="inline-flex h-full min-w-0 flex-1 items-end"',
    );
    expect(systemHtml).toContain(
      'class="flex w-full min-w-0 flex-col justify-end',
    );
    expect(systemHtml.indexOf("Conversation activity")).toBeLessThan(
      systemHtml.indexOf("Input token cache"),
    );
    expect(
      systemHtml.match(/aria-label="Reporting period"/g) ?? [],
    ).toHaveLength(1);
    expect(systemHtml).toContain('aria-label="System navigation"');
    expect(systemHtml).toContain('href="/system/people"');
    expect(systemHtml).toContain('href="/system/locations"');
    expect(systemHtml).toContain('href="/system/plugins"');
    expect(systemHtml).toContain(">Plugins</a>");
    expect(systemHtml).not.toContain(">Capabilities<");
    expect(systemHtml).not.toContain(">All Plugins<");
    expect(systemHtml).not.toContain(">Skills<");
    expect(systemHtml).not.toContain(">GitHub<");
    expect(systemHtml).not.toContain(">loaded<");
    expect(systemHtml).not.toContain(">quiet<");
    expect(systemHtml).not.toContain(">metrics<");
    expect(systemHtml).not.toContain(">datasets<");
    expect(systemHtml).not.toContain(">1 loaded<");
    expect(systemHtml).not.toContain(">triage<");

    const pluginsHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/system/plugins"]}>
        <SystemPage data={data} />
      </MemoryRouter>,
    );
    expect(pluginsHtml).toContain(">Plugins<");
    expect(pluginsHtml).toContain(">Skills<");
    expect(pluginsHtml).toContain(">GitHub<");
    expect(pluginsHtml).toContain(">triage<");
    expect(pluginsHtml).not.toContain("Usage over time");
    expect(pluginsHtml).not.toContain('aria-label="Reporting period"');

    const skillsHtml = renderToStaticMarkup(
      <SkillInventory skills={data.skills} />,
    );
    expect(skillsHtml).toContain(">github<");
    expect(skillsHtml).toContain(">triage<");
  });

  it("renders each plugin as a dedicated System route", () => {
    const data = systemData();
    data.plugins = [
      plugin("github", {
        configKeys: ["github.organization"],
      }),
      plugin("scheduler", {}),
    ];
    data.skills = [{ name: "scheduled-tasks", pluginProvider: "scheduler" }];
    data.pluginReports!.reports = [
      {
        metrics: [{ label: "active tasks", value: "4" }],
        pluginName: "scheduler",
        title: "Scheduler",
      },
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/system/plugins/scheduler"]}>
        <SystemPage data={data} />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="System navigation"');
    expect(html).not.toContain('href="/system/plugins/github"');
    expect(html).toContain('href="/system/plugins"');
    expect(html).not.toContain('href="/system/plugins/scheduler"');
    expect(html).toContain(">Scheduler<");
    expect(html).toContain(">active tasks<");
    expect(html).toContain(">scheduled-tasks<");
    expect(html).not.toContain(">1 reporting<");
    expect(html).not.toContain("Usage over time");
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

  it("uses the plugin display name for a single metric", () => {
    const html = renderToStaticMarkup(
      <PluginReports
        fallbackTitle="GitHub"
        reports={[
          {
            metrics: [{ label: "report", value: "failed" }],
            pluginName: "github",
            title: "github",
          },
        ]}
      />,
    );

    expect(html).toContain(">GitHub<");
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

  it("formats plugin cost charts as USD", () => {
    const html = renderToStaticMarkup(
      <PluginReports
        reports={[
          {
            pluginName: "memory",
            widgets: [
              {
                categories: [
                  {
                    id: "2026-07-31",
                    label: "2026-07-31",
                    values: { costUsd: 0.0042 },
                  },
                ],
                id: "extraction-cost",
                series: [
                  {
                    format: "usd",
                    key: "costUsd",
                    label: "Cost",
                  },
                ],
                title: "Extraction cost",
                type: "bar_chart",
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain('aria-label="2026-07-31, Cost: $0.0042"');
    expect(html).toContain(">$0.0042</text>");
    expect(html).toContain('x1="104"');
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

  it("renders profile activity tooltips with daily spend and tokens", () => {
    const html = renderToStaticMarkup(
      <ContributionGrid
        days={[
          {
            conversations: 1,
            costUsd: 0.42,
            date: "2026-01-01",
            durationMs: 0,
            tokens: 1_234,
          },
        ]}
      />,
    );

    expect(html).toContain(
      'aria-label="2026-01-01: 1 conversations, unknown, $0.42 spend, 1.2k tokens"',
    );
    expect(html).toContain("spend");
    expect(html).toContain("$0.42");
    expect(html).toContain("tokens");
    expect(html).toContain("1.2k");
  });
  it("links a task-triggered conversation with compact source metadata", () => {
    const detail = conversation([], {
      sourceTask: {
        id: "sched_source_task",
        kind: "scheduled",
        label: "Update getsentry/yc-scraper YC company data and open a PR.",
        title: "Refresh YC company data",
      },
    });
    client.setQueryData(
      conversationDetailQueryKey(detail.conversationId),
      detail,
    );

    const html = renderConversationPageWithClient(client);

    expect(html).toMatch(
      /href="\/tasks\/sched_source_task"[^>]*>Triggered by Scheduled Task<\/a>/,
    );
    expect(html).not.toContain(
      "Triggered by Scheduled Task · Update getsentry/yc-scraper",
    );
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
    client.setQueryData(
      conversationDetailQueryKey(summary.conversationId),
      detail,
    );
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
