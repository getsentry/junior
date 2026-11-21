import { describe, expect, it } from "vitest";
import {
  fuseEventRanks,
  rankKeywordCandidates,
  type KeywordCandidate,
} from "@/chat/conversations/event-search";
import {
  eventExcerpt,
  excerptTerms,
} from "@/chat/conversations/event-search-text";

describe("event search ranking", () => {
  it("ranks a rare query word above a common one", () => {
    const candidates: KeywordCandidate[] = [
      { seq: 1, length: 10, termFrequencies: { test: 3 } },
      { seq: 2, length: 10, termFrequencies: { test: 1, "4821": 1 } },
      { seq: 3, length: 10, termFrequencies: { test: 2 } },
    ];
    expect(rankKeywordCandidates(candidates, 100)[0]).toBe(2);
  });

  it("ranks an event in both lists first, and a newer event on a tie", () => {
    expect(
      fuseEventRanks([
        [1, 2],
        [3, 2],
      ]),
    ).toEqual([2, 3, 1]);
  });

  it("ranks a tool call below a result at a lower rank in the same list", () => {
    expect(fuseEventRanks([[1, 2]], new Set([1]))).toEqual([2, 1]);
    // A tool call in both lists still ranks above a result in one.
    expect(fuseEventRanks([[1, 2], [1]], new Set([1]))).toEqual([1, 2]);
  });

  it("centers the excerpt on the rarest query word", () => {
    const text = `${"step ok ".repeat(100)}step 0042 checksum deadbeef ${"step ok ".repeat(100)}`;
    const excerpt = eventExcerpt(text, excerptTerms("step 0042?"));
    expect(excerpt).toContain("step 0042 checksum deadbeef");
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerptTerms("getsentry/junior#4821")).toEqual([
      "getsentry/junior#4821",
      "getsentry",
      "junior",
      "4821",
    ]);
  });
});
