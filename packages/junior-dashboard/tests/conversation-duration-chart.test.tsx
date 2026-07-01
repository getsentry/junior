import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { client } from "../src/client/api";
import { ConversationDurationChart } from "../src/client/components/ConversationDurationChart";
import type { ConversationSummary } from "../src/client/types";

const chartState = vi.hoisted(() => ({
  scatterData: [] as Array<Record<string, unknown>>,
}));

vi.mock("recharts", () => {
  const passthrough = (props: { children?: ReactNode }) =>
    props.children ?? null;
  return {
    CartesianGrid: () => null,
    ResponsiveContainer: passthrough,
    Scatter: (props: { data?: Array<Record<string, unknown>> }) => {
      chartState.scatterData = props.data ?? [];
      return null;
    },
    ScatterChart: passthrough,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
  };
});

afterEach(() => {
  chartState.scatterData = [];
  client.clear();
  vi.useRealTimers();
});

function renderChart(
  conversationSummaries: ConversationSummary[],
  nowMs: number,
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConversationDurationChart
          conversationSummaries={conversationSummaries}
          nowMs={nowMs}
          timeZone="UTC"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("conversation duration chart", () => {
  it("plots recent conversation runtime without double-counting cumulative turns", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"));

    const nowMs = Date.parse("2026-06-02T12:00:00.000Z");
    const conversationSummaries: ConversationSummary[] = [
      {
        completedAt: "2026-06-02T09:05:00.000Z",
        conversationId: "conversation-1",
        cumulativeDurationMs: 1_000,
        id: "turn-1",
        lastProgressAt: "2026-06-02T09:05:00.000Z",
        lastSeenAt: "2026-06-02T09:05:00.000Z",
        startedAt: "2026-06-02T09:00:00.000Z",
        status: "completed",
        surface: "slack",
        displayTitle: "Conversation",
      },
      {
        completedAt: "2026-06-02T11:03:00.000Z",
        conversationId: "conversation-1",
        cumulativeDurationMs: 2_500,
        id: "turn-2",
        lastProgressAt: "2026-06-02T11:03:00.000Z",
        lastSeenAt: "2026-06-02T11:03:00.000Z",
        startedAt: "2026-06-02T11:00:00.000Z",
        status: "completed",
        surface: "slack",
        displayTitle: "Conversation",
      },
      {
        conversationId: "conversation-active",
        cumulativeDurationMs: 3_000,
        id: "active-turn",
        lastProgressAt: "2026-06-02T11:30:00.000Z",
        lastSeenAt: "2026-06-02T11:30:00.000Z",
        startedAt: "2026-06-02T11:30:00.000Z",
        status: "active",
        surface: "slack",
        displayTitle: "Conversation",
      },
      {
        completedAt: "2026-06-02T10:10:00.000Z",
        conversationId: "conversation-carryover",
        cumulativeDurationMs: 9_000,
        id: "carryover-turn",
        lastProgressAt: "2026-06-02T10:10:00.000Z",
        lastSeenAt: "2026-06-02T10:10:00.000Z",
        startedAt: "2026-05-20T09:00:00.000Z",
        status: "completed",
        surface: "slack",
        displayTitle: "Conversation",
      },
      {
        completedAt: "2026-05-20T09:05:00.000Z",
        conversationId: "conversation-old",
        cumulativeDurationMs: 9_000,
        id: "old-turn",
        lastProgressAt: "2026-05-20T09:05:00.000Z",
        lastSeenAt: "2026-05-20T09:05:00.000Z",
        startedAt: "2026-05-20T09:00:00.000Z",
        status: "completed",
        surface: "slack",
        displayTitle: "Conversation",
      },
    ];
    const html = renderChart(conversationSummaries, nowMs);

    expect(chartState.scatterData).toHaveLength(2);
    expect(chartState.scatterData[0]).toMatchObject({
      conversationId: "conversation-carryover",
      durationLabel: "9.0s",
      durationMs: 9_000,
      x: Date.parse("2026-06-02T10:10:00.000Z"),
    });
    expect(chartState.scatterData[1]).toMatchObject({
      conversationId: "conversation-1",
      durationLabel: "2.5s",
      durationMs: 2_500,
    });
    expect(html).toContain(
      "3 recent conversations / 1 active / 0 hung / 0 errors",
    );
  });
});
