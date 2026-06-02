import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { ToolCallsMetric } from "../src/client/components/TelemetryMetrics";
import { Button } from "../src/client/components/Button";
import { FilterTabs } from "../src/client/components/FilterTabs";
import { TranscriptHeader } from "../src/client/components/TranscriptHeader";
import { TranscriptToolView } from "../src/client/components/TranscriptToolView";
import { TurnTranscript } from "../src/client/components/TranscriptTurn";
import { TurnDurationChart } from "../src/client/components/TurnDurationChart";
import { client } from "../src/client/api";
import { ConversationPage } from "../src/client/pages/ConversationPage";
import type {
  ConversationDetailFeed,
  ConversationTurn,
  DashboardData,
  Session,
} from "../src/client/types";

afterEach(() => {
  client.clear();
});

function dashboardData(sessions: Session[]): DashboardData {
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
    me: { user: {} },
    plugins: [],
    runtime: {
      cwd: "/repo",
      homeDir: "/home",
      packagedContent: {},
      providers: [],
      skills: [],
    },
    sessions: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      sessions,
      source: "turn_session_records",
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
      <TranscriptHeader onChange={() => {}} redacted={false} value="raw" />,
    );

    expect(filters).toContain('role="group"');
    expect(filters).toContain('aria-label="Conversation filter"');
    expect(filters.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(filters.match(/aria-pressed="false"/g) ?? []).toHaveLength(4);
    expect(transcript).toContain('aria-label="Transcript view"');
    expect(transcript.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(transcript.match(/aria-pressed="false"/g) ?? []).toHaveLength(1);
  });

  it("keeps the per-turn Sentry trace link in transcript headers", () => {
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      sentryTraceUrl: "https://sentry.example/trace/abc",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      title: "Turn turn-1",
      transcript: [],
      transcriptAvailable: true,
    } as ConversationTurn;

    const html = renderToStaticMarkup(
      <TurnTranscript number={1} turn={turn} view="rich" />,
    );

    expect(html).toContain("View in Sentry");
    expect(html).toContain("https://sentry.example/trace/abc");
  });

  it("removes residual grid row gap from collapsed system prompts", () => {
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      title: "Turn turn-1",
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
        <TurnTranscript number={1} turn={turn} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain("gap-y-0");
  });

  it("uses chart mode links as the duration chart title", () => {
    const session = {
      conversationId: "conversation-1",
      id: "turn-1",
      completedAt: "2026-01-01T00:00:03.000Z",
      lastProgressAt: "2026-01-01T00:00:03.000Z",
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      title: "Turn turn-1",
    } satisfies Session;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TurnDurationChart sessions={[session]} timeZone="UTC" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(html).not.toContain("Durations");
    expect(html).toContain("Turns");
    expect(html).toContain("Conversations");
    expect(html.indexOf("Conversations")).toBeLessThan(html.indexOf("Turns"));
    expect(html).toMatch(/aria-pressed="true"[^>]*>Conversations/);
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
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "not-a-date",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "internal",
      title: "Turn turn-1",
    } satisfies Session;
    const detail = {
      conversationId: "conversation-1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      turns: [
        {
          ...session,
          transcript: [],
          transcriptAvailable: true,
        },
      ],
    } satisfies ConversationDetailFeed;
    client.setQueryData(["conversation", "conversation-1"], detail);

    const html = renderConversationPage(dashboardData([session]));

    expect(html).toContain("1 turn");
    expect(html).not.toContain("tool call");
    expect(html.match(/·/g) ?? []).toHaveLength(2);
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

    expect(html.match(/·/g) ?? []).toHaveLength(2);
  });
});
