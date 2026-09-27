import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { usageSchema } from "@/usage-schema";
import { resolveGatewayModel } from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getAgentContextCompactionTriggerTokens,
  getAgentContextInputLimitTokens,
} from "@/chat/services/context-budget";
import { hasAgentTurnUsage } from "@/chat/usage";
import { extractGenAiUsageSummary } from "@/chat/logging";
import { modelProfileSchema } from "@/chat/model-profile";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";

const modelConfigurationSchema = z.strictObject({
  modelProfile: modelProfileSchema,
  modelId: z.string().min(1),
  reasoningLevel: z.enum(TURN_REASONING_LEVELS),
});

const completedCallSchema = z.strictObject({
  modelId: z.string(),
  completedAt: z.iso.datetime(),
  usage: usageSchema.nullable(),
});

export type SelfDiagnosticCall = z.output<typeof completedCallSchema>;

const metricsSchema = z.strictObject({
  context: z.strictObject({
    scope: z.literal("active_history"),
    source: z.literal("runtime_estimate"),
    estimatedTokens: z.number().nonnegative(),
    modelWindowTokens: z.number().positive().nullable(),
    inputLimitTokens: z.number().positive(),
    inputUtilizationPercent: z.number().nonnegative(),
    remainingInputTokens: z.number().nonnegative(),
    compactionTriggerTokens: z.number().positive(),
    aboveCompactionThreshold: z.boolean(),
  }),
  usage: z.strictObject({
    scope: z.literal("completed_main_model_calls_in_current_slice"),
    completedCalls: z.number().int().nonnegative(),
    totals: usageSchema.nullable(),
    lastCall: completedCallSchema
      .extend({
        cachedInputSharePercent: z.number().min(0).max(100).nullable(),
      })
      .nullable(),
  }),
});

/** Allowlisted live execution facts. Never expose credentials or raw config. */
export const selfDiagnosticSchema = metricsSchema.extend({
  conversationId: z.string().min(1),
  turnId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  supportsImageInput: z.boolean(),
  active: modelConfigurationSchema,
  defaultProfile: modelProfileSchema,
  profiles: z.array(
    modelConfigurationSchema.extend({
      configuredReasoningLevel: z.enum(TURN_REASONING_LEVELS).nullable(),
      handoffAvailable: z.boolean(),
    }),
  ),
});

export type SelfDiagnostic = z.output<typeof selfDiagnosticSchema>;

/** Read capacity and completed-call counters without exposing history content. */
export function readSelfDiagnosticMetrics(
  modelId: string,
  messages: PiMessage[],
  calls: SelfDiagnosticCall[],
): z.output<typeof metricsSchema> {
  // Use the same estimate and limits as compaction. This is not an exact count
  // of the next request, which can add tool results and request overhead.
  const estimatedTokens = estimateContextTokens(messages).tokens;
  const modelWindow = resolveGatewayModel(modelId).contextWindow;
  const inputLimitTokens = getAgentContextInputLimitTokens(modelId);
  const compactionTriggerTokens =
    getAgentContextCompactionTriggerTokens(modelId);
  const lastCall = calls.at(-1);
  const lastUsage = lastCall?.usage;
  const input = lastUsage?.inputTokens;
  const cached = lastUsage?.cachedInputTokens;
  const written = lastUsage?.cacheCreationTokens;
  const promptTokens =
    input !== undefined && cached !== undefined && written !== undefined
      ? input + cached + written
      : null;
  const totals = extractGenAiUsageSummary(...calls.map((call) => call.usage));
  // A missing counter on any call makes that total unknown, not a partial sum.
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheCreationTokens",
    "reasoningTokens",
    "totalTokens",
  ] as const) {
    if (calls.some((call) => call.usage?.[field] === undefined))
      delete totals[field];
  }
  if (totals.cost) {
    for (const field of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
    ] as const) {
      if (calls.some((call) => call.usage?.cost?.[field] === undefined))
        delete totals.cost[field];
    }
    if (Object.keys(totals.cost).length === 0) delete totals.cost;
  }
  return {
    context: {
      scope: "active_history",
      source: "runtime_estimate",
      estimatedTokens,
      modelWindowTokens:
        Number.isFinite(modelWindow) && modelWindow > 0 ? modelWindow : null,
      inputLimitTokens,
      inputUtilizationPercent: (estimatedTokens / inputLimitTokens) * 100,
      remainingInputTokens: Math.max(0, inputLimitTokens - estimatedTokens),
      compactionTriggerTokens,
      aboveCompactionThreshold: estimatedTokens > compactionTriggerTokens,
    },
    usage: {
      scope: "completed_main_model_calls_in_current_slice",
      completedCalls: calls.length,
      totals: hasAgentTurnUsage(totals) ? totals : null,
      lastCall: lastCall
        ? {
            ...lastCall,
            cachedInputSharePercent:
              promptTokens !== null && promptTokens > 0
                ? (cached! / promptTokens) * 100
                : null,
          }
        : null,
    },
  };
}
