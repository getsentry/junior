import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ActivityChartDateLabels,
  ActivityChartGrid,
  ChartAxisHtmlLabel,
  ChartAxisLabel,
  ChartSvg,
  chartAxisLabelClassName,
  createActivityChartLayout,
} from "../src/client/components/charts/ActivityChart";
import {
  ChartHeader,
  chartHeaderPrimaryClassName,
  chartHeaderSecondaryClassName,
} from "../src/client/components/charts/ChartHeader";

describe("ChartAxisLabel", () => {
  it("uses shared CSS class so labels stay screen-pixel sized across viewBoxes", () => {
    const html = renderToStaticMarkup(
      <svg>
        <ChartAxisLabel x={0} y={0}>
          12
        </ChartAxisLabel>
      </svg>,
    );

    expect(chartAxisLabelClassName).toContain("text-2xs");
    expect(html).toContain(chartAxisLabelClassName);
    expect(html).not.toContain("font-size=");
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

    expect(html).toContain(chartAxisLabelClassName);
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

  it("shares the html axis label class with svg labels", () => {
    const html = renderToStaticMarkup(
      <ChartAxisHtmlLabel>Jul 10</ChartAxisHtmlLabel>,
    );
    expect(html).toContain("text-2xs");
    expect(html).toContain("Jul 10");
  });
});

describe("ChartHeader", () => {
  it("uses the same primary class for title and period total value", () => {
    const html = renderToStaticMarkup(
      <ChartHeader
        description="Daily cumulative runtime"
        title="Runtime"
        total="16m 12s"
      />,
    );

    expect(html).toContain(chartHeaderPrimaryClassName);
    expect(html).toContain(chartHeaderSecondaryClassName);
    expect(html).toContain("Runtime");
    expect(html).toContain("16m 12s");
    expect(html).toContain("period total");
    expect(html).toContain("Daily cumulative runtime");

    const primaryMatches = html.match(
      new RegExp(chartHeaderPrimaryClassName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    );
    // title + total value
    expect(primaryMatches?.length).toBe(2);
  });
});
