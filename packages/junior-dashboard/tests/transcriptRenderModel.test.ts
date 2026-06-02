import { describe, expect, it } from "vitest";

import { groupTranscriptMessages } from "../src/client/components/transcriptRenderModel";
import type { TranscriptMessage } from "../src/client/types";

describe("transcript render model", () => {
  it("promotes thinking parts to standalone transcript events", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 1_000,
        parts: [
          { type: "text", text: "first" },
          { type: "thinking", output: "inspect the inputs" },
          { type: "text", text: "second" },
        ],
      },
    ] as TranscriptMessage[];

    expect(groupTranscriptMessages(messages)).toEqual([
      {
        kind: "message",
        message: {
          role: "assistant",
          timestamp: 1_000,
          parts: [{ type: "text", text: "first" }],
        },
      },
      {
        kind: "thinking",
        part: { type: "thinking", output: "inspect the inputs" },
        timestamp: 1_000,
      },
      {
        kind: "message",
        message: {
          role: "assistant",
          timestamp: 1_000,
          parts: [{ type: "text", text: "second" }],
        },
      },
    ]);
  });
});
