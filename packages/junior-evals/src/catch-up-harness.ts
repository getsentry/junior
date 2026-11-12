/**
 * Isolated harness for the catch-up summary that a reader asks for when they
 * come back to a Conversation.
 *
 * Calls the real `generateCatchUp` with the configured fast model. It does
 * not run the agent, the API, Postgres, or Redis.
 */
import {
  createHarness,
  type DescribeEvalOptions,
  type JsonValue,
} from "vitest-evals";
import type { BriefEntry } from "@/chat/briefs/schema";
import { generateCatchUp, type CatchUpBrief } from "@/chat/catch-up/generate";
import { botConfig } from "@/chat/config";
import { completeText } from "@/chat/core-model";

interface CatchUpEvalInput {
  /** The Brief from the reader's last visit. */
  brief?: CatchUpBrief;
  /** True when a row waits on the reader. Leave out when either is fine. */
  expectNeedsYou?: boolean;
  /** Words that the summary must not use, such as an invented outcome. */
  forbidden?: string[];
  reader: { email: string; name: string };
  rows: Array<Pick<BriefEntry, "author" | "role" | "text">>;
}

interface CatchUpEvalOutput extends Record<string, JsonValue> {
  needsYou: string | null;
  summary: string;
}

const START_MS = Date.parse("2026-08-07T11:00:00.000Z");

/** Lightweight vitest-evals harness for catch-up summary cases. */
export const catchUpHarness = createHarness<
  CatchUpEvalInput,
  CatchUpEvalOutput
>({
  name: "catch-up",
  run: async ({ input }) => {
    const catchUp = await generateCatchUp({
      ...(input.brief ? { brief: input.brief } : undefined),
      completeText,
      conversationId: "slack:CEVAL:1712345.0001",
      // The eval Conversation is not stored, so it records no cost.
      cost: { owner: "none" },
      entries: input.rows.map((row, index) => ({
        ...row,
        createdAtMs: START_MS + index * 60_000,
        index: index + 10,
      })),
      modelId: botConfig.fastModelId,
      omittedEarlierRows: false,
      reader: input.reader,
    });
    const problems: string[] = [];
    if (
      input.expectNeedsYou !== undefined &&
      input.expectNeedsYou !== Boolean(catchUp.needsYou)
    ) {
      problems.push(
        input.expectNeedsYou
          ? "missing the Needs you line"
          : `added a Needs you line: ${catchUp.needsYou}`,
      );
    }
    const sentences = catchUp.summary.split(/[.!?](?:\s|$)/).filter(Boolean);
    if (sentences.length > 3) {
      problems.push(`used ${sentences.length} sentences`);
    }
    const text = `${catchUp.summary}\n${catchUp.needsYou ?? ""}`;
    for (const word of input.forbidden ?? []) {
      if (new RegExp(`\\b${word}\\b`, "i").test(text)) {
        problems.push(`said "${word}"`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`Catch-up ${problems.join("; ")}: ${text}`);
    }
    return {
      output: { needsYou: catchUp.needsYou ?? null, summary: catchUp.summary },
      events: [
        {
          type: "message",
          role: "user",
          content: input.rows
            .map((row) => `${row.author ?? row.role}: ${row.text}`)
            .join("\n"),
        },
        { type: "message", role: "assistant", content: text },
      ],
      usage: { provider: "vercel-ai-gateway", model: botConfig.fastModelId },
    };
  },
});

/** Shared vitest-evals suite options for catch-up summary evals. */
export const catchUpEvals = {
  harness: catchUpHarness,
  // The harness checks the fixed rules; no rubric judge.
  judges: [],
  judgeThreshold: null,
} satisfies DescribeEvalOptions<
  CatchUpEvalInput,
  CatchUpEvalOutput,
  typeof catchUpHarness
>;
