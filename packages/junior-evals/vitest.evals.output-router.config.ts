import { createFullRuntimeEvalConfig } from "./create-full-runtime-eval-config";

// Full conversation cases for the optional prepare path.
export default createFullRuntimeEvalConfig({
  name: "output-router",
  include: ["evals/output-router/**/*.eval.ts"],
  env: {
    // Prepare path uses the fast model on scripted assistant text.
    AI_FAST_MODEL: "openai/gpt-5.6-luna",
    JUNIOR_EVAL_OUTPUT_ROUTER: "1",
  },
});
