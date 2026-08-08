import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ActivityChartDateLabels,
  ActivityChartGrid,
  activityChartAxisFontSize,
  createActivityChartLayout,
} from "../src/client/components/charts/ActivityChart";

describe("activityChartAxisFontSize", () => {
  it("scales SVG user units with viewBox width for a stable on-screen size", () => {
    expect(activityChartAxisFontSize(960)).toBe(10);
    expect(activityChartAxisFontSize(480)).toBe(5);
    expect(activityChartAxisFontSize(400)).toBeCloseTo(4.1667, 3);
  });
});

describe("ActivityChart axis labels", () => {
  it("renders y-axis and date labels through the shared text component", () => {
    const layout = createActivityChartLayout(200);
    const html = renderToStaticMarkup(
      <svg>
        <ActivityChartGrid layout={layout} maximum={10} />
        <ActivityChartDateLabels
          dates={["2026-05-01", "2026-05-15", "2026-05-30"]}
          layout={layout}
          xPosition={(index) => layout.left + index * 100}
        />
      </svg>,
    );

    expect(html).toContain('font-size="10"');
    expect(html).toContain("font-family=\"ui-monospace, monospace\"");
    expect(html).toContain(">10</text>");
    expect(html).toContain(">5</text>");
    expect(html).toContain(">0</text>");
    expect(html).toContain("May 1");
    expect(html).toContain("May 15");
    expect(html).toContain("May 30");
  });

  it("supports a wider left gutter for currency-style charts", () => {
    const layout = createActivityChartLayout(200, { left: 64 });
    expect(layout.left).toBe(64);
    expect(layout.plotWidth).toBe(960 - 64 - 18);
  });
});
