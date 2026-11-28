// Temporary fair baseline: runs the Guardian evals 3 times fully live and
// stops before the next sample once this arm's spend passes the cap.
// Removed with the workflow change that runs it.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const SAMPLES = 3;
const CAP_USD = 12;
// openai/gpt-6-luna, from packages/junior/src/chat/pi/gateway-models.ts.
const INPUT_USD = 0.1e-6;
const OUTPUT_USD = 0.5e-6;

const packageRoot = path.resolve(import.meta.dirname, "..");
const usageFile = process.env.BASELINE_USAGE_FILE;
if (!usageFile) throw new Error("BASELINE_USAGE_FILE is required.");

function spentUsd() {
  if (!existsSync(usageFile)) return 0;
  let usd = 0;
  for (const line of readFileSync(usageFile, "utf8").split("\n")) {
    if (!line) continue;
    const { cost, usage = {} } = JSON.parse(line);
    if (cost !== undefined) {
      usd += Number(cost);
      continue;
    }
    const input = usage.inputTokens?.total ?? usage.prompt_tokens ?? 0;
    const output = usage.outputTokens?.total ?? usage.completion_tokens ?? 0;
    usd += input * INPUT_USD + output * OUTPUT_USD;
  }
  return usd;
}

for (let sample = 1; sample <= SAMPLES; sample += 1) {
  // A failing case is a result, not an error, so the exit code is ignored.
  spawnSync("pnpm", ["--filter", "@sentry/junior-evals", "evals:guardian"], {
    env: {
      ...process.env,
      VITEST_EVALS_OUTPUT_FILE: `guardian-results-${sample}.json`,
    },
    stdio: "inherit",
  });
  const spent = spentUsd();
  console.log(`Spend after sample ${sample}: $${spent.toFixed(2)}`);
  if (spent > CAP_USD) {
    console.log(
      `::warning::Stopped after sample ${sample}: spend passed $${CAP_USD}.`,
    );
    break;
  }
}

copyFileSync(
  path.join(packageRoot, "guardian-results-1.json"),
  path.join(packageRoot, "guardian-results.json"),
);
