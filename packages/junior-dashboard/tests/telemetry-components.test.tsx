import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { HighlightedCode } from "../src/client/code";
import { ToolCallsMetric } from "../src/client/components/TelemetryMetrics";
import { Button } from "../src/client/components/Button";
import { FilterTabs } from "../src/client/components/FilterTabs";
import { StatusBadge } from "../src/client/components/StatusBadge";
import { TranscriptHeader } from "../src/client/components/TranscriptHeader";
import { TranscriptToolView } from "../src/client/components/TranscriptToolView";
import { ConversationTranscriptSegment } from "../src/client/components/TranscriptTurn";
import { ConversationDurationChart } from "../src/client/components/ConversationDurationChart";
import { client } from "../src/client/api";
import { CommandCenter } from "../src/client/pages/CommandCenter";
import { ConversationPage } from "../src/client/pages/ConversationPage";
import { ConversationsPage } from "../src/client/pages/ConversationsPage";
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

function toolRunTurn(toolCount: number): ConversationTurn {
  return {
    conversationId: "conversation-1",
    id: "turn-1",
    lastProgressAt: "2026-01-01T00:00:10.000Z",
    lastSeenAt: "2026-01-01T00:00:10.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    surface: "slack",
    title: "Turn turn-1",
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
      title: "Turn turn-1",
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
      title: "Turn turn-1",
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
    expect(html).not.toContain("+10s");
    expect(html).not.toContain("· +");
    expect(html).not.toContain("items-baseline gap-2 text-[0.88rem]");
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
      title: "Turn turn-1",
    } satisfies Session;

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ConversationDurationChart sessions={[session]} timeZone="UTC" />
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

    expect(html).not.toContain("turn");
    expect(html).not.toContain("tool call");
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
      title: "Readable transcript",
    } satisfies Session;

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

    expect(conversation).toContain("mx-auto w-full min-w-0 max-w-screen-xl");
    expect(conversations).toContain("mx-auto w-full min-w-0 max-w-screen-xl");
    expect(command).toContain("mx-auto grid w-full min-w-0 max-w-screen-xl");
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
      title: "Readable transcript",
    } satisfies Session;
    const detail = {
      conversationId: "conversation-1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      turns: [
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
      title: "Raw XML",
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

  it("collapses four consecutive tool calls to a reveal divider", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationTranscriptSegment turn={toolRunTurn(4)} view="rich" />
      </QueryClientProvider>,
    );

    expect(html).toContain("show 4 tool calls");
    expect(html).not.toContain("collapse");
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("py-1.5 text-left font-mono");
    expect(html).not.toContain("pl-3 text-left font-mono");
    expect(html).not.toContain("tool-0");
    expect(html).not.toContain("tool-1");
    expect(html).not.toContain("tool-2");
    expect(html).not.toContain("tool-3");
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

  it("moves thinking metadata out of mobile summaries", () => {
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      title: "Turn turn-1",
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
  });

  it("keeps fully visible thinking rows static until layout clips them", () => {
    const turn = {
      conversationId: "conversation-1",
      id: "turn-1",
      lastProgressAt: "2026-01-01T00:00:10.000Z",
      lastSeenAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      title: "Turn turn-1",
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

    expect(html).not.toContain("<details");
    expect(html).not.toContain("cursor-pointer");
    expect(html).toContain("checking the rollout");
    expect(html).toContain(
      "pointer-events-none invisible absolute inset-x-0 top-0 block truncate",
    );
  });
});
