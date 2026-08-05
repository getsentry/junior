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
  input: Omit<MemoryMatch, "memory" | "sourceKey"> & {
    observedAtMs?: number;
    sourceKey?: string;
  },
): MemoryMatch {
  return {
    ...input,
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

  it("prefers personal scope over newer conversation noise on score ties", () => {
    const ranked = rankMemoryMatches(
      [
        {
          lexical: { rank: 1 },
          memory: {
            content: "Recent workspace time note",
            createdAtMs: NOW_MS,
            id: "conversation-noise",
            kind: "knowledge",
            observedAtMs: NOW_MS,
            scope: "conversation",
            subjectType: "conversation",
          },
          sourceKey: "slack:T123:C456",
        },
        {
          lexical: { rank: 1 },
          memory: {
            content: "Located in San Francisco and uses Pacific Time (PT).",
            createdAtMs: NOW_MS - 120 * 24 * 60 * 60 * 1000,
            id: "personal-timezone",
            kind: "preference",
            observedAtMs: NOW_MS - 120 * 24 * 60 * 60 * 1000,
            scope: "personal",
            subjectType: "user",
          },
          sourceKey: "slack:T123:C999",
        },
      ],
      { channelPrefix: "slack:T123:C456", nowMs: NOW_MS },
    );

    expect(ranked.map(({ memory }) => memory.id)).toEqual([
      "personal-timezone",
      "conversation-noise",
    ]);
  });

  it("keeps stronger conversation relevance ahead of personal scope", () => {
    const ranked = rankMemoryMatches(
      [
        {
          lexical: { rank: 1 },
          memory: {
            content: "Release notes live in Notion.",
            createdAtMs: NOW_MS,
            id: "conversation-hit",
            kind: "knowledge",
            observedAtMs: NOW_MS,
            scope: "conversation",
            subjectType: "conversation",
          },
          sourceKey: "slack:T123:C456",
          vector: { rank: 1 },
        },
        {
          lexical: { rank: 5 },
          memory: {
            content: "Prefers terse PR summaries.",
            createdAtMs: NOW_MS,
            id: "personal-weak",
            kind: "preference",
            observedAtMs: NOW_MS,
            scope: "personal",
            subjectType: "user",
          },
          sourceKey: "slack:T123:C999",
        },
      ],
      { nowMs: NOW_MS },
    );

    expect(ranked.map(({ memory }) => memory.id)).toEqual([
      "conversation-hit",
      "personal-weak",
    ]);
  });

  it("applies optional modality weights without comparing raw scores", () => {
    const ranked = rankMemoryMatches(
      [
        match("vector-top", { vector: { rank: 1 } }),
        match("lexical-top", { lexical: { rank: 1 } }),
      ],
      {
        lexicalWeight: 1,
        nowMs: NOW_MS,
        vectorWeight: 0.85,
      },
    );

    expect(ranked.map(({ memory }) => memory.id)).toEqual([
      "lexical-top",
      "vector-top",
    ]);
  });
});
