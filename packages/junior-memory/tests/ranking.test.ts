import { describe, expect, it } from "vitest";
import { rankMemoryMatches, type MemoryMatch } from "../src/ranking";
import type { MemoryRecord } from "../src/store";

const NOW_MS = Date.parse("2026-07-28T12:00:00.000Z");

function memory(id: string, observedAtMs = NOW_MS): MemoryRecord {
  return {
    content: `Memory ${id}`,
    createdAtMs: observedAtMs,
    id,
    kind: "knowledge",
    observedAtMs,
    scope: "conversation",
    subjectType: "conversation",
  };
}

function match(
  id: string,
  input: Omit<MemoryMatch, "exactIdentifier" | "memory" | "sourceKey"> & {
    exactIdentifier?: boolean;
    observedAtMs?: number;
    sourceKey?: string;
  },
): MemoryMatch {
  return {
    ...input,
    exactIdentifier: input.exactIdentifier ?? false,
    memory: memory(id, input.observedAtMs),
    sourceKey: input.sourceKey ?? "slack:T123:C456",
  };
}

describe("memory retrieval ranking", () => {
  it("promotes a memory supported by both retrieval methods", () => {
    const ranked = rankMemoryMatches(
      [
        match("vector-only", { vector: { distance: 0.1, rank: 1 } }),
        match("supported", { vector: { distance: 0.2, rank: 2 } }),
        match("supported", { lexical: { rank: 2 } }),
        match("lexical-only", { lexical: { rank: 1 } }),
      ],
      { nowMs: NOW_MS },
    );

    expect(ranked[0]?.memory.id).toBe("supported");
    expect(ranked.slice(1).map(({ memory }) => memory.id)).toEqual(
      expect.arrayContaining(["vector-only", "lexical-only"]),
    );
  });

  it("uses source proximity and observation age only after relevance ties", () => {
    const ranked = rankMemoryMatches(
      [
        match("other-channel-new", {
          lexical: { rank: 1 },
          sourceKey: "slack:T123:C999",
        }),
        match("same-channel-old", {
          lexical: { rank: 1 },
          observedAtMs: NOW_MS - 120 * 24 * 60 * 60 * 1000,
          sourceKey: "slack:T123:C456",
        }),
        match("same-channel-new", {
          lexical: { rank: 1 },
          sourceKey: "slack:T123:C456",
        }),
      ],
      { channelPrefix: "slack:T123:C456", nowMs: NOW_MS },
    );

    expect(ranked.map(({ memory }) => memory.id)).toEqual([
      "same-channel-new",
      "same-channel-old",
      "other-channel-new",
    ]);
  });

  it("keeps an exact identifier match in a crowded fused candidate window", () => {
    const matches = [
      match("exact", {
        exactIdentifier: true,
        lexical: { rank: 1 },
      }),
      match("exact", {
        vector: { rank: 20 },
      }),
    ];
    for (let rank = 1; rank <= 20; rank += 1) {
      matches.push(
        match(`generic-${rank}`, {
          lexical: { rank },
          vector: { rank },
        }),
      );
    }

    const ranked = rankMemoryMatches(matches, { nowMs: NOW_MS });

    expect(ranked[0]?.memory.id).toBe("exact");
    expect(
      ranked.slice(0, 20).some(({ memory }) => memory.id === "exact"),
    ).toBe(true);
  });
});
