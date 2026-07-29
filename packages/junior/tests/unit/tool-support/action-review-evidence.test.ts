import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { buildToolActionEvidence } from "@/chat/tool-support/action-review-evidence";

describe("tool action review evidence", () => {
  it("keeps recent visible conversation text and excludes tool results and reasoning", () => {
    const evidence = buildToolActionEvidence([
      {
        role: "user",
        content: [{ type: "text", text: "Create the weekly report." }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Hidden chain of thought." },
          { type: "text", text: "I will create that report." },
          {
            type: "toolCall",
            id: "call-1",
            name: "createReport",
            arguments: { cadence: "weekly" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-0",
        toolName: "readSecret",
        content: [{ type: "text", text: "secret-value" }],
        isError: false,
      },
    ] as PiMessage[]);

    expect(evidence).toEqual({
      entries: [{ role: "user", text: "Create the weekly report." }],
      omittedEntries: 0,
    });
    expect(JSON.stringify(evidence)).not.toContain("I will create");
    expect(JSON.stringify(evidence)).not.toContain("Hidden chain");
    expect(JSON.stringify(evidence)).not.toContain("secret-value");
  });

  it("bounds the transcript and reports omitted entries", () => {
    const evidence = buildToolActionEvidence(
      Array.from({ length: 15 }, (_, index) => ({
        role: "user",
        content: [
          {
            type: "text",
            text: index === 14 ? "latest-request" : "x".repeat(2_000),
          },
        ],
      })) as PiMessage[],
    );

    expect(evidence.entries.at(-1)?.text).toBe("latest-request");
    expect(
      evidence.entries.reduce((total, entry) => total + entry.text.length, 0),
    ).toBeLessThanOrEqual(12_000);
    expect(evidence.omittedEntries).toBeGreaterThanOrEqual(3);
  });
});
