import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Tier2Item } from "./arms";
import { assertOutsideGit } from "./events";
import { BudgetStop, modelCaller } from "./models";
import {
  distill,
  loadPoints,
  merge,
  probe,
  rebuild,
  report,
  rerunSummary,
  score,
  tier1,
  tier2,
  type StageContext,
} from "./stages";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string" },
    "max-usd": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    continue: { type: "boolean", default: false },
    model: { type: "string", default: "luna" },
    runs: { type: "string", default: "3" },
    points: { type: "string" },
    arms: { type: "string" },
  },
});

const command = positionals[0];
const data = values.data ?? process.env["COMPACTION_BENCHMARK_DATA"];
if (!command || !data) {
  console.error(
    "Usage: run.ts <all|merge|rebuild|tier1|score|tier2|distill|rerun-summary|probe|report> --data DIR [--continue] [--dry-run] [--max-usd N]",
  );
  process.exit(2);
}
assertOutsideGit(data);

/** Points that `all` reruns today's summary at, for spread. */
const RERUN_POINTS = [0, 9, 19];
const RERUN_COUNT = 3;
/** Overall cap for `all`, summed over every stage in this cache. */
const DEFAULT_ALL_MAX_USD = 30;
/** Tier 2 size assumed only to price probes before Tier 2 exists. */
const ESTIMATED_TIER2_PER_POINT = 10;

const indexes = values.points?.split(",").map(Number);
const cacheDir = join(data, "cache");
const script = "pnpm exec tsx scripts/compaction-benchmark/run.ts";

function context(dryRun: boolean, maxUsd: number) {
  const { call, ledger } = modelCaller({ cacheDir, maxUsd, dryRun });
  const ctx: StageContext = { dir: data!, call, dryRun };
  return { ctx, ledger };
}

/** Price every model stage of `all` without calling a model. */
async function estimateAll() {
  const { ctx, ledger } = context(true, 0);
  const rows: Array<[string, number, number]> = [];
  const measure = async <T>(name: string, run: () => Promise<T>) => {
    const [usd, calls] = [ledger.estimatedUsd, ledger.pendingCalls];
    const result = await run();
    rows.push([name, ledger.pendingCalls - calls, ledger.estimatedUsd - usd]);
    return result;
  };
  await measure("tier2", () => tier2(ctx));
  const distilled = await measure("distill (Luna)", () => distill(ctx));
  const reruns = await measure("rerun-summary", () =>
    rerunSummary(ctx, RERUN_COUNT, RERUN_POINTS),
  );
  const items: Tier2Item[] = existsSync(join(data!, "tier2.json"))
    ? []
    : loadPoints(data!).flatMap((point) =>
        Array.from({ length: ESTIMATED_TIER2_PER_POINT }, (_, index) => ({
          id: `estimate-${point.index}-${index}`,
          point: point.index,
          kind: "open_ask" as const,
          question:
            "Which open request from earlier work still needs an answer, and who asked for it?",
          expectedFacts: [],
          forbiddenFacts: [],
          sourceSeqs: [],
          usedAtSeqs: [],
        })),
      );
  const probeOptions: Parameters<typeof probe>[1] = {
    extraArms: { ...distilled, ...reruns },
  };
  if (items.length) probeOptions.items = items;
  await measure("probe", () => probe(ctx, probeOptions));
  console.log("\nEstimated model spend for `all` (uncached calls only):");
  for (const [name, calls, usd] of rows) {
    console.log(
      `  ${name.padEnd(16)} ${String(calls).padStart(5)} calls  $${usd.toFixed(2)}`,
    );
  }
  console.log(
    `  ${"total".padEnd(16)} ${String(ledger.pendingCalls).padStart(5)} calls  $${ledger.estimatedUsd.toFixed(2)}`,
  );
  if (items.length) {
    console.log(
      `  probe assumes ${ESTIMATED_TIER2_PER_POINT} Tier 2 items per point until tier2.json exists.`,
    );
  }
  return ledger.estimatedUsd;
}

async function all(maxUsd: number) {
  const { ctx, ledger } = context(false, maxUsd);
  const continueCommand = `${script} all --continue --data ${data} --max-usd ${maxUsd}`;
  if (!values.continue) {
    if (!merge(data!)) {
      console.error("Finish the export before running the benchmark.");
      process.exitCode = 1;
      return;
    }
    rebuild(data!);
    tier1(data!);
    score(data!);
    const estimate = await estimateAll();
    const remaining = maxUsd - ledger.spentUsd;
    if (estimate > remaining) {
      console.warn(
        `Estimate $${estimate.toFixed(2)} is above the $${remaining.toFixed(2)} left under --max-usd ${maxUsd}. Stages stop at the cap and resume from the cache.`,
      );
    }
    if (existsSync(join(data!, "tier2.json"))) {
      console.log("tier2.json exists; keeping the reviewed list.");
    } else {
      await tier2(ctx);
    }
    console.log(
      `\nReview ${join(data!, "tier2.json")}: fix or delete wrong items. Then run:\n  ${continueCommand}`,
    );
  } else {
    if (!existsSync(join(data!, "tier2.json"))) {
      throw new Error(
        "tier2.json is missing. Run `all` without --continue first.",
      );
    }
    await distill(ctx);
    await rerunSummary(ctx, RERUN_COUNT, RERUN_POINTS);
    await probe(ctx);
    report(data!);
  }
  console.log(
    `spent so far in this cache: $${ledger.spentUsd.toFixed(2)} of $${maxUsd}`,
  );
}

async function modelStage() {
  const dryRun = values["dry-run"] ?? false;
  const { ctx, ledger } = context(dryRun, Number(values["max-usd"] ?? 0));
  if (command === "tier2") await tier2(ctx, indexes);
  else if (command === "distill") await distill(ctx, values.model);
  else if (command === "rerun-summary") {
    await rerunSummary(ctx, Number(values.runs), indexes);
  } else if (command === "probe") {
    await probe(ctx, values.arms ? { arms: values.arms.split(",") } : {});
  } else throw new Error(`Unknown command ${command}`);
  console.log(
    dryRun
      ? `dry run: ${ledger.pendingCalls} uncached calls, estimated $${ledger.estimatedUsd.toFixed(2)}`
      : `spent so far in this cache: $${ledger.spentUsd.toFixed(2)}`,
  );
}

async function main() {
  if (command === "merge") {
    if (!merge(data!)) process.exitCode = 1;
  } else if (command === "rebuild") rebuild(data!);
  else if (command === "tier1") tier1(data!);
  else if (command === "score") score(data!);
  else if (command === "report") report(data!);
  else if (command === "all" && values["dry-run"]) await estimateAll();
  else if (command === "all") {
    await all(Number(values["max-usd"] ?? DEFAULT_ALL_MAX_USD));
  } else await modelStage();
}

try {
  await main();
} catch (error) {
  if (!(error instanceof BudgetStop)) throw error;
  console.error(`${error.message} Rerun the same command to resume.`);
  process.exitCode = 3;
}
