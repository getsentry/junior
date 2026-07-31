import { describe, expect, it } from "vitest";
import { memoriesCapturedEvent, memoriesRecalledEvent } from "../src/events";

describe("memory conversation events", () => {
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

  it("bounds a single-memory preview to the presentation contract", () => {
    const content = `Long memory ${"x".repeat(1_000)}`;

    const presentation = memoriesCapturedEvent.renderEvent({
      memories: [
        {
          content,
          id: "memory-1",
          kind: "knowledge",
          observedAtMs: 1,
          scope: "conversation",
        },
      ],
    });

    expect(presentation?.preview).toHaveLength(500);
    expect(presentation?.preview).toMatch(/\.\.\.$/);
    expect(presentation?.details?.[0]?.title).toBe(content);
  });
});
