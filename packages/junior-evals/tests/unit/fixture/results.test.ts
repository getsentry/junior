import { describe, expect, it } from "vitest";
import { conversationReportEventSchema } from "@/api/schema/conversation";
import {
  readDistillationUsage,
  readModelCalls,
  readModelTotals,
  toHarnessRun,
} from "../../../src/fixture/results";

describe("model call usage", () => {
  it("keeps only new, privacy-safe call metrics and preserves missing counters", () => {
    const assistant = (seq: number, usage?: Record<string, unknown>) =>
      conversationReportEventSchema.parse({
        seq,
        createdAt: "2026-10-03T12:00:00.000Z",
        data: {
          type: "assistant_message",
          parts: [{ type: "reasoning", text: "private model content" }],
        },
        model: {
          modelId: "anthropic/claude-opus-5.5",
          modelProfile: "handoff",
        },
        modelCall: {
          provider: "anthropic",
          ...(usage ? { usage } : undefined),
        },
      });
    const calls = readModelCalls(
      [
        assistant(1, { inputTokens: 10, cachedInputTokens: 5 }),
        assistant(2, {
          inputTokens: 0,
          outputTokens: 12,
          cachedInputTokens: 90,
          cacheCreationTokens: 20,
          cost: {
            input: 0,
            cacheRead: 0.000018,
            cacheWrite: 0.0001,
            total: 0.000118,
          },
        }),
        assistant(3),
      ],
      1,
    );

    expect(calls).toEqual([
      {
        eventSeq: 2,
        modelId: "anthropic/claude-opus-5.5",
        modelProfile: "handoff",
        inputTokens: 0,
        outputTokens: 12,
        cachedInputTokens: 90,
        cacheCreationTokens: 20,
        costUsd: {
          input: 0,
          cacheRead: 0.000018,
          cacheWrite: 0.0001,
          total: 0.000118,
        },
      },
      {
        eventSeq: 3,
        modelId: "anthropic/claude-opus-5.5",
        modelProfile: "handoff",
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("private model content");
  });

  it("includes model totals when costs have no agent-history event", () => {
    expect(
      readModelTotals([
        {
          modelId: "openai/gpt-6-luna",
          usage: {
            inputTokens: 4,
            cachedInputTokens: 100,
            cacheCreationTokens: 10,
            cost: { cacheRead: 0.00002, cacheWrite: 0.0001, total: 0.00012 },
          },
        },
      ]),
    ).toEqual([
      {
        modelId: "openai/gpt-6-luna",
        inputTokens: 4,
        cachedInputTokens: 100,
        cacheCreationTokens: 10,
        costUsd: { cacheRead: 0.00002, cacheWrite: 0.0001, total: 0.00012 },
      },
    ]);
  });
});

describe("distillation usage", () => {
  it("records activation and cost from the reporting API without observations or summaries", () => {
    const events = [
      conversationReportEventSchema.parse({
        seq: 12,
        createdAt: "2026-10-03T12:00:00.000Z",
        data: {
          type: "compaction",
          summary: "private observation text",
          details: {
            reason: "distillation",
            throughSeq: 9,
            estimatedInputTokens: 180_000,
            replacementInputTokens: 20_000,
            expectedCalls: 10,
            priced: true,
          },
        },
      }),
    ];
    const usage = readDistillationUsage({
      events,
      auxiliaryCosts: {
        costUsd: 0.05,
        operations: [
          {
            namespace: "junior",
            name: "distillation",
            events: 3,
            costUsd: 0.02,
          },
        ],
      },
    });

    expect(usage).toEqual({
      historyComplete: true,
      observationCount: 3,
      observationCostUsd: 0.02,
      replacements: [
        {
          eventSeq: 12,
          reason: "distillation",
          throughSeq: 9,
          estimatedInputTokens: 180_000,
          replacementInputTokens: 20_000,
          expectedCalls: 10,
          priced: true,
        },
      ],
    });
    expect(JSON.stringify(usage)).not.toContain("private observation text");
    const report = toHarnessRun({
      conversationId: "local:example:context-cost",
      usage: {
        agentCostUsd: 0.1,
        auxiliaryCostUsd: 0.05,
        distillation: { "local:example:context-cost": usage },
        gatewayRequests: {},
        gatewayModelCalls: [],
        modelCalls: [],
        modelTotals: [],
      },
      messages: [],
      startedAtMs: Date.now(),
      toolCalls: [],
    });
    expect(report.usage?.metadata?.distillation).toEqual({
      "local:example:context-cost": usage,
    });
    expect(JSON.stringify(report.usage)).not.toContain(
      "private observation text",
    );
    expect(
      readDistillationUsage({
        events,
        previousCursor: "older-events",
      }).historyComplete,
    ).toBe(false);
  });
});
