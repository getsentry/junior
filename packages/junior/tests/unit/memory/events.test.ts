import { describe, expect, it } from "vitest";
import {
  memoriesCapturedEvent,
  memoriesCapturedEventV1,
  memoriesCapturedEventV2,
  memoriesRecalledEvent,
} from "@/chat/memory/events";

describe("memory conversation events", () => {
  it("renders stored capture events with legacy scope values", () => {
    const legacy = memoriesCapturedEventV1.parse({
      memories: [
        {
          content: "Use pnpm.",
          id: "memory-v1",
          kind: "preference",
          observedAtMs: 1,
          scope: "personal",
        },
      ],
    });
    expect(
      memoriesCapturedEventV1.renderEvent(legacy)?.details?.[0]?.metadata,
    ).toEqual(["preference", "private"]);

    expect(() =>
      memoriesCapturedEventV2.parse({
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
      }),
    ).toThrow(/scope/);
  });

  it("omits empty extraction results from transcript presentation", () => {
    expect(
      memoriesCapturedEventV2.renderEvent({
        costUsd: 0.0042,
        memories: [],
      }),
    ).toBeUndefined();
    expect(
      memoriesCapturedEvent.renderEvent({ archived: [], memories: [] }),
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
      archived: [],
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

    expect(presentation?.title).toBe("Captured 1 memory");
    expect(presentation?.preview).toBeUndefined();
    expect(presentation?.details?.[0]?.title).toBe(content);
  });

  it("pluralizes captured memory counts", () => {
    const presentation = memoriesCapturedEvent.renderEvent({
      archived: [],
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

    expect(presentation?.title).toBe("Captured 2 memories");
  });

  it("lists memories that the Turn retired after the captured ones", () => {
    const presentation = memoriesCapturedEvent.renderEvent({
      archived: [
        {
          content: "Uses skipOpenTelemetrySetup to skip OTel setup.",
          id: "memory-old",
          kind: "knowledge",
          observedAtMs: 1,
          reason: "contradicted",
          scope: "public",
          supersededById: "memory-new",
        },
      ],
      memories: [
        {
          content: "Uses enableOpenTelemetrySetup to control OTel setup.",
          id: "memory-new",
          kind: "knowledge",
          observedAtMs: 2,
          scope: "public",
        },
      ],
    });

    expect(presentation?.title).toBe("Captured 1 memory, archived 1");
    expect(presentation?.details?.[1]).toEqual({
      metadata: ["knowledge", "contradicted"],
      title: "Uses skipOpenTelemetrySetup to skip OTel setup.",
    });
    expect(
      memoriesCapturedEvent.renderEvent({
        archived: [
          {
            content: "Old fact.",
            id: "memory-old",
            kind: "knowledge",
            observedAtMs: 1,
            reason: "superseded",
            scope: "public",
          },
        ],
        memories: [],
      })?.title,
    ).toBe("Archived 1 memory");
  });
});
