/**
 * Isolated output-router harness.
 *
 * Feeds exact assistant message text to prepareAssistantReply without running
 * the main agent, Slack transport, sandbox egress, or Postgres.
 */
import {
  createHarness,
  type DescribeEvalOptions,
  type JsonValue,
} from "vitest-evals";
import { completeObject } from "@/chat/pi/client";
import {
  prepareAssistantReply,
  type PreparedAssistantReply,
} from "@/chat/services/output-router";

const OUTPUT_ROUTER_EVAL_TIMEOUT_MS = 60_000;

export type OutputRouterExpectedKind = "silent" | "reply";

export interface OutputRouterEvalInput {
  /** Exact assistant message text to prepare. */
  text: string;
  /** Expected visible outcome. */
  expectedKind: OutputRouterExpectedKind;
  /**
   * Optional bound on visible reply length when a reply is expected.
   * Use for long-input shortening cases.
   */
  maxVisibleChars?: number;
}

export interface OutputRouterEvalOutput extends Record<string, JsonValue> {
  costUsd: number | null;
  expectedKind: OutputRouterExpectedKind;
  kind: OutputRouterExpectedKind;
  reason: string;
  text: string | null;
  textChars: number | null;
}

function resolveFastModelId(): string {
  const configured = process.env.AI_FAST_MODEL?.trim();
  if (configured) {
    return configured;
  }
  return "openai/gpt-5.6-luna";
}

/** Run one assistant message through the production output-router boundary. */
export async function prepareOutputRouterReply(
  text: string,
  options?: { signal?: AbortSignal },
): Promise<PreparedAssistantReply> {
  return prepareAssistantReply({
    completeObject: (args) =>
      completeObject({
        ...args,
        ...(options?.signal ? { signal: options.signal } : undefined),
      }),
    fastModelId: resolveFastModelId(),
    text,
  });
}

/** Lightweight vitest-evals harness for isolated output-router cases. */
export const outputRouterHarness = createHarness<
  OutputRouterEvalInput,
  OutputRouterEvalOutput
>({
  name: "output-router",
  run: async ({ input, signal }) => {
    const timeoutSignal = AbortSignal.timeout(OUTPUT_ROUTER_EVAL_TIMEOUT_MS);
    const prepareSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const prepared = await prepareOutputRouterReply(input.text, {
      signal: prepareSignal,
    });
    const kind: OutputRouterExpectedKind =
      prepared.kind === "silent" ? "silent" : "reply";
    const text = prepared.kind === "reply" ? prepared.text : null;
    const output: OutputRouterEvalOutput = {
      costUsd: prepared.costUsd ?? null,
      expectedKind: input.expectedKind,
      kind,
      reason: prepared.reason,
      text,
      textChars: text?.length ?? null,
    };

    if (kind !== input.expectedKind) {
      throw new Error(
        `Output router decided ${kind} (${prepared.reason}); expected ${input.expectedKind}`,
      );
    }
    if (
      kind === "reply" &&
      input.maxVisibleChars !== undefined &&
      (text?.length ?? 0) > input.maxVisibleChars
    ) {
      throw new Error(
        `Output router reply length ${text?.length ?? 0} exceeds maxVisibleChars ${input.maxVisibleChars}`,
      );
    }

    return {
      output,
      events: [
        {
          type: "message",
          role: "user",
          content: [
            `Expected: ${input.expectedKind}`,
            ...(input.maxVisibleChars !== undefined
              ? [`Max visible chars: ${input.maxVisibleChars}`]
              : []),
            "Assistant message:",
            input.text,
          ].join("\n"),
        },
        {
          type: "message",
          role: "assistant",
          content: [
            `Kind: ${kind}`,
            `Reason: ${prepared.reason}`,
            ...(text !== null ? [`Text: ${text}`] : ["Text: null"]),
          ].join("\n"),
        },
      ],
      usage: {
        provider: "vercel-ai-gateway",
        model: resolveFastModelId(),
        ...(prepared.costUsd !== undefined
          ? { metadata: { costUsd: prepared.costUsd } }
          : {}),
      },
    };
  },
});

/** Shared vitest-evals suite options for isolated output-router evals. */
export const outputRouterEvals = {
  harness: outputRouterHarness,
  // Exact kind match is asserted in the harness; no rubric judge.
  judges: [],
  judgeThreshold: null,
} satisfies DescribeEvalOptions<
  OutputRouterEvalInput,
  OutputRouterEvalOutput,
  typeof outputRouterHarness
>;
