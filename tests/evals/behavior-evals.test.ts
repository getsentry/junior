import path from "node:path";
import { describe, it } from "vitest";
import { assertBehaviorEvalCase, loadBehaviorEvalSuite, runBehaviorEvalCase } from "./behavior-harness";

const suite = loadBehaviorEvalSuite(path.resolve(process.cwd(), "evals/cases/slack-behaviors.yaml"));

describe(`${suite.name}`, () => {
  for (const testCase of suite.cases) {
    it(`${testCase.id}: ${testCase.description}`, async () => {
      const result = await runBehaviorEvalCase(testCase);
      assertBehaviorEvalCase(testCase, result);
    });
  }
});
