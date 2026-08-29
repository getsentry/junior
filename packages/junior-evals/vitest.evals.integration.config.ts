import { createFullRuntimeEvalConfig } from "./create-full-runtime-eval-config";

// Strict system-correctness cases. Any failure fails the suite hard.
export default createFullRuntimeEvalConfig({
  name: "integration",
  include: ["evals/integration/**/*.eval.ts"],
});
