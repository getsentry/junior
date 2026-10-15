import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversationUsageBreakdown } from "../src/client/conversations/ConversationUsageBreakdown";
import { conversationFromDetail } from "../src/client/format";

function detail(
  overrides: Partial<ConversationDetailReport> = {},
): ConversationDetailReport {
  const startedAt = "2026-01-01T00:00:00.000Z";
  return {
    conversationId: "conversation-1",
    cumulativeDurationMs: 0,
    displayTitle: "Conversation",
    eventHistory: { status: "available" },
    events: [],
    generatedAt: startedAt,
    isParticipant: false,
    lastProgressAt: startedAt,
    lastSeenAt: startedAt,
    startedAt,
    status: "completed",
    surface: "internal",
    ...overrides,
  };
}

function render(report: ConversationDetailReport): string {
  return renderToStaticMarkup(
    <ConversationUsageBreakdown
      conversation={conversationFromDetail(report)}
      detail={report}
    />,
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("ConversationUsageBreakdown", () => {
  it("lists every model with its token types and every operation", () => {
    const html = render(
      detail({
        auxiliaryCosts: {
          costUsd: 0.003,
          operations: [
            {
              costUsd: 0.001,
              events: 2,
              name: "turn_routed",
              namespace: "junior",
            },
            {
              costUsd: 0.002,
              events: 5,
              name: "memories_recalled",
              namespace: "memory",
            },
          ],
        },
        modelUsage: [
          {
            modelId: "openai/gpt-5-mini",
            usage: {
              inputTokens: 300,
              outputTokens: 100,
              cost: { total: 0.01 },
            },
          },
          {
            modelId: "openai/gpt-5",
            usage: {
              cachedInputTokens: 700,
              inputTokens: 1_500,
              outputTokens: 500,
              cost: { total: 0.04 },
            },
          },
        ],
      }),
    );

    expect(html).toContain(
      "gpt-5 1.5k input · 500 output · 700 cached 2.7k $0.0400 gpt-5-mini 300 input · 100 output 400 $0.0100 All models 3.1k $0.0500",
    );
    expect(html).toContain(
      "Memory recall 5 $0.0020 Thinking routing 2 $0.0010 All auxiliary 7 $0.0030",
    );
    expect(html).not.toContain("This agent");
  });

  it("splits totals between this agent and its subagents", () => {
    const html = render(
      detail({
        childAgentTotals: {
          count: 2,
          cumulativeDurationMs: 0,
          cumulativeUsage: { inputTokens: 1_000, cost: { total: 0.01 } },
          auxiliaryCostUsd: 0.005,
        },
        modelUsage: [
          {
            modelId: "openai/gpt-5",
            usage: { inputTokens: 3_000, cost: { total: 0.04 } },
          },
        ],
      }),
    );

    expect(html).toContain(
      "This agent 2k $0.0250 2 subagents 1k $0.0150 Total 3k $0.0400",
    );
    expect(html).toContain("Totals include subagents at any depth.");
  });

  it("renders nothing without model or auxiliary usage", () => {
    expect(render(detail())).toBe("");
  });
});
