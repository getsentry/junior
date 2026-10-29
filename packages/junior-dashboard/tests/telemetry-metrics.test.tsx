import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/client/components/Metric", () => ({
  MetricValue: (props: {
    children: ReactNode;
    tooltip?: Array<{ label?: string; live?: boolean; value: string }>;
    tooltipCard?: ReactNode;
    tooltipPlacement?: "above" | "below";
  }) => (
    <span data-tooltip-placement={props.tooltipPlacement}>
      {props.children}
      {props.tooltip?.map((line) => (
        <span key={`${line.label}-${line.value}-${line.live ? "live" : ""}`}>
          {line.label}: {line.value}
          {line.live ? " · in progress" : ""}
        </span>
      ))}
      {props.tooltipCard}
    </span>
  ),
}));

import {
  CostMetric,
  DurationMetric,
  TokenMetric,
  ToolCallsMetric,
} from "../src/client/conversations/TelemetryMetrics";

const shimmerClass = /class="[^"]*\bshimmer\b/;

/** Read rendered markup as plain text, one space between elements. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("CostMetric", () => {
  it.each([
    {
      name: "total-only costs",
      cost: { total: 0.42 },
    },
    {
      name: "mixed total and component costs",
      cost: { total: 0.42, input: 0.1 },
    },
    {
      name: "component costs",
      cost: { input: 0.1, output: 0.32 },
    },
  ])("shows one row per model for $name", ({ cost }) => {
    const html = text(
      renderToStaticMarkup(
        <CostMetric
          modelUsage={[{ modelId: "openai/gpt-5", usage: { cost } }]}
          summary={{ total: 0.42 }}
        />,
      ),
    );

    expect(html).toContain("Estimated cost $0.4200");
    expect(html).toContain("By model gpt-5 $0.4200");
  });

  it("shows provisional cost while conversation metrics are live", () => {
    const emptyHtml = renderToStaticMarkup(
      <CostMetric live liveModelId="xai/grok-4-5" summary={undefined} />,
    );
    expect(emptyHtml).toContain("$…");
    expect(emptyHtml).toContain("grok-4-5");
    expect(emptyHtml).toContain("· in progress");
    expect(emptyHtml).toMatch(shimmerClass);

    const partialHtml = renderToStaticMarkup(
      <CostMetric
        live
        liveModelId="xai/grok-4-5"
        modelUsage={[
          {
            modelId: "xai/grok-4-5",
            usage: { cost: { total: 0.041 } },
          },
        ]}
        summary={{ total: 0.02 }}
      />,
    );
    expect(partialHtml).toContain("$0.04+");
    expect(text(partialHtml)).toContain("grok-4-5 in progress $0.0410");
    expect(partialHtml).toMatch(shimmerClass);

    const settledHtml = renderToStaticMarkup(
      <CostMetric summary={{ total: 0.041 }} />,
    );
    expect(settledHtml).toContain("$0.04");
    expect(settledHtml).not.toContain("+");
    expect(settledHtml).not.toContain("in progress");
    expect(settledHtml).not.toMatch(shimmerClass);
  });

  it("splits cost between this agent and its subagents", () => {
    const html = text(
      renderToStaticMarkup(
        <CostMetric
          childAgentTotals={{
            auxiliaryCostUsd: 0.01,
            count: 3,
            cumulativeDurationMs: 0,
            cumulativeUsage: { cost: { total: 0.1 } },
          }}
          modelUsage={[
            { modelId: "openai/gpt-5", usage: { cost: { total: 0.3 } } },
          ]}
          summary={{ total: 0.3 }}
        />,
      ),
    );
    expect(html).toContain("this agent $0.1900");
    expect(html).toContain("3 subagents $0.1100");
  });

  it("lists the largest models and operations, then rolls up the rest", () => {
    const models = [0.05, 0.04, 0.03, 0.02, 0.01, 0.005].map(
      (total, index) => ({
        modelId: `openai/model-${index}`,
        usage: { cost: { total } },
      }),
    );
    const operations = [0.0002, 0.0004, 0.0014, 0.0001, 0.0003].map(
      (costUsd, index) => ({
        costUsd,
        events: 1,
        name: `operation_${index}`,
        namespace: "junior",
      }),
    );
    const html = text(
      renderToStaticMarkup(
        <CostMetric
          auxiliaryCosts={{ costUsd: 0.0024, operations }}
          detailsHint
          modelUsage={[...models].reverse()}
          summary={{ total: 0.01 }}
        />,
      ),
    );

    expect(html).toContain(
      "By model model-0 $0.0500 model-1 $0.0400 model-2 $0.0300 model-3 $0.0200 2 more $0.0150",
    );
    expect(html).toContain(
      "Auxiliary · $0.0024 junior · operation 2 $0.0014 junior · operation 1 $0.0004 junior · operation 4 $0.0003 2 more $0.0003",
    );
    expect(html).toContain("Full breakdown in Details");
  });

  it("shows a single extra row instead of rolling it up", () => {
    const html = text(
      renderToStaticMarkup(
        <CostMetric
          modelUsage={[0.05, 0.04, 0.03, 0.02, 0.01].map((total, index) => ({
            modelId: `openai/model-${index}`,
            usage: { cost: { total } },
          }))}
          summary={{ total: 0.15 }}
        />,
      ),
    );
    expect(html).toContain("model-4 $0.0100");
    expect(html).not.toContain("more");
    expect(html).not.toContain("Full breakdown in Details");
  });

  it("names known auxiliary operations", () => {
    const html = text(
      renderToStaticMarkup(
        <CostMetric
          auxiliaryCosts={{
            costUsd: 0.002,
            operations: [
              {
                costUsd: 0.0002,
                events: 1,
                name: "turn_routed",
                namespace: "junior",
              },
              {
                costUsd: 0.0004,
                events: 2,
                name: "memories_recalled",
                namespace: "memory",
              },
              {
                costUsd: 0.0014,
                events: 1,
                name: "guardian_action_reviewed",
                namespace: "junior",
              },
            ],
          }}
          modelUsage={[
            { modelId: "openai/gpt-5", usage: { cost: { total: 0.03 } } },
            {
              modelId: "anthropic/claude-sonnet-4",
              usage: { cost: { input: 0.001, output: 0.01 } },
            },
          ]}
          summary={{ total: 0.01 }}
        />,
      ),
    );

    // Model history wins over the stale saved cost.
    expect(html).toContain("Estimated cost $0.0430");
    expect(html).toContain(
      "Guardian $0.0014 Memory recall $0.0004 Thinking routing $0.0002",
    );
    expect(html).toContain("gpt-5 $0.0300 claude-sonnet-4 $0.0110");
  });
});

describe("TokenMetric", () => {
  it("shows one total per model, largest first", () => {
    const html = text(
      renderToStaticMarkup(
        <TokenMetric
          modelUsage={[
            {
              modelId: "openai/gpt-5-mini",
              usage: { inputTokens: 300, outputTokens: 100 },
            },
            {
              modelId: "openai/gpt-5",
              usage: { inputTokens: 1_500, outputTokens: 500 },
            },
          ]}
          summary={{
            inputTokens: 1_800,
            outputTokens: 600,
            totalTokens: 2_400,
          }}
        />,
      ),
    );
    expect(html).toContain("Tokens 2.4k");
    expect(html).toContain("By model gpt-5 2k gpt-5-mini 400");
    // Token types belong in the Details drawer.
    expect(html).not.toContain("input");
  });

  it("shows token types when no model reported usage", () => {
    const html = text(
      renderToStaticMarkup(
        <TokenMetric
          compactionCount={2}
          summary={{
            inputTokens: 1_800,
            outputTokens: 600,
            totalTokens: 2_400,
          }}
        />,
      ),
    );
    expect(html).toContain("Tokens · 2 compactions 2.4k");
    expect(html).toContain("By type input 1.8k output 600");
  });

  it("shimmers changing metrics but not the timer", () => {
    const tokenHtml = renderToStaticMarkup(
      <TokenMetric
        live
        liveModelId="xai/grok-4-5"
        modelUsage={[
          {
            modelId: "xai/grok-4-5",
            usage: { inputTokens: 1_200, outputTokens: 420 },
          },
        ]}
        summary={{ inputTokens: 1_200, outputTokens: 420, totalTokens: 1_620 }}
      />,
    );
    expect(tokenHtml).toContain("1.6k tokens");
    expect(text(tokenHtml)).toContain("grok-4-5 in progress 1.6k");
    expect(tokenHtml).toMatch(shimmerClass);

    const toolHtml = renderToStaticMarkup(
      <ToolCallsMetric
        live
        summary={{ items: [{ count: 2, name: "bash" }], total: 2 }}
      />,
    );
    expect(toolHtml).toContain("2 tool calls");
    expect(toolHtml).toMatch(shimmerClass);

    const durationHtml = renderToStaticMarkup(<DurationMetric label="31s" />);
    expect(durationHtml).toContain("31s");
    expect(durationHtml).not.toMatch(shimmerClass);
  });
});
