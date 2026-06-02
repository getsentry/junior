import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToolCallsMetric } from "../src/client/components/TelemetryMetrics";
import { TurnTranscript } from "../src/client/components/TranscriptTurn";
import type { ConversationTurn } from "../src/client/types";

describe("dashboard telemetry components", () => {
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

  it("omits empty tool-call summaries", () => {
    expect(
      renderToStaticMarkup(
        <ToolCallsMetric summary={{ items: [], total: 0 }} />,
      ),
    ).toBe("");
  });
});
