/**
 * Isolated turn router harness.
 *
 * Feeds realistic task inputs to the real selectTurnRoute path without running
 * the main agent, Slack transport, sandbox egress, Postgres, or Redis.
 */
import {
  createHarness,
  type DescribeEvalOptions,
  type JsonValue,
} from "vitest-evals";
import { completeObject } from "@/chat/pi/client";
import {
  DEFAULT_MODEL_PROFILES,
  type ModelProfileConfig,
} from "@/chat/model-profile";
import { botConfig } from "@/chat/config";
import type { TurnReasoningLevel } from "@/chat/reasoning-level";
import { selectTurnRoute, type TurnRoute } from "@/chat/services/turn-router";

const ROUTER_EVAL_TIMEOUT_MS = 60_000;
interface RouterEvalInput {
  conversationContext?: string;
  expectedProfile: string;
  expectedReasoningLevel: TurnReasoningLevel;
  messageText: string;
  profiles?: Readonly<Record<string, ModelProfileConfig>>;
}

interface RouterEvalOutput extends Record<string, JsonValue> {
  confidence: number | null;
  costUsd: number | null;
  expectedProfile: string;
  expectedReasoningLevel: TurnReasoningLevel;
  profile: string;
  reason: string;
  reasoningLevel: TurnReasoningLevel;
}

async function routeTask(
  input: RouterEvalInput,
  options?: { signal?: AbortSignal },
): Promise<TurnRoute> {
  const timeoutSignal = AbortSignal.timeout(ROUTER_EVAL_TIMEOUT_MS);
  const routeSignal = options?.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  return selectTurnRoute({
    completeObject: (args) => completeObject({ ...args, signal: routeSignal }),
    conversationContext: input.conversationContext,
    defaultProfile: "standard",
    fastModelId: botConfig.fastModelId,
    messageText: input.messageText,
    profiles: input.profiles ?? DEFAULT_MODEL_PROFILES,
  });
}

/** Lightweight vitest-evals harness for exact turn router cases. */
export const routerHarness = createHarness<RouterEvalInput, RouterEvalOutput>({
  name: "router",
  run: async ({ input, signal }) => {
    const route = await routeTask(input, { signal });
    if (route.confidence === undefined) {
      throw new Error(
        `Router did not return a model decision: ${route.reason}`,
      );
    }
    const output: RouterEvalOutput = {
      confidence: route.confidence ?? null,
      costUsd: route.costUsd ?? null,
      expectedProfile: input.expectedProfile,
      expectedReasoningLevel: input.expectedReasoningLevel,
      profile: route.profile,
      reason: route.reason,
      reasoningLevel: route.reasoningLevel,
    };

    if (
      route.profile !== input.expectedProfile ||
      route.reasoningLevel !== input.expectedReasoningLevel
    ) {
      throw new Error(
        `Router selected ${route.profile}/${route.reasoningLevel}: ${route.reason}; expected ${input.expectedProfile}/${input.expectedReasoningLevel}`,
      );
    }

    return {
      output,
      events: [
        {
          type: "message",
          role: "user",
          content: input.messageText,
        },
        {
          type: "message",
          role: "assistant",
          content: [
            `Profile: ${route.profile}`,
            `Reasoning level: ${route.reasoningLevel}`,
            `Reason: ${route.reason}`,
          ].join("\n"),
        },
      ],
      usage: {
        provider: "vercel-ai-gateway",
        model: botConfig.fastModelId,
        ...(route.costUsd !== undefined
          ? { metadata: { costUsd: route.costUsd } }
          : {}),
      },
    };
  },
});

/** Shared vitest-evals suite options for exact turn router evals. */
export const routerEvals = {
  harness: routerHarness,
  judges: [],
  judgeThreshold: null,
} satisfies DescribeEvalOptions<
  RouterEvalInput,
  RouterEvalOutput,
  typeof routerHarness
>;
