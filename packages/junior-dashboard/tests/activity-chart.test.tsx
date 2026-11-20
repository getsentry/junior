import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ActivityChartTooltip,
  activityBucketStartMs,
  activityChartAverage,
  activityChartAverageLabel,
  ChartAxisHtmlLabel,
  formatActivityCategoryLabel,
  formatActivityCategoryTooltipLabel,
  formatActivityDate,
  formatActivityTooltipDate,
} from "../src/client/components/charts/ActivityChart";
import {
  ChartHeader,
  chartHeaderPrimaryClassName,
} from "../src/client/components/charts/ChartHeader";
import {
  cacheInputTotal,
  formatCacheShare,
  summarizeCacheInput,
} from "../src/client/components/charts/cache-input";
import { formatActivityChartAverage } from "../src/client/format";

describe("ChartAxisHtmlLabel", () => {
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
    expect(
      html.split(`class="${chartHeaderPrimaryClassName}"`).length - 1,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("formatActivityDate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("formats day buckets as short UTC dates", () => {
    expect(formatActivityDate("2026-05-01")).toContain("May");
  });

  it("formats hour buckets in the viewer's browser timezone", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    // 15:00 UTC is 8:00 AM PDT.
    expect(formatActivityDate("2026-05-01T15")).toMatch(/8/);
    expect(formatActivityDate("2026-05-01T15")).not.toMatch(/\b3\b|\b15\b/);
  });

  it("includes the local date on hour-bucket tooltips", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(formatActivityTooltipDate("2026-05-01T15")).toMatch(/May/);
    expect(formatActivityTooltipDate("2026-05-01T15")).toMatch(/8/);
    expect(formatActivityTooltipDate("2026-05-01")).toContain("May");
  });

  it("formats day/hour category labels and leaves other labels alone", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(formatActivityCategoryLabel("2026-05-01")).toContain("May");
    expect(formatActivityCategoryLabel("2026-05-01T15")).toMatch(/8/);
    expect(formatActivityCategoryLabel("30d")).toBe("30d");
    expect(formatActivityCategoryTooltipLabel("2026-05-01T15")).toMatch(/May/);
    expect(formatActivityCategoryTooltipLabel("30d")).toBe("30d");
  });

  it("owns tooltip date formatting for activity buckets", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
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

describe("ActivityChartAverageLine", () => {
  it("averages bucket values across the plotted window", () => {
    expect(activityChartAverage([])).toBe(0);
    expect(activityChartAverage([10, 20, 30])).toBe(20);
  });

  it("labels the average with its bucket unit", () => {
    expect(activityChartAverageLabel(40, String)).toBe("40 / day");
    expect(
      activityChartAverageLabel(1.2e9, formatActivityChartAverage, "hour"),
    ).toBe("1.2b / hour");
  });

  it("hides when the average is zero", () => {
    expect(activityChartAverageLabel(0, String)).toBeUndefined();
  });

  it("hides when the formatter collapses a real mean to zero", () => {
    expect(activityChartAverageLabel(0.4, () => "0")).toBeUndefined();
    expect(activityChartAverageLabel(0.004, () => "$0.00")).toBeUndefined();
  });
});

describe("cache input summary", () => {
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

  it("uses disjoint input counters and preserves missing versus zero in cache shares", () => {
    const summary = summarizeCacheInput(days);
    expect(summary.total).toBe(2_700_000_000);
    expect(
      formatCacheShare(summary.input.cachedInputTokens, summary.total),
    ).toBe("64.8%");
    expect(
      formatCacheShare(summary.input.cacheCreationTokens, summary.total),
    ).toBe("11.1%");
    const missing = { ...days[0]!, cacheCreationTokens: undefined };
    expect(cacheInputTotal(missing)).toBeUndefined();
    expect(summarizeCacheInput([missing, days[1]!]).total).toBeUndefined();
    expect(summarizeCacheInput([missing, days[1]!]).incompletePeriods).toBe(1);
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
