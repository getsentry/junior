import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ActivityChartAverageLine,
  ActivityChartDateLabels,
  ActivityChartGrid,
  activityChartAverage,
  ChartAxisHtmlLabel,
  ChartAxisLabel,
  ChartCategoryLabels,
  ChartSvg,
  createActivityChartLayout,
} from "../src/client/components/charts/ActivityChart";
import { ChartHeader } from "../src/client/components/charts/ChartHeader";
import { SystemMetricCharts } from "../src/client/components/charts/SystemMetricCharts";

describe("ChartAxisLabel", () => {
  it("defaults to the shared 11px screen-size contract", () => {
    const html = renderToStaticMarkup(
      <svg>
        <ChartAxisLabel x={0} y={0}>
          12
        </ChartAxisLabel>
      </svg>,
    );

    expect(html).toContain('font-size="11"');
    expect(html).toContain(">12</text>");
  });

  it("renders y-axis and date labels through the shared text component", () => {
    const layout = createActivityChartLayout(200);
    const html = renderToStaticMarkup(
      <ChartSvg aria-label="fixture" layout={layout}>
        <ActivityChartGrid layout={layout} maximum={10} />
        <ActivityChartDateLabels
          dates={["2026-05-01", "2026-05-15", "2026-05-30"]}
          layout={layout}
          xPosition={(index) => layout.left + index * 100}
        />
      </ChartSvg>,
    );

    expect(html).toContain('aria-label="fixture"');
    expect(html).toContain(">10</text>");
    expect(html).toContain(">5</text>");
    expect(html).toContain(">0</text>");
    expect(html).toContain("May 1");
    expect(html).toContain("May 15");
    expect(html).toContain("May 30");
  });

  it("keeps categorical labels centered when labels repeat", () => {
    const layout = createActivityChartLayout(200);
    const html = renderToStaticMarkup(
      <ChartSvg aria-label="categories" layout={layout}>
        <ChartCategoryLabels
          categories={[
            { id: "first", label: "30d" },
            { id: "middle", label: "7d" },
            { id: "last", label: "30d" },
          ]}
          layout={layout}
          xPosition={(index) => layout.left + index * 100}
        />
      </ChartSvg>,
    );

    expect(html.match(/text-anchor="middle"/g)).toHaveLength(3);
    expect(html.match(/>30d<\/text>/g)).toHaveLength(2);
  });

  it("supports a wider left gutter and custom viewBox width", () => {
    const layout = createActivityChartLayout(200, { left: 64, width: 400 });
    expect(layout.left).toBe(64);
    expect(layout.width).toBe(400);
    expect(layout.plotWidth).toBe(400 - 64 - 18);
  });

  it("renders html axis labels for non-svg charts", () => {
    const html = renderToStaticMarkup(
      <ChartAxisHtmlLabel>Jul 10</ChartAxisHtmlLabel>,
    );
    expect(html).toContain("Jul 10");
    expect(html).toContain("<span");
  });
});

describe("ChartHeader", () => {
  it("renders the title and period total with matching shared markup", () => {
    const html = renderToStaticMarkup(
      <ChartHeader
        description="Daily cumulative runtime"
        title="Runtime"
        total="16m 12s"
      />,
    );

    expect(html).toContain("Runtime");
    expect(html).toContain("16m 12s");
    expect(html).toContain("period total");
    expect(html).toContain("Daily cumulative runtime");
    expect(html).toContain("<h3");
    // Title and total value use the same primary class string.
    const primaryClass = html.match(/class="([^"]*font-mono[^"]*)"/)?.[1];
    expect(primaryClass).toBeTruthy();
    expect(html.split(primaryClass!).length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe("ActivityChartAverageLine", () => {
  it("averages bucket values across the plotted window", () => {
    expect(activityChartAverage([])).toBe(0);
    expect(activityChartAverage([10, 20, 30])).toBe(20);
  });

  it("renders a dashed guide with a compact / day label", () => {
    const layout = createActivityChartLayout(200, { left: 64, width: 400 });
    const html = renderToStaticMarkup(
      <ChartSvg aria-label="average fixture" layout={layout}>
        <ActivityChartAverageLine
          average={40}
          format={(value) => `${value}`}
          layout={layout}
          maximum={100}
        />
      </ChartSvg>,
    );

    expect(html).toContain('aria-label="average 40 / day"');
    expect(html).toContain(">40 / day</text>");
  });

  it("hides when the average is zero", () => {
    const layout = createActivityChartLayout(200);
    const html = renderToStaticMarkup(
      <ChartSvg aria-label="empty average" layout={layout}>
        <ActivityChartAverageLine
          average={0}
          format={(value) => String(value)}
          layout={layout}
          maximum={10}
        />
      </ChartSvg>,
    );

    expect(html).not.toContain("/ day");
    expect(html).not.toContain("stroke-dasharray");
  });

  it("hides when the formatter collapses a real mean to zero", () => {
    const layout = createActivityChartLayout(200);
    const html = renderToStaticMarkup(
      <ChartSvg aria-label="floored average" layout={layout}>
        <ActivityChartAverageLine
          average={0.4}
          format={() => "0"}
          layout={layout}
          maximum={10}
        />
      </ChartSvg>,
    );

    expect(html).not.toContain("/ day");
    expect(html).not.toContain("stroke-dasharray");
  });
});

describe("SystemMetricCharts average line", () => {
  const days = [
    {
      conversations: 2,
      costUsd: 1.5,
      date: "2026-05-01",
      cachedInputTokens: 750_000_000,
      durationMs: 120_000,
      inputTokens: 250_000_000,
      tokens: 1_000_000_000,
    },
    {
      conversations: 4,
      costUsd: 2.5,
      date: "2026-05-02",
      cachedInputTokens: 1_000_000_000,
      durationMs: 180_000,
      inputTokens: 400_000_000,
      tokens: 1_400_000_000,
    },
  ];

  it("opts token usage into the shared average line", () => {
    const html = renderToStaticMarkup(<SystemMetricCharts days={days} />);

    expect(html).toContain("Token usage");
    expect(html).not.toContain("Input token cache");
    expect(html).not.toContain("Cached");
    expect(html).toContain('aria-label="average 1.2b / day"');
    expect(html).toContain(">1.2b / day</text>");
    expect(html).toContain("Model spend");
    expect(html).toContain("Runtime");
  });

  it("stacks cached and uncached input tokens only for cache breakdown", () => {
    const html = renderToStaticMarkup(
      <SystemMetricCharts cacheBreakdown days={days} />,
    );

    expect(html).toContain("Input token cache");
    expect(html).toContain("Cached");
    expect(html).toContain("Uncached");
    expect(html).toContain("input tokens");
    expect(html).toContain('aria-label="average 1.2b / day"');
    expect(html).not.toContain("Token usage");
  });
});
