import { createFullRuntimeEvalConfig } from "./create-full-runtime-eval-config";

// Behavioral quality cases. Integration, Guardian, and output-router have their
// own suite configs.
export default createFullRuntimeEvalConfig({
  name: "behavioral",
  include: ["evals/**/*.eval.ts"],
  exclude: [
    "evals/guardian/**",
    "evals/integration/**",
    "evals/output-router/**",
  ],
});
