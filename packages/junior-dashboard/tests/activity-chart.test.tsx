import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ActivityChartTooltip,
  activityBucketStartMs,
  activityChartAverage,
  ChartAxisHtmlLabel,
  ChartFrame,
  formatActivityCategoryLabel,
  formatActivityCategoryTooltipLabel,
  formatActivityDate,
  formatActivityTooltipDate,
} from "../src/client/components/charts/ActivityChart";
import {
  ChartHeader,
  chartHeaderPrimaryClassName,
} from "../src/client/components/charts/ChartHeader";
import { SystemMetricCharts } from "../src/client/components/charts/SystemMetricCharts";
import {
  cacheInputTotal,
  formatCacheShare,
  summarizeCacheInput,
} from "../src/client/components/charts/cache-input";
import { setDashboardTimeZone } from "../src/client/format";

describe("ChartFrame", () => {
  it("renders tick and date labels as HTML text", () => {
    const html = renderToStaticMarkup(
      <ChartFrame
        aria-label="fixture"
        buckets={["2026-05-01", "2026-05-15", "2026-05-30"]}
        maximum={10}
      />,
    );

    expect(html).toContain('aria-label="fixture"');
    expect(html).toContain(">10</span>");
    expect(html).toContain(">5</span>");
    expect(html).toContain(">0</span>");
    expect(html).toContain("May 1");
    expect(html).toContain("May 15");
    expect(html).toContain("May 30");
    // Text keeps its CSS size; the SVG layer has no text to scale.
    expect(html).not.toContain("<text");
    expect(html).toContain('preserveAspectRatio="none"');
  });

  it("keeps categorical labels centered when labels repeat", () => {
    const html = renderToStaticMarkup(
      <ChartFrame
        aria-label="categories"
        buckets={["30d", "7d", "30d"]}
        labelAlign="center"
        maximum={1}
      />,
    );

    expect(html.match(/-translate-x-1\/2/g)).toHaveLength(3);
    expect(html.match(/>30d<\/span>/g)).toHaveLength(2);
  });

  it("renders html axis labels", () => {
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
    expect(
      html.split(`class="${chartHeaderPrimaryClassName}"`).length - 1,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("formatActivityDate", () => {
  it("formats day buckets as short UTC dates", () => {
    expect(formatActivityDate("2026-05-01")).toContain("May");
  });

  it("formats hour buckets in the dashboard display timezone", () => {
    setDashboardTimeZone("America/Los_Angeles");
    // 15:00 UTC is 8:00 AM PDT.
    expect(formatActivityDate("2026-05-01T15")).toMatch(/8/);
    expect(formatActivityDate("2026-05-01T15")).not.toMatch(/\b3\b|\b15\b/);
  });

  it("includes the local date on hour-bucket tooltips", () => {
    setDashboardTimeZone("America/Los_Angeles");
    expect(formatActivityTooltipDate("2026-05-01T15")).toMatch(/May/);
    expect(formatActivityTooltipDate("2026-05-01T15")).toMatch(/8/);
    expect(formatActivityTooltipDate("2026-05-01")).toContain("May");
  });

  it("formats day/hour category labels and leaves other labels alone", () => {
    setDashboardTimeZone("America/Los_Angeles");
    expect(formatActivityCategoryLabel("2026-05-01")).toContain("May");
    expect(formatActivityCategoryLabel("2026-05-01T15")).toMatch(/8/);
    expect(formatActivityCategoryLabel("30d")).toBe("30d");
    expect(formatActivityCategoryTooltipLabel("2026-05-01T15")).toMatch(/May/);
    expect(formatActivityCategoryTooltipLabel("30d")).toBe("30d");
  });

  it("owns tooltip date formatting for activity buckets", () => {
    setDashboardTimeZone("America/Los_Angeles");
    const html = renderToStaticMarkup(
      <ActivityChartTooltip
        content="details"
        date="2026-05-01T15"
        summary="3 conversations"
      >
        <g tabIndex={0} />
      </ActivityChartTooltip>,
    );
    expect(html).toContain("May");
    expect(html).toContain("3 conversations");
  });

  it("parses day and hour bucket starts in UTC", () => {
    expect(activityBucketStartMs("2026-05-01")).toBe(
      Date.parse("2026-05-01T00:00:00.000Z"),
    );
    expect(activityBucketStartMs("2026-05-01T15")).toBe(
      Date.parse("2026-05-01T15:00:00.000Z"),
    );
  });
});

describe("ChartFrame average", () => {
  it("averages bucket values across the plotted window", () => {
    expect(activityChartAverage([])).toBe(0);
    expect(activityChartAverage([10, 20, 30])).toBe(20);
  });

  it("renders a dashed guide with a compact / day label", () => {
    const html = renderToStaticMarkup(
      <ChartFrame
        aria-label="average fixture"
        average={{
          color: "#22d3ee",
          format: (value) => `${value}`,
          value: 40,
        }}
        buckets={["2026-05-01", "2026-05-02"]}
        maximum={100}
      />,
    );

    expect(html).toContain('aria-label="average 40 / day"');
    expect(html).toContain('stroke-dasharray="4 4"');
    expect(html).toContain(">40 / day</span>");
    expect(html).toContain('stroke="#22d3ee"');
  });

  it("hides when the average is zero", () => {
    const html = renderToStaticMarkup(
      <ChartFrame
        aria-label="empty average"
        average={{ format: (value) => String(value), value: 0 }}
        buckets={["2026-05-01"]}
        maximum={10}
      />,
    );

    expect(html).not.toContain("/ day");
    expect(html).not.toContain('stroke-dasharray="4 4"');
  });

  it("hides when the formatter collapses a real mean to zero", () => {
    const html = renderToStaticMarkup(
      <ChartFrame
        aria-label="floored average"
        average={{ format: () => "0", value: 0.4 }}
        buckets={["2026-05-01"]}
        maximum={10}
      />,
    );

    expect(html).not.toContain("/ day");
    expect(html).not.toContain('stroke-dasharray="4 4"');
  });
});

describe("SystemMetricCharts average line", () => {
  const days = [
    {
      conversations: 2,
      costUsd: 1.5,
      date: "2026-05-01",
      cachedInputTokens: 750_000_000,
      cacheCreationTokens: 100_000_000,
      durationMs: 120_000,
      inputTokens: 250_000_000,
      tokens: 1_000_000_000,
    },
    {
      conversations: 4,
      costUsd: 2.5,
      date: "2026-05-02",
      cachedInputTokens: 1_000_000_000,
      cacheCreationTokens: 200_000_000,
      durationMs: 180_000,
      inputTokens: 400_000_000,
      tokens: 1_400_000_000,
    },
  ];

  it("opts token usage into the shared average line", () => {
    const html = renderToStaticMarkup(<SystemMetricCharts days={days} />);

    expect(html).toContain("Token usage");
    expect(html).not.toContain("Input cache");
    expect(html).not.toContain("Cached");
    expect(html).toContain('aria-label="average 1.2b / day"');
    expect(html).toContain(">1.2b / day</span>");
    expect(html).toContain("Model spend");
    expect(html).toContain("Runtime");
  });

  it("uses disjoint input counters and preserves missing versus zero in cache shares", () => {
    const summary = summarizeCacheInput(days);
    expect(summary.total).toBe(2_700_000_000);
    expect(
      formatCacheShare(summary.input.cachedInputTokens, summary.total),
    ).toBe("64.8%");
    expect(
      formatCacheShare(summary.input.cacheCreationTokens, summary.total),
    ).toBe("11.1%");
    const missing = { ...days[0], cacheCreationTokens: undefined };
    expect(cacheInputTotal(missing)).toBeUndefined();
    expect(summarizeCacheInput([missing, days[1]]).total).toBeUndefined();
    expect(summarizeCacheInput([missing, days[1]]).incompletePeriods).toBe(1);
    const zeroWrites = { ...days[0], cacheCreationTokens: 0 };
    expect(cacheInputTotal(zeroWrites)).toBe(1_000_000_000);
    expect(formatCacheShare(0, cacheInputTotal(zeroWrites))).toBe("0.0%");
    expect(formatCacheShare(0, 0)).toBe("—");
    expect(formatCacheShare(9_999, 10_000)).toBe("<100%");
    expect(
      summarizeCacheInput([
        { date: "2026-05-03", conversations: 0, durationMs: 0 },
      ]),
    ).toMatchObject({
      activePeriods: 0,
      incompletePeriods: 0,
      total: undefined,
    });
  });
});
