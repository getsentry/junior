import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { completeObject } from "@/chat/pi/client";
import { logException, logWarn } from "@/chat/observability";
import { DEFAULT_EVAL_JUDGE_MODEL } from "./constants";
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
    const judgeModel = DEFAULT_EVAL_JUDGE_MODEL;
    const perCaseTimeoutMs = Number.parseInt(process.env.EVAL_JUDGE_TIMEOUT_MS ?? "45000", 10);
    const harnessTimeoutMs = Number.parseInt(process.env.EVAL_HARNESS_TIMEOUT_MS ?? "120000", 10);

    // Preflight once so connectivity/provider failures fail fast and do not look like case-loop hangs.
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      await completeObject({
        modelId: judgeModel,
        schema: judgeResultSchema,
        temperature: 0,
        maxTokens: 80,
        signal: controller.signal,
        prompt: 'Return JSON only: {"score":100,"reasoning":"ok"}'
      });
      clearTimeout(timeout);
    } catch (error) {
      throw new Error(
        `Judge preflight failed for model ${judgeModel}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const suite = loadBehaviorEvalSuite(path.resolve(process.cwd(), "evals/cases/slack-behaviors.yaml"));
    const rows: Array<{ id: string; score: number; reasoning: string }> = [];

    for (const testCase of suite.cases) {
      const startedAt = Date.now();
      logWarn(
        "eval_case_start",
        {},
        {
          "app.eval.case_id": testCase.id,
          "gen_ai.request.model": judgeModel
        },
        "Eval case started"
      );
      let result: Awaited<ReturnType<typeof runBehaviorEvalCase>>;
      try {
        result = await Promise.race([
          runBehaviorEvalCase(testCase),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Harness timed out for case ${testCase.id} after ${harnessTimeoutMs}ms`)),
              harnessTimeoutMs
            )
          )
        ]);
      } catch (error) {
        logException(
          error,
          "eval_case_harness_failed",
          {},
          {
            "app.eval.case_id": testCase.id,
            "app.eval.elapsed_ms": Date.now() - startedAt
          },
          "Eval case harness failed"
        );
        throw error;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), perCaseTimeoutMs);
      const requestStartedAt = Date.now();
      const heartbeat = setInterval(() => {
        logWarn(
          "eval_case_judge_pending",
          {},
          {
            "app.eval.case_id": testCase.id,
            "app.eval.elapsed_ms": Date.now() - requestStartedAt,
            "gen_ai.request.model": judgeModel
          },
          "Eval judge request pending"
        );
      }, 5000);
      let object: z.infer<typeof judgeResultSchema>;
      try {
        logWarn(
          "eval_case_judge_start",
          {},
          {
            "app.eval.case_id": testCase.id,
            "gen_ai.request.model": judgeModel
          },
          "Eval judge request started"
        );
        const response = await completeObject({
          modelId: judgeModel,
          schema: judgeResultSchema,
          temperature: 0,
          maxTokens: 300,
          signal: controller.signal,
          prompt: buildJudgePrompt(testCase, result)
        });
        object = response.object;
        logWarn(
          "eval_case_judge_end",
          {},
          {
            "app.eval.case_id": testCase.id,
            "app.eval.elapsed_ms": Date.now() - requestStartedAt,
            "gen_ai.request.model": judgeModel
          },
          "Eval judge request finished"
        );
      } catch (error) {
        logException(
          error,
          "eval_case_judge_failed",
          {},
          {
            "app.eval.case_id": testCase.id,
            "app.eval.elapsed_ms": Date.now() - requestStartedAt,
            "gen_ai.request.model": judgeModel
          },
          "Eval judge request failed"
        );
        throw new Error(
          `Judge failed for case ${testCase.id} after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        clearInterval(heartbeat);
        clearTimeout(timeout);
      }
      console.log(`[eval-case:end] ${testCase.id} (${Date.now() - startedAt}ms)`);

      rows.push({
        id: testCase.id,
        score: object.score,
        reasoning: object.reasoning
      });
      logWarn(
        "eval_case_end",
        {},
        {
          "app.eval.case_id": testCase.id,
          "app.eval.elapsed_ms": Date.now() - startedAt,
          "app.eval.score": object.score,
          "gen_ai.request.model": judgeModel
        },
        "Eval case finished"
      );
    }

    const average = rows.reduce((sum, row) => sum + row.score, 0) / Math.max(rows.length, 1);
    logWarn(
      "eval_suite_completed",
      {},
      {
        "app.eval.case_count": rows.length,
        "app.eval.average_score": average,
        "gen_ai.request.model": judgeModel
      },
      "Eval suite completed"
    );

    expect(rows.length).toBe(suite.cases.length);
  }, 360000);
});
