import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MemoryCostChart } from "../src/client/pages/memory/MemoryCostChart";

function costDays(costUsd: number, events: number) {
  const start = Date.parse("2026-05-02T00:00:00.000Z");
  return Array.from({ length: 90 }, (_, index) => ({
    costUsd: index === 89 ? costUsd : 0,
    date: new Date(start + index * 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10),
    events: index === 89 ? events : 0,
  }));
}

describe("MemoryCostChart", () => {
  it("stacks extraction and recall cost for each day with shared tooltips", () => {
    const html = renderToStaticMarkup(
      <MemoryCostChart
        extractionDays={costDays(0.005, 1)}
        range={30}
        recallDays={costDays(0.005, 2)}
      />,
    );

    expect(html).toContain("$0.01");
    expect(html).toContain(
      'Extraction <span aria-hidden="true">·</span> $0.005',
    );
    expect(html).toContain('Recall <span aria-hidden="true">·</span> $0.005');
    expect(html).toContain(
      'aria-label="Memory extraction and recall cost during the last 30 days"',
    );
    expect(html).not.toContain('aria-label="Memory cost range"');
    expect(html).toContain(
      'aria-label="Jul 30: extraction $0.005, 1 run; recall $0.005, 2 runs"',
    );
    expect(html).toMatch(/fill="#67e8f9"[^>]+height="70"[^>]+y="94"/);
    expect(html).toMatch(/fill="#e879f9"[^>]+height="70"[^>]+y="24"/);
  });
});
