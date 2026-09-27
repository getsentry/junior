import { describe, expect, it } from "vitest";
import { botConfig } from "@/chat/config";
import {
  readSelfDiagnosticMetrics,
  type SelfDiagnosticCall,
} from "@/chat/self-diagnostic";

// Sparse usage arithmetic is separate from the runtime and card contract.
describe("self diagnostic sparse usage", () => {
  it("keeps missing counters unknown and includes cache writes in the denominator", () => {
    const modelId = botConfig.profiles[botConfig.defaultProfile]!.modelId;
    const call: SelfDiagnosticCall = {
      modelId,
      completedAt: "2026-09-27T00:00:00.000Z",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 600,
        cacheCreationTokens: 300,
        outputTokens: 40,
        reasoningTokens: 10,
        totalTokens: 1040,
        cost: { total: 0.01 },
      },
    };
    const read = (calls: SelfDiagnosticCall[]) =>
      readSelfDiagnosticMetrics(modelId, [], calls).usage;
    expect(read([call]).lastCall?.cachedInputSharePercent).toBe(60);
    expect(read([call]).totals?.cost?.total).toBe(0.01);

    const sparse: SelfDiagnosticCall = {
      ...call,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    };
    expect(read([call, sparse])).toMatchObject({
      completedCalls: 2,
      totals: { inputTokens: 100, cachedInputTokens: 600, outputTokens: 40 },
      lastCall: { cachedInputSharePercent: null },
    });
    expect(read([call, sparse]).totals).toEqual({
      inputTokens: 100,
      cachedInputTokens: 600,
      outputTokens: 40,
    });
    expect(
      read([{ ...sparse, usage: { ...sparse.usage, cacheCreationTokens: 0 } }])
        .lastCall?.cachedInputSharePercent,
    ).toBeNull();
    expect(read([call, { ...call, usage: null }]).totals).toBeNull();
    expect(read([])).toEqual({
      scope: "completed_main_model_calls_in_current_slice",
      completedCalls: 0,
      totals: null,
      lastCall: null,
    });
  });
});
