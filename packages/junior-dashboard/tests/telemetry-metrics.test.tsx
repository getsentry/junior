import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/client/components/Metric", () => ({
  MetricValue: (props: {
    children: ReactNode;
    tooltip?: Array<{ label?: string; value: string }>;
  }) => (
    <span>
      {props.children}
      {props.tooltip?.map((line) => (
        <span key={`${line.label}-${line.value}`}>
          {line.label}: {line.value}
        </span>
      ))}
    </span>
  ),
}));

import { CostMetric } from "../src/client/components/TelemetryMetrics";

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
});
