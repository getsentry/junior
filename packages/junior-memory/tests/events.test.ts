import { describe, expect, it } from "vitest";
import {
  memoriesCapturedEvent,
  memoriesCapturedEventV1,
  memoriesCapturedEventV2,
  memoriesRecalledEvent,
} from "../src/events";

describe("memory conversation events", () => {
  it("renders stored capture events with legacy scope values", () => {
    expect(
      memoriesCapturedEventV1.renderEvent({
        memories: [
          {
            content: "Use pnpm.",
            id: "memory-v1",
            kind: "preference",
            observedAtMs: 1,
            scope: "personal",
          },
        ],
      })?.details?.[0]?.metadata,
    ).toEqual(["preference", "personal"]);

    expect(
      memoriesCapturedEventV2.renderEvent({
        costUsd: 0.0042,
        memories: [
          {
            content: "Release notes live in Notion.",
            id: "memory-v2",
            kind: "knowledge",
            observedAtMs: 2,
            scope: "conversation",
          },
        ],
      })?.details?.[0]?.metadata,
    ).toEqual(["knowledge", "conversation"]);
    expect(memoriesCapturedEvent.version).toBe(3);
  });

  it("omits empty extraction results from transcript presentation", () => {
    expect(
      memoriesCapturedEvent.renderEvent({
        costUsd: 0.0042,
        memories: [],
      }),
    ).toBeUndefined();
  });

  it("keeps automatic recall outcomes out of transcript presentation", () => {
    expect(
      memoriesRecalledEvent.renderEvent({
        costUsd: 0.0042,
        memories: [],
      }),
    ).toBeUndefined();
  });

  it("uses a count-aware title and keeps the full memory in details", () => {
    const content = `Long memory ${"x".repeat(1_000)}`;

    const presentation = memoriesCapturedEvent.renderEvent({
      memories: [
        {
          content,
          id: "memory-1",
          kind: "knowledge",
          observedAtMs: 1,
          scope: "public",
        },
      ],
    });

    expect(presentation?.title).toBe("1 memory captured");
    expect(presentation?.preview).toBeUndefined();
    expect(presentation?.details?.[0]?.title).toBe(content);
  });

  it("pluralizes captured memory counts", () => {
    const presentation = memoriesCapturedEvent.renderEvent({
      memories: [
        {
          content: "Use pnpm.",
          id: "memory-1",
          kind: "preference",
          observedAtMs: 1,
          scope: "private",
        },
        {
          content: "Keep events expandable.",
          id: "memory-2",
          kind: "knowledge",
          observedAtMs: 2,
          scope: "public",
        },
      ],
    });

    expect(presentation?.title).toBe("2 memories captured");
  });
});
