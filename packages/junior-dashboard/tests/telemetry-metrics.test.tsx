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
  it("shows each model's total when component costs are unavailable", () => {
    const html = renderToStaticMarkup(
      <CostMetric
        modelUsage={[
          {
            modelId: "openai/gpt-5",
            usage: { cost: { total: 0.42 } },
          },
        ]}
        summary={{ total: 0.42 }}
      />,
    );

    expect(html).toContain("gpt-5");
    expect(html).toContain("• total: $0.42");
  });
});
