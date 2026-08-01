import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/client/components/Metric", () => ({
  MetricValue: (props: {
    children: ReactNode;
    tooltip?: Array<{ label?: string; value: string }>;
    tooltipColumns?: Array<Array<{ label?: string; value: string }>>;
  }) => (
    <span>
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

import { CostMetric } from "../src/client/conversations/TelemetryMetrics";

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
  });
});
