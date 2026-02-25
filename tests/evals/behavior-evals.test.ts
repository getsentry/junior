import path from "node:path";
import { describe, it } from "vitest";
import { assertBehaviorEvalCase, loadBehaviorEvalSuite, runBehaviorEvalCase } from "./behavior-harness";

const suite = loadBehaviorEvalSuite(path.resolve(process.cwd(), "evals/cases/slack-behaviors.yaml"));

describe(`${suite.name}`, () => {
  const deterministicCases = suite.cases.filter(
    (testCase) =>
      testCase.expected.sandbox_id_present === undefined &&
      testCase.expected.sandbox_ids_count === undefined &&
      testCase.expected.sandbox_ids_unique_count === undefined &&
      (testCase.expected.log_events?.length ?? 0) === 0 &&
      (testCase.expected.log_event_attributes?.length ?? 0) === 0
  );

  for (const testCase of deterministicCases) {
    it(`${testCase.id}: ${testCase.description}`, async () => {
      const result = await runBehaviorEvalCase(testCase);
      assertBehaviorEvalCase(testCase, result);
    });
  }
});
