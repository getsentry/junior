import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ActivityChartDateLabels,
  ActivityChartGrid,
  ChartAxisHtmlLabel,
  ChartAxisLabel,
  ChartSvg,
  createActivityChartLayout,
} from "../src/client/components/charts/ActivityChart";
import { ChartHeader } from "../src/client/components/charts/ChartHeader";

describe("ChartAxisLabel", () => {
  it("defaults to the shared 12px screen-size contract", () => {
    const html = renderToStaticMarkup(
      <svg>
        <ChartAxisLabel x={0} y={0}>
          12
        </ChartAxisLabel>
      </svg>,
    );

    expect(html).toContain('font-size="12"');
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
