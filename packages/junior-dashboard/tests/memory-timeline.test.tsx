import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MemoryTimeline } from "../src/client/pages/memory/MemoryTimeline";

function memoryDays(privateCount: number, publicCount: number) {
  const start = Date.parse("2026-05-02T00:00:00.000Z");
  return Array.from({ length: 90 }, (_, index) => ({
    date: new Date(start + index * 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10),
    private: index === 89 ? privateCount : 0,
    public: index === 89 ? publicCount : 0,
  }));
}

describe("MemoryTimeline", () => {
  it("renders shared activity tooltips for stacked memory days", () => {
    const html = renderToStaticMarkup(
      <MemoryTimeline days={memoryDays(2, 3)} range={30} />,
    );

    expect(html).toContain(
      'aria-label="Jul 30: 2 private, 3 public, 5 total memories"',
    );
    expect(html).toContain("Activity over time");
    expect(html).toContain(
      'aria-label="Memories learned during the last 30 days"',
    );
    expect(html).not.toContain('aria-label="Memory timeline range"');
    expect(html).toContain('tabindex="0"');
  });
});
