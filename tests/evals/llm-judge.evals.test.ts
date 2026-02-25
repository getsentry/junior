import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { completeObject } from "@/chat/pi/client";
import { loadBehaviorEvalSuite, runBehaviorEvalCase } from "./behavior-harness";

const judgeResultSchema = z.object({
  score: z.number().min(0).max(100),
  reasoning: z.string().min(1)
});

function buildJudgePrompt(
  testCase: unknown,
  result: {
    posts: string[];
    toolCalls: string[];
    warnings: Array<{ eventName: string }>;
    exceptions: Array<{ eventName: string }>;
    primaryThread?: { subscribed: boolean };
    slackAdapter: { titleCalls: unknown[]; promptCalls: unknown[] };
  }
): string {
  return [
    "Evaluate this harness-run assistant behavior.",
    "Score from 0 to 100 (integer/float) using this rubric:",
    "- 100: Output fully satisfies expected behavior with no material issues.",
    "- 80-99: Good output; minor misses.",
    "- 60-79: Mixed output; partially satisfies behavior.",
    "- 1-59: Fails major parts of expected behavior.",
    "- 0: Completely wrong or unsafe.",
    "",
    "Case:",
    JSON.stringify(testCase, null, 2),
    "",
    "Observed harness output:",
    JSON.stringify(
      {
        posts: result.posts,
        tool_calls: result.toolCalls,
        warnings: result.warnings.map((entry) => entry.eventName),
        exceptions: result.exceptions.map((entry) => entry.eventName),
        primary_thread_subscribed: Boolean(result.primaryThread?.subscribed),
        adapter_title_calls: result.slackAdapter.titleCalls.length,
        adapter_prompt_calls: result.slackAdapter.promptCalls.length
      },
      null,
      2
    ),
    "",
    "Return JSON only with keys:",
    '- "score" (0-100),',
    '- "reasoning" (short).'
  ].join("\n");
}

describe("LLM judged behavior evals", () => {
  it("produces per-case numeric scores", async () => {
    const judgeModel = process.env.EVAL_JUDGE_MODEL ?? process.env.AI_MODEL ?? "openai/gpt-5-mini";

    const suite = loadBehaviorEvalSuite(path.resolve(process.cwd(), "evals/cases/slack-behaviors.yaml"));
    const rows: Array<{ id: string; score: number; reasoning: string }> = [];

    for (const testCase of suite.cases) {
      const result = await runBehaviorEvalCase(testCase);
      const { object } = await completeObject({
        modelId: judgeModel,
        schema: judgeResultSchema,
        temperature: 0,
        prompt: buildJudgePrompt(testCase, result)
      });

      rows.push({
        id: testCase.id,
        score: object.score,
        reasoning: object.reasoning
      });
    }

    const average = rows.reduce((sum, row) => sum + row.score, 0) / Math.max(rows.length, 1);

    console.log("\nLLM Judge Scores");
    for (const row of rows) {
      console.log(`- ${row.id}: ${row.score.toFixed(1)} :: ${row.reasoning}`);
    }
    console.log(`Average: ${average.toFixed(1)}`);

    expect(rows.length).toBe(suite.cases.length);
  }, 120000);
});
