/**
 * Isolated prepare-reply harness.
 *
 * Calls prepareAssistantReply with one assistant message. No main agent, Slack
 * transport, sandbox egress, or Postgres.
 */
import {
  createHarness,
  type DescribeEvalOptions,
  type JsonValue,
} from "vitest-evals";
import { completeObject } from "@/chat/pi/client";
import {
  OUTPUT_REPLY_SOFT_MAX_CHARS,
  prepareAssistantReply,
  type PreparedAssistantReply,
} from "@/chat/services/output-router";

export type OutputRouterEvalKind = "silent" | "reply";

export interface OutputRouterEvalInput {
  /** Original assistant message text. */
  text: string;
  /** Expected prepare kind. */
  expectedKind: OutputRouterEvalKind;
  /**
   * Optional upper bound for reply text length. Defaults to the soft max when
   * expectedKind is reply and this is omitted.
   */
  maxChars?: number;
  /**
   * Optional max ratio of original length for a reply. Use for long-input
   * condensation checks without requiring the soft max exactly.
   */
  maxOriginalRatio?: number;
  /** Substrings that must appear in a reply (case-insensitive). */
  mustInclude?: string[];
  /** Substrings that must not appear in a reply (case-insensitive). */
  mustNotInclude?: string[];
}

export interface OutputRouterEvalOutput extends Record<string, JsonValue> {
  costUsd: number | null;
  expectedKind: OutputRouterEvalKind;
  kind: OutputRouterEvalKind;
  reason: string;
  text: string | null;
  textLength: number | null;
}

function resolveFastModelId(): string {
  const configured = process.env.AI_FAST_MODEL?.trim();
  if (configured) {
    return configured;
  }
  return "openai/gpt-5.6-luna";
}

function includesInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Run one assistant message through the production prepare boundary. */
export async function prepareVisibleReply(
  text: string,
): Promise<PreparedAssistantReply> {
  return prepareAssistantReply({
    completeObject,
    fastModelId: resolveFastModelId(),
    text,
  });
}

function preparedSummary(prepared: PreparedAssistantReply): string {
  if (prepared.kind === "silent") {
    return `kind=silent reason=${JSON.stringify(prepared.reason)}`;
  }
  return `kind=reply reason=${JSON.stringify(prepared.reason)} text=${JSON.stringify(prepared.text)}`;
}

function assertPreparedReply(
  input: OutputRouterEvalInput,
  prepared: PreparedAssistantReply,
): void {
  if (prepared.kind !== input.expectedKind) {
    throw new Error(
      `output-router prepared ${prepared.kind}; expected ${input.expectedKind} (${preparedSummary(prepared)})`,
    );
  }

  if (prepared.kind === "silent") {
    return;
  }

  const maxChars = input.maxChars ?? OUTPUT_REPLY_SOFT_MAX_CHARS;
  if (prepared.text.length > maxChars) {
    throw new Error(
      `output-router reply length ${prepared.text.length} exceeds max ${maxChars} (${preparedSummary(prepared)})`,
    );
  }

  if (input.maxOriginalRatio !== undefined) {
    const maxFromOriginal = Math.floor(
      input.text.length * input.maxOriginalRatio,
    );
    if (prepared.text.length > maxFromOriginal) {
      throw new Error(
        `output-router reply length ${prepared.text.length} exceeds ${input.maxOriginalRatio} of original ${input.text.length} (${preparedSummary(prepared)})`,
      );
    }
  }

  for (const needle of input.mustInclude ?? []) {
    if (!includesInsensitive(prepared.text, needle)) {
      throw new Error(
        `output-router reply missing required text ${JSON.stringify(needle)} (${preparedSummary(prepared)})`,
      );
    }
  }

  for (const needle of input.mustNotInclude ?? []) {
    if (includesInsensitive(prepared.text, needle)) {
      throw new Error(
        `output-router reply contains forbidden text ${JSON.stringify(needle)} (${preparedSummary(prepared)})`,
      );
    }
  }
}

/** Vitest-evals harness for isolated prepare-reply cases. */
export const outputRouterHarness = createHarness<
  OutputRouterEvalInput,
  OutputRouterEvalOutput
>({
  name: "output-router",
  run: async ({ input }) => {
    const prepared = await prepareVisibleReply(input.text);
    assertPreparedReply(input, prepared);

    const output: OutputRouterEvalOutput = {
      costUsd: prepared.costUsd ?? null,
      expectedKind: input.expectedKind,
      kind: prepared.kind,
      reason: prepared.reason,
      text: prepared.kind === "reply" ? prepared.text : null,
      textLength: prepared.kind === "reply" ? prepared.text.length : null,
    };

    return {
      output,
      events: [
        {
          type: "message",
          role: "user",
          content: [
            `Expected kind: ${input.expectedKind}`,
            "",
            "Original assistant text:",
            input.text,
          ].join("\n"),
        },
        {
          type: "message",
          role: "assistant",
          content:
            prepared.kind === "silent"
              ? [`Kind: silent`, `Reason: ${prepared.reason}`].join("\n")
              : [
                  `Kind: reply`,
                  `Reason: ${prepared.reason}`,
                  `Length: ${prepared.text.length}`,
                  "",
                  prepared.text,
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

/** Shared suite options for isolated prepare-reply evals. */
export const outputRouterEvals = {
  harness: outputRouterHarness,
  // Kind, length, and required text are checked in the harness.
  judges: [],
  judgeThreshold: null,
} satisfies DescribeEvalOptions<
  OutputRouterEvalInput,
  OutputRouterEvalOutput,
  typeof outputRouterHarness
>;
