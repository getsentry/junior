import { describe, expect, it } from "vitest";
import { memoriesCapturedEvent } from "../src/events";

describe("memory conversation events", () => {
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

    expect(presentation.preview).toHaveLength(500);
    expect(presentation.preview).toMatch(/\.\.\.$/);
    expect(presentation.details?.[0]?.title).toBe(content);
  });
});
