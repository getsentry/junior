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
import type { ModelProfileConfig } from "@/chat/model-profile";
import type { TurnReasoningLevel } from "@/chat/reasoning-level";
import { selectTurnRoute, type TurnRoute } from "@/chat/services/turn-router";

const ROUTER_EVAL_TIMEOUT_MS = 60_000;
const ROUTER_PROFILES = {
  standard: {
    modelId: "xai/grok-4.5",
    description:
      "Use for default assistant work: lookups, explanations, ordinary tool use, short answers, and light investigation of one source. Avoid for implementation, debugging, multi-file changes, architecture decisions, or research across several systems.",
  },
  handoff: {
    modelId: "openai/gpt-5.6-sol",
    description:
      "Use for coding and difficult multi-step work: implementation, debugging, root-cause analysis, broad refactors, multi-file changes, architecture decisions, and research across several systems. Avoid for simple lookups, short answers, single-file reads, or ordinary tool use that the default profile can finish.",
  },
} satisfies Readonly<Record<string, ModelProfileConfig>>;

interface RouterEvalInput {
  conversationContext?: string;
  expectedProfile: string;
  expectedReasoningLevel: TurnReasoningLevel;
  messageText: string;
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

function resolveRouterModelId(): string {
  return process.env.AI_FAST_MODEL?.trim() || "anthropic/claude-haiku-4.5";
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
    fastModelId: resolveRouterModelId(),
    messageText: input.messageText,
    profiles: ROUTER_PROFILES,
  });
}

/** Lightweight vitest-evals harness for exact turn router cases. */
export const routerHarness = createHarness<RouterEvalInput, RouterEvalOutput>({
  name: "router",
  run: async ({ input, signal }) => {
    const route = await routeTask(input, { signal });
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
        model: resolveRouterModelId(),
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
