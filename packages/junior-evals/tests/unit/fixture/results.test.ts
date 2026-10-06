import { describe, expect, it } from "vitest";
import { conversationReportEventSchema } from "@/api/schema/conversation";
import {
  logInfo,
  registerLogRecordSink,
  type EmittedLogRecord,
} from "@/chat/logging";
import {
  readAuxiliaryOperations,
  readDistillationDecision,
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
  it("copies only numeric skip reasons from log records", () => {
    const decision = readDistillationDecision({
      eventName: "conversation.distillation.skipped",
      level: "info",
      body: "private observation text",
      attributes: {
        "gen_ai.conversation.id": "local:example:context-cost",
        "app.distillation.stage": "observer",
        "app.distillation.reason": "not_economical",
        "app.distillation.raw_tokens": 180_000,
        "app.distillation.expected_calls": 2,
        "app.distillation.savings_ratio": -4.5,
        "gen_ai.prompt": "private observation text",
      },
    } satisfies EmittedLogRecord);
    expect(decision).toEqual({
      conversationId: "local:example:context-cost",
      stage: "observer",
      reason: "not_economical",
      rawTokens: 180_000,
      expectedCalls: 2,
      savingsRatio: -4.5,
    });
    expect(JSON.stringify(decision)).not.toContain("private observation text");
    expect(
      readDistillationDecision({
        eventName: "conversation.distillation.skipped",
        level: "info",
        body: "",
        attributes: {
          "gen_ai.conversation.id": "local:example:context-cost",
          "app.distillation.stage": "observer",
          "app.distillation.reason": "private observation text",
        },
      }),
    ).toBeUndefined();
    const captured: EmittedLogRecord[] = [];
    const unregister = registerLogRecordSink((record) => {
      if (record.eventName === "conversation.distillation.skipped") {
        captured.push(record);
      }
    });
    try {
      logInfo("conversation.distillation.skipped", {
        "gen_ai.conversation.id": "local:example:context-cost",
        "app.distillation.stage": "observer",
        "app.distillation.reason": "not_economical",
        "app.distillation.expected_calls": 2,
      });
    } finally {
      unregister();
    }
    expect(captured.map(readDistillationDecision)).toEqual([
      {
        conversationId: "local:example:context-cost",
        stage: "observer",
        reason: "not_economical",
        expectedCalls: 2,
      },
    ]);
  });

  it("records activation and cost from the reporting API without observations or summaries", () => {
    const events = [
      conversationReportEventSchema.parse({
        seq: 10,
        createdAt: "2026-10-03T12:00:00.000Z",
        data: {
          type: "compaction",
          summary: "private capacity summary",
          details: {
            reason: "capacity",
            estimatedInputTokens: 360_000,
            triggerTokens: 360_000,
            inputLimitTokens: 380_000,
            inputMessageCount: 10,
            retainedMessageCount: 3,
            summaryChars: 100,
          },
        },
      }),
      conversationReportEventSchema.parse({
        seq: 11,
        createdAt: "2026-10-03T12:00:00.000Z",
        data: { type: "compaction", summary: "private older summary" },
      }),
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
        costUsd: 0.053,
        operations: [
          {
            namespace: "junior",
            name: "distillation",
            events: 3,
            costUsd: 0.02,
          },
          {
            namespace: "junior",
            name: "distillation_batch_done",
            events: 1,
            costUsd: 0.003,
            estimatedCostUsd: 0.003,
          },
        ],
      },
    });

    expect(usage).toEqual({
      historyComplete: true,
      capacityCompactionCount: 1,
      unclassifiedCompactionCount: 1,
      observationCount: 3,
      observationCostUsd: 0.023,
      observationEstimatedCostUsd: 0.003,
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
    expect(JSON.stringify(usage)).not.toContain("private capacity summary");
    expect(JSON.stringify(usage)).not.toContain("private older summary");
    const operations = readAuxiliaryOperations({
      auxiliaryCosts: {
        costUsd: 0.053,
        operations: [
          {
            namespace: "junior",
            name: "distillation",
            events: 3,
            costUsd: 0.02,
          },
          {
            namespace: "junior",
            name: "distillation_batch_done",
            events: 1,
            costUsd: 0.003,
            estimatedCostUsd: 0.003,
          },
          {
            namespace: "junior",
            name: "turn_routed",
            events: 1,
            costUsd: 0.01,
          },
          {
            namespace: "private plugin",
            name: "private prompt",
            events: 2,
            costUsd: 0.02,
          },
        ],
      },
    });
    expect(operations).toEqual([
      {
        kind: "distillation",
        events: 4,
        costUsd: 0.023,
        estimatedCostUsd: 0.003,
      },
      { kind: "turn_routed", events: 1, costUsd: 0.01 },
      { kind: "other", events: 2, costUsd: 0.02 },
    ]);
    expect(JSON.stringify(operations)).not.toContain("private prompt");
    const report = toHarnessRun({
      conversationId: "local:example:context-cost",
      earlier: [],
      usage: {
        agentCostUsd: 0.1,
        auxiliaryCostUsd: 0.053,
        auxiliaryOperations: operations,
        distillation: { "local:example:context-cost": usage },
        distillationDecisions: {},
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
    expect(report.usage?.metadata?.auxiliaryOperations).toEqual(operations);
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
