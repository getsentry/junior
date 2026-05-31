import { describe, expect, it } from "vitest";

import { formatTokenTotal, formatUsageTotal } from "../src/client/format";

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
});
