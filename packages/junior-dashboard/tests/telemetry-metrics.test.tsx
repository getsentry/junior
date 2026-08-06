import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/client/components/Metric", () => ({
  MetricValue: (props: {
    children: ReactNode;
    tooltip?: Array<{ label?: string; value: string }>;
    tooltipColumns?: Array<Array<{ label?: string; value: string }>>;
    tooltipPlacement?: "above" | "below";
  }) => (
    <span data-tooltip-placement={props.tooltipPlacement}>
      {props.children}
      {[...(props.tooltip ?? []), ...(props.tooltipColumns?.flat() ?? [])].map(
        (line) => (
          <span key={`${line.label}-${line.value}`}>
            {line.label}: {line.value}
          </span>
        ),
      )}
    </span>
  ),
}));

import {
  CostMetric,
  DurationMetric,
  TokenMetric,
  ToolCallsMetric,
} from "../src/client/conversations/TelemetryMetrics";

describe("CostMetric", () => {
  it.each([
    {
      name: "total-only costs",
      cost: { total: 0.42 },
      expected: ["• total: $0.42"],
    },
    {
      name: "mixed total and component costs",
      cost: { total: 0.42, input: 0.1 },
      expected: ["• total: $0.42", "• input: $0.10"],
    },
  ])("shows $name", ({ cost, expected }) => {
    const html = renderToStaticMarkup(
      <CostMetric
        modelUsage={[
          {
            modelId: "openai/gpt-5",
            usage: { cost },
          },
        ]}
        summary={{ total: 0.42 }}
      />,
    );

    expect(html).toContain("gpt-5");
    for (const line of expected) expect(html).toContain(line);
  });

  it("shows the active model and provisional cost while a turn is running", () => {
    const emptyHtml = renderToStaticMarkup(
      <CostMetric pendingModelId="openai/gpt-5.6-sol" summary={undefined} />,
    );
    expect(emptyHtml).toContain("$…");
    expect(emptyHtml).toContain("gpt-5.6-sol");
    expect(emptyHtml).toContain("in progress");
    expect(emptyHtml).toContain("junior-tool-shimmer");

    const partialHtml = renderToStaticMarkup(
      <CostMetric
        pendingModelId="openai/gpt-5.6-sol"
        summary={{ total: 0.041 }}
      />,
    );
    expect(partialHtml).toContain("$0.04+");
    expect(partialHtml).toContain("junior-tool-shimmer");

    const settledHtml = renderToStaticMarkup(
      <CostMetric summary={{ total: 0.041 }} />,
    );
    expect(settledHtml).toContain("$0.04");
    expect(settledHtml).not.toContain("junior-tool-shimmer");
  });

  it("shimmers changing metrics but not the timer", () => {
    const tokenHtml = renderToStaticMarkup(
      <TokenMetric
        live
        summary={{ inputTokens: 1_200, outputTokens: 420, totalTokens: 1_620 }}
      />,
    );
    expect(tokenHtml).toContain("1.6k tokens");
    expect(tokenHtml).toContain("junior-tool-shimmer");

    const toolHtml = renderToStaticMarkup(
      <ToolCallsMetric
        live
        summary={{ items: [{ count: 2, name: "bash" }], total: 2 }}
      />,
    );
    expect(toolHtml).toContain("2 tool calls");
    expect(toolHtml).toContain("junior-tool-shimmer");

    const durationHtml = renderToStaticMarkup(<DurationMetric label="31s" />);
    expect(durationHtml).toContain("31s");
    expect(durationHtml).not.toContain("junior-tool-shimmer");
  });

  it("includes auxiliary operations in the total and tooltip", () => {
    const html = renderToStaticMarkup(
      <CostMetric
        auxiliaryCosts={{
          costUsd: 0.0018,
          operations: [
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
          {
            modelId: "openai/gpt-5",
            usage: { cost: { total: 0.041 } },
          },
        ]}
        summary={{ total: 0.041 }}
      />,
    );

    expect(html).toContain("$0.04");
    expect(html).toContain("total: $0.0428");
    expect(html).toContain("agent: $0.041");
    expect(html).toContain("Auxiliary");
    expect(html).toContain("total: $0.0018");
    expect(html).toContain("Memory recall (2): $0.0004");
    expect(html).toContain("Guardian (1): $0.0014");
    expect(html).toContain('data-tooltip-placement="above"');
  });
});
