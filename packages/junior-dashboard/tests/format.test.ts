import { describe, expect, it } from "vitest";

import {
  formatDurationTotal,
  formatTokenTotal,
  formatUsageTotal,
  turnMessageCount,
} from "../src/client/format";
import type { ConversationTurn } from "../src/client/types";

describe("dashboard token formatting", () => {
  it("sums turn usage for conversation totals", () => {
    expect(
      formatUsageTotal([
        { totalTokens: 125 },
        {
          cachedInputTokens: 25,
          cacheCreationTokens: 30,
          inputTokens: 10,
          outputTokens: 15,
          totalTokens: 999,
        },
      ]),
    ).toBe("205 tokens");
  });

  it("uses component counters for token totals when present", () => {
    expect(
      formatTokenTotal({
        cachedInputTokens: 10,
        inputTokens: 20,
        outputTokens: 30,
        totalTokens: 999,
      }),
    ).toBe("60 tokens");
  });

  it("sums turn runtime when duration data exists", () => {
    expect(formatDurationTotal([1_000, 2_500, undefined])).toBe("3.5s");
  });

  it("counts conversational transcript messages instead of tool events", () => {
    const turn = {
      id: "turn-1",
      status: "completed",
      transcriptAvailable: true,
      transcript: [
        {
          role: "user",
          parts: [{ type: "text", text: "run the search" }],
        },
        {
          role: "assistant",
          parts: [{ type: "thinking", output: "I should search first" }],
        },
        {
          role: "assistant",
          parts: [{ type: "tool_call", name: "search", input: {} }],
        },
        {
          role: "toolResult",
          parts: [{ type: "tool_result", name: "search", output: [] }],
        },
        {
          role: "assistant",
          parts: [{ type: "text", text: "done" }],
        },
      ],
    } as ConversationTurn;

    expect(turnMessageCount(turn)).toBe(2);
  });
});
