import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Tier2Item } from "./arms";
import { assertOutsideGit } from "./events";
import { BudgetStop, MODELS, modelCaller, provider } from "./models";
import {
  BEHAVIOR_ARMS,
  behavior,
  behaviorReport,
  rules,
} from "./behavior-stage";
import { distillationChain } from "./arms";
import { TAIL_BUDGETS, sectioned, tailReport, tailRun } from "./experiments";
import { DEFAULT_BUDGETS, type LoreBudgets } from "./lore";
import {
  distill,
  lore,
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
    behavior: { type: "boolean", default: false },
    "behavior-arms": { type: "string" },
    "behavior-points": { type: "string" },
    "behavior-turns": { type: "string", default: "1" },
    provider: { type: "string" },
    "pinned-tokens": { type: "string" },
    "meta-tokens": { type: "string" },
    "lore-inject-tokens": { type: "string" },
    "hybrid-inject-tokens": { type: "string" },
  },
});

if (values.provider) {
  process.env["COMPACTION_BENCHMARK_PROVIDER"] = values.provider;
}

const command = positionals[0];
const data = values.data ?? process.env["COMPACTION_BENCHMARK_DATA"];
if (!command || !data) {
  console.error(
    "Usage: run.ts <all|experiments|tail-report|merge|rebuild|tier1|score|rules|tier2|distill|rerun-summary|lore|probe|behavior|report> --data DIR [--continue] [--arms lore,hybrid] [--behavior] [--dry-run] [--max-usd N]",
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
const newArms = values.arms?.split(",");
const behaviorArms = values["behavior-arms"]?.split(",") ?? BEHAVIOR_ARMS;
const behaviorPoints = values["behavior-points"]?.split(",").map(Number);
const turnsPerPoint = Number(values["behavior-turns"]);
const budgets: LoreBudgets = {
  pinnedTokens: Number(values["pinned-tokens"] ?? DEFAULT_BUDGETS.pinnedTokens),
  metaTokens: Number(values["meta-tokens"] ?? DEFAULT_BUDGETS.metaTokens),
  loreInjectTokens: Number(
    values["lore-inject-tokens"] ?? DEFAULT_BUDGETS.loreInjectTokens,
  ),
  hybridInjectTokens: Number(
    values["hybrid-inject-tokens"] ?? DEFAULT_BUDGETS.hybridInjectTokens,
  ),
};
const cacheDir = join(data, "cache");
const script = "pnpm exec tsx scripts/compaction-benchmark/run.ts";

function context(dryRun: boolean, maxUsd: number) {
  const { call, chat, ledger } = modelCaller({ cacheDir, maxUsd, dryRun });
  if (!dryRun) console.log(`model provider: ${provider()}`);
  const ctx: StageContext = { dir: data!, call, chat, dryRun };
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

/**
 * Price the new-arm stages: `lore` (curator and meta calls, plus any
 * distillation the cache lacks), their probes, and the behavioral track.
 */
async function estimateNew() {
  const { ctx, ledger } = context(true, 0);
  const rows: Array<[string, number, number]> = [];
  const measure = async <T>(name: string, run: () => Promise<T>) => {
    const [usd, calls] = [ledger.estimatedUsd, ledger.pendingCalls];
    const result = await run();
    rows.push([name, ledger.pendingCalls - calls, ledger.estimatedUsd - usd]);
    return result;
  };
  const built =
    newArms || values.behavior
      ? await measure("lore (curator + meta)", () => lore(ctx, budgets))
      : {};
  if (newArms) {
    await measure(`probe ${newArms.join(",")}`, () =>
      probe(ctx, { arms: newArms, extraArms: built }),
    );
  }
  if (values.behavior) {
    await measure(`behavior ${behaviorArms.join(",")}`, () =>
      behavior(ctx, {
        arms: behaviorArms,
        points: behaviorPoints,
        turnsPerPoint,
        extraArms: built,
      }),
    );
  }
  console.log("\nEstimated model spend (uncached calls only):");
  for (const [name, calls, usd] of rows) {
    console.log(
      `  ${name.padEnd(48)} ${String(calls).padStart(5)} calls  $${usd.toFixed(2)}`,
    );
  }
  console.log(
    `  ${"total".padEnd(48)} ${String(ledger.pendingCalls).padStart(5)} calls  $${ledger.estimatedUsd.toFixed(2)}`,
  );
  return ledger.estimatedUsd;
}

/** `all --arms lore,hybrid` and `all --behavior`: only the new calls. */
async function allNew(maxUsd: number) {
  if (!merge(data!)) {
    console.error("Finish the export before running the benchmark.");
    process.exitCode = 1;
    return;
  }
  tier1(data!);
  rules(data!, turnsPerPoint);
  const estimate = await estimateNew();
  const { ctx, ledger } = context(false, maxUsd);
  const remaining = maxUsd - ledger.spentUsd;
  if (estimate > remaining) {
    console.warn(
      `Estimate $${estimate.toFixed(2)} is above the $${remaining.toFixed(2)} left under --max-usd ${maxUsd} (the cap counts all earlier spend in this cache). Stages stop at the cap and resume from the cache.`,
    );
  }
  await lore(ctx, budgets);
  if (newArms) await probe(ctx, { arms: newArms });
  if (values.behavior) {
    await behavior(ctx, {
      arms: behaviorArms,
      points: behaviorPoints,
      turnsPerPoint,
    });
  }
  score(data!);
  report(data!);
  behaviorReport(data!);
  console.log(
    `spent so far in this cache: $${ledger.spentUsd.toFixed(2)} of $${maxUsd}`,
  );
}

/**
 * Experiments 1 and 2: the summary-sectioned arms at production's tail, then
 * every arm at each smaller tail, then both reports. A dry run prints the
 * estimate by stage instead.
 */
async function experiments(dryRun: boolean, maxUsd: number) {
  const { ctx, ledger } = context(dryRun, maxUsd);
  const built = await sectioned(ctx);
  const luna = await distillationChain(
    loadPoints(data!),
    MODELS.luna,
    ctx.call,
  );
  for (const budget of TAIL_BUDGETS) {
    await tailRun(ctx, budget, {
      luna,
      sectionedChain: built.chain,
      sectionedPool: built.pool,
    });
  }
  if (dryRun) {
    console.log("\nEstimated model spend (uncached calls only):");
    for (const [stage, row] of Object.entries(ledger.estimatedByStage)) {
      console.log(
        `  ${stage.padEnd(36)} ${String(row.calls).padStart(5)} calls  $${row.usd.toFixed(2)}`,
      );
    }
    console.log(
      `  ${"total".padEnd(36)} ${String(ledger.pendingCalls).padStart(5)} calls  $${ledger.estimatedUsd.toFixed(2)}`,
    );
    console.log(`ledger so far: $${ledger.spentUsd.toFixed(2)}`);
    return;
  }
  report(data!);
  const lines = tailReport(data!);
  writeFileSync(join(data!, "tails/report.md"), lines.join("\n"));
  console.log(lines.join("\n"));
  console.log(
    `spent so far in this cache: $${ledger.spentUsd.toFixed(2)} of $${maxUsd}`,
  );
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
      console.error(
        "tier2.json is missing. Run `all` without --continue first.",
      );
      process.exitCode = 1;
      return;
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
    await probe(ctx, newArms ? { arms: newArms } : {});
  } else if (command === "lore") await lore(ctx, budgets);
  else if (command === "behavior") {
    await behavior(ctx, {
      arms: behaviorArms,
      points: behaviorPoints,
      turnsPerPoint,
    });
    if (!dryRun) behaviorReport(data!);
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
  else if (command === "rules") rules(data!, turnsPerPoint);
  else if (command === "experiments") {
    await experiments(
      values["dry-run"] ?? false,
      Number(values["max-usd"] ?? DEFAULT_ALL_MAX_USD),
    );
  } else if (command === "tail-report") {
    console.log(tailReport(data!).join("\n"));
  } else if (command === "report") {
    report(data!);
    behaviorReport(data!);
  } else if (command === "all" && (newArms || values.behavior)) {
    if (values["dry-run"]) await estimateNew();
    else await allNew(Number(values["max-usd"] ?? DEFAULT_ALL_MAX_USD));
  } else if (command === "all" && values["dry-run"]) await estimateAll();
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
