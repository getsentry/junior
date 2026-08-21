import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MemoryTimeline } from "../src/client/pages/memory/MemoryTimeline";

function memoryDays(count: number) {
  const start = Date.parse("2026-05-02T00:00:00.000Z");
  return Array.from({ length: 90 }, (_, index) => ({
    date: new Date(start + index * 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10),
    memories: index === 89 ? count : 0,
  }));
}

describe("MemoryTimeline", () => {
  it("renders activity tooltips for public memory days", () => {
    const html = renderToStaticMarkup(
      <MemoryTimeline days={memoryDays(5)} range={30} />,
    );

    expect(html).toContain('aria-label="Jul 30: 5 memories"');
    expect(html).toContain("Activity over time");
    expect(html).toContain(
      'aria-label="Memories learned during the last 30 days"',
    );
    expect(html).not.toContain('aria-label="Memory timeline range"');
    expect(html).toContain('tabindex="0"');
  });
});
