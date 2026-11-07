import { describe, expect, it } from "vitest";

import { quickOpenMatch } from "../src/client/components/quickOpenMatch";

describe("quickOpenMatch", () => {
  it("matches scattered letters in order, with no case", () => {
    expect(quickOpenMatch("Checkout latency triage", "CLT")?.indices).toEqual([
      0, 9, 11,
    ]);
    expect(quickOpenMatch("Checkout latency triage", "gc")).toBeUndefined();
  });

  it("needs every space-separated term", () => {
    expect(
      quickOpenMatch("Checkout latency triage", "chk tri")?.indices,
    ).toEqual([0, 1, 4, 17, 18, 19]);
    expect(quickOpenMatch("Investigate checkout latency", "chk tri")).toBe(
      undefined,
    );
  });

  it("ranks a word-start run over a mid-word run over a scatter", () => {
    const score = (label: string) => quickOpenMatch(label, "deploy")!.score;
    expect(score("Deploy notes")).toBeGreaterThan(score("Redeploy notes"));
    expect(score("Redeploy notes")).toBeGreaterThan(
      score("Debug the payments loy"),
    );
  });

  it("keeps surrogate pairs whole", () => {
    expect(quickOpenMatch("Ship 🚀 now", "🚀")?.indices).toEqual([5, 6]);
  });
});
