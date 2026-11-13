import { describe, expect, it } from "vitest";
import { estimateSessionCostUsd } from "@/chat/sandbox/vercel/pricing";

describe("Vercel Sandbox session cost estimate", () => {
  it("matches the worked example in the Vercel pricing docs", () => {
    // "AI code validation": 2 vCPUs and 4 GB for 5 minutes at 10% CPU, so
    // 1 minute of active CPU. Vercel lists $0.0021 CPU and $0.0071 memory.
    const costUsd = estimateSessionCostUsd({
      activeCpuMs: 60_000,
      memoryMb: 4096,
      durationMs: 5 * 60_000,
      createdSandbox: false,
    });
    expect(costUsd).toBeCloseTo(0.0021333 + 0.0070667, 6);
  });

  it("bills at least one minute of memory and adds the creation once", () => {
    const resumed = estimateSessionCostUsd({
      activeCpuMs: 0,
      memoryMb: 2048,
      durationMs: 5_000,
      createdSandbox: false,
    });
    const created = estimateSessionCostUsd({
      activeCpuMs: 0,
      memoryMb: 2048,
      durationMs: 5_000,
      createdSandbox: true,
    });
    expect(resumed).toBeCloseTo((2 * 0.0212) / 60, 9);
    expect(created - resumed).toBeCloseTo(0.6 / 1_000_000, 12);
  });
});
