import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { client } from "../src/client/api";
import { ConversationDurationChart } from "../src/client/components/ConversationDurationChart";
import type { Session } from "../src/client/types";

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

function renderChart(sessions: Session[]): void {
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConversationDurationChart sessions={sessions} timeZone="UTC" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("conversation duration chart", () => {
  it("plots conversation duration as summed turn runtime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"));

    renderChart([
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
        title: "Turn turn-1",
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
        title: "Turn turn-2",
      },
    ]);

    expect(chartState.scatterData).toHaveLength(1);
    expect(chartState.scatterData[0]).toMatchObject({
      conversationId: "conversation-1",
      durationLabel: "3.5s",
      durationMs: 3_500,
    });
  });
});
