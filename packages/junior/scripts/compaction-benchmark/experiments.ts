import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUMMARY_INSTRUCTION } from "@/chat/agent/context-summary";
import { estimateTextTokens } from "@/chat/services/token-estimate";
import {
  distillationChain,
  freeArms,
  type ArmContext,
  type Tier2Item,
} from "./arms";
import { renderMessages, type CompactionPoint } from "./history";
import {
  buildLorePool,
  loreArms,
  DEFAULT_BUDGETS,
  type LorePoolPoint,
} from "./lore";
import { MODELS, mapLimit } from "./models";
import { worthIt, type ProbeResult } from "./report";
import {
  loadData,
  probe,
  recallCells,
  totalCost,
  type StageContext,
} from "./stages";
import { mineTier1 } from "./tier1";

/** Experiment 1 tail sizes, in estimated tokens. Production keeps its own. */
export const TAIL_BUDGETS = [32_000, 64_000];
/** Points where a new Opus summary over the removed history runs. */
export const SUMMARY_POINTS = [0, 4, 9, 14, 19];
/** Rerun spread of the main run (Tier 2, points 0, 9 and 19). */
const RERUN_SPREAD = 0.021;

const SECTIONED_DISTILL = "distill-gpt-6-luna-sectioned";
const LUNA_DISTILL = "distill-gpt-6-luna";

function tokens(messages: readonly { tokens: number }[]) {
  return messages.reduce((sum, message) => sum + message.tokens, 0);
}

/**
 * Keep only the newest `budget` tokens of a point's tail; the rest joins
 * the removed history. A kept tail does not start on a tool result, whose
 * call would be gone. A tail already under budget stays as it was.
 */
export function shrinkPoint(
  point: CompactionPoint,
  budget: number,
): CompactionPoint {
  let start = point.tail.length;
  let kept = 0;
  while (start > 0 && kept + point.tail[start - 1]!.tokens <= budget) {
    start -= 1;
    kept += point.tail[start]!.tokens;
  }
  while (
    start < point.tail.length &&
    point.tail[start]!.role === "toolResult"
  ) {
    start += 1;
  }
  return {
    ...point,
    dropped: [...point.dropped, ...point.tail.slice(0, start)],
    tail: point.tail.slice(start),
  };
}

/**
 * Today's `SUMMARY_INSTRUCTION` on the earlier summary plus the removed
 * history alone, as the parent asked. Production's summary sees the kept
 * tail too, so `recorded` stays the production-faithful baseline.
 */
async function summaryOfRemoved(
  point: CompactionPoint,
  label: string,
  call: StageContext["call"],
): Promise<ArmContext> {
  const history = [
    point.previousSummary ? `Earlier summary:\n${point.previousSummary}` : "",
    renderMessages(
      point.dropped.filter((message) => message.seq <= point.markSeq),
    ),
  ].join("\n\n");
  const result = await call({
    stage: `summary-removed-${label}`,
    modelId: MODELS.opus,
    system: "You are Junior. Summarize the conversation history below.",
    user: `<history>\n${history}\n</history>\n\n${SUMMARY_INSTRUCTION}`,
    maxTokens: 8_000,
    expectedOutputTokens: 2_000,
  });
  const summary =
    /<summary>([\s\S]*?)<\/summary>/.exec(result.text)?.[1]?.trim() ??
    result.text;
  return {
    point: point.index,
    context: summary,
    tokens: estimateTextTokens(summary),
    workerCostUsd: result.costUsd,
    tailTokens: tokens(point.tail),
  };
}

/** Experiment 2 at production's tail: the sectioned chain and the sectioned Lore pool. */
export async function sectionedArms(ctx: StageContext) {
  const { points, turns } = loadData(ctx.dir);
  const chain = await distillationChain(
    points,
    MODELS.luna,
    ctx.call,
    "sectioned",
  );
  const pool = await buildLorePool({
    points,
    observations: new Map(
      chain.map((entry) => [entry.point, entry.observations ?? []]),
    ),
    budgets: DEFAULT_BUDGETS,
    call: ctx.call,
    variant: "sectioned",
  });
  const built = loreArms({
    points,
    pool,
    turns,
    recorded: freeArms(points).recorded,
    distillUsd: new Map(
      chain.map((entry) => [entry.point, entry.workerCostUsd]),
    ),
    budgets: DEFAULT_BUDGETS,
    dryRun: ctx.dryRun,
  });
  return {
    chain,
    pool,
    arms: { [SECTIONED_DISTILL]: chain, "lore-sectioned": built.lore },
  };
}

/** Write the experiment 2 arms at production's tail, then probe them. */
export async function sectioned(ctx: StageContext) {
  const { chain, pool, arms } = await sectionedArms(ctx);
  if (!ctx.dryRun) {
    mkdirSync(join(ctx.dir, "lore"), { recursive: true });
    writeFileSync(
      join(ctx.dir, "lore/pool-sectioned.json"),
      JSON.stringify(pool),
    );
    for (const [name, arm] of Object.entries(arms)) {
      writeFileSync(join(ctx.dir, `arms/${name}.json`), JSON.stringify(arm));
    }
  }
  await probe(ctx, { arms: Object.keys(arms), extraArms: arms });
  return { chain, pool, arms };
}

/**
 * Tier 2 items whose source is in the removed history at this tail. The
 * miner read only production's removed history, which a smaller tail only
 * grows, so an item without cited seqs qualifies. An item that cites seqs
 * qualifies only when every cited seq is before the kept tail.
 */
function itemsAtTail(
  items: readonly Tier2Item[],
  shrunk: readonly CompactionPoint[],
) {
  return items.filter((item) => {
    const point = shrunk[item.point]!;
    const cut = point.tail[0]?.seq ?? point.seq;
    return item.sourceSeqs.every((seq) => seq < cut);
  });
}

function label(budget: number) {
  return `${budget / 1000}k`;
}

/**
 * Experiment 1 and experiment 2 at one smaller tail. Each point keeps
 * production's state from before it, then compacts once with the smaller
 * tail: the chains and the sectioned pool continue from the previous point's
 * state and distill the larger removed history. Probes go to
 * `tails/probes-<size>.json`.
 */
export async function tailRun(
  ctx: StageContext,
  budget: number,
  /** Production-tail chains and pool, from `sectioned`, so they run once. */
  base: {
    luna: ArmContext[];
    sectionedChain: ArmContext[];
    sectionedPool: LorePoolPoint[];
  },
) {
  const { events, points, turns } = loadData(ctx.dir);
  const shrunk = points.map((point) => shrinkPoint(point, budget));
  const name = label(budget);
  const recorded = freeArms(points).recorded;
  const { luna, sectionedChain, sectionedPool } = base;

  const arms: Record<string, ArmContext[]> = {
    empty: [],
    recorded: [],
    [LUNA_DISTILL]: [],
    [SECTIONED_DISTILL]: [],
    "lore-sectioned": [],
  };
  await mapLimit(shrunk, 4, async (point) => {
    const p = point.index;
    const tailTokens = tokens(point.tail);
    arms["empty"]![p] = {
      point: p,
      context: "",
      tokens: 0,
      workerCostUsd: 0,
      tailTokens,
    };
    arms["recorded"]![p] = { ...recorded[p]!, tailTokens };
    const [plain] = await distillationChain(
      [point],
      MODELS.luna,
      ctx.call,
      undefined,
      luna[p - 1]?.chain,
    );
    arms[LUNA_DISTILL]![p] = { ...plain!, tailTokens };
    const [sectionedEntry] = await distillationChain(
      [point],
      MODELS.luna,
      ctx.call,
      "sectioned",
      sectionedChain[p - 1]?.chain,
    );
    arms[SECTIONED_DISTILL]![p] = { ...sectionedEntry!, tailTokens };
    const poolArgs: Parameters<typeof buildLorePool>[0] = {
      points: [point],
      observations: new Map([[p, sectionedEntry!.observations ?? []]]),
      budgets: DEFAULT_BUDGETS,
      call: ctx.call,
      variant: "sectioned",
    };
    const initial = sectionedPool[p - 1];
    if (initial) poolArgs.initial = initial;
    const [poolPoint] = await buildLorePool(poolArgs);
    const positioned = [...points];
    positioned[p] = point;
    const built = loreArms({
      points: positioned,
      pool: [poolPoint!],
      turns,
      recorded,
      distillUsd: new Map([[p, sectionedEntry!.workerCostUsd]]),
      budgets: DEFAULT_BUDGETS,
      dryRun: ctx.dryRun,
    });
    arms["lore-sectioned"]![p] = { ...built.lore[0]!, tailTokens };
  });
  arms["summary-removed"] = await mapLimit(
    shrunk.filter((point) => SUMMARY_POINTS.includes(point.index)),
    2,
    (point) => summaryOfRemoved(point, name, ctx.call),
  );

  const facts = mineTier1(events, shrunk);
  const items = itemsAtTail(
    JSON.parse(
      readFileSync(join(ctx.dir, "tier2.json"), "utf8"),
    ) as Tier2Item[],
    shrunk,
  );
  console.log(
    `tail ${name}: tier1 facts ${facts.length}, tier2 items ${items.length}`,
  );
  if (!ctx.dryRun) {
    mkdirSync(join(ctx.dir, "tails"), { recursive: true });
    writeFileSync(
      join(ctx.dir, `tails/arms-${name}.json`),
      JSON.stringify(arms),
    );
    writeFileSync(
      join(ctx.dir, `tails/tier1-${name}.json`),
      JSON.stringify(facts),
    );
  }
  await probe(ctx, {
    arms: Object.keys(arms),
    extraArms: arms,
    facts,
    items,
    points: shrunk,
    output: `tails/probes-${name}.json`,
  });
}

/**
 * Experiment 1 report: recall, pass rate and the `empty` floor per tail,
 * and total modeled cost against today's setup (production tail plus the
 * recorded summary). Verdicts compare each distillation arm with today's
 * summary at the same tail, on total cost.
 */
export function tailReport(dir: string): string[] {
  const { points } = loadData(dir);
  const recorded = freeArms(points).recorded;
  const lines: string[] = [];
  for (const budget of TAIL_BUDGETS) {
    const name = label(budget);
    const armsPath = join(dir, `tails/arms-${name}.json`);
    const probesPath = join(dir, `tails/probes-${name}.json`);
    if (!existsSync(armsPath) || !existsSync(probesPath)) continue;
    const arms = JSON.parse(readFileSync(armsPath, "utf8")) as Record<
      string,
      ArmContext[]
    >;
    const results = JSON.parse(
      readFileSync(probesPath, "utf8"),
    ) as ProbeResult[];
    const subset = new Set(SUMMARY_POINTS);
    lines.push(
      "",
      `### Tail ${name}`,
      "",
      "| arm | raw | points | T1 | T1 age 1 | T1 age 2-4 | T1 age 5+ | T2 | T2 leaks | ctx tok | tail tok | total $ | Δ vs today $ |",
      "|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|",
    );
    for (const [scope, only] of [
      ["all", undefined],
      ["subset", subset],
    ] as const) {
      for (const [arm, entries] of Object.entries(arms)) {
        const scoped = entries.filter(
          (entry) => entry && (!only || only.has(entry.point)),
        );
        if (!scoped.length || (scope === "all" && arm === "summary-removed"))
          continue;
        const cost = totalCost(points, scoped, recorded);
        const meanCtx =
          scoped.reduce((sum, entry) => sum + entry.tokens, 0) / scoped.length;
        const meanTail =
          scoped.reduce((sum, entry) => sum + (entry.tailTokens ?? 0), 0) /
          scoped.length;
        for (const withRaw of [false, true]) {
          lines.push(
            `| ${arm} | ${withRaw ? "yes" : "no"} | ${scope === "all" ? "0-19" : SUMMARY_POINTS.join(",")} | ${recallCells(results, arm, withRaw, only).cells} | ${Math.round(meanCtx)} | ${Math.round(meanTail)} | ${cost.armUsd.toFixed(2)} | ${cost.deltaUsd.toFixed(2)} |`,
          );
        }
      }
    }
    for (const arm of [LUNA_DISTILL, SECTIONED_DISTILL, "lore-sectioned"]) {
      const entries = (arms[arm] ?? []).filter(Boolean);
      if (!entries.length) continue;
      const delta = totalCost(points, entries, recorded).deltaUsd;
      const verdict = worthIt({
        results,
        arm,
        rerunSpread: RERUN_SPREAD,
        extraUsd: 0,
        recordedSummaryUsd: 0,
        baseline: "recorded",
        totalCostDeltaUsd: delta,
      });
      const subsetRows = results.filter((row) => subset.has(row.point));
      const subsetEntries = entries.filter((entry) => subset.has(entry.point));
      const versusRemoved = worthIt({
        results: subsetRows,
        arm,
        rerunSpread: RERUN_SPREAD,
        extraUsd: 0,
        recordedSummaryUsd: 0,
        baseline: "summary-removed",
        totalCostDeltaUsd: totalCost(points, subsetEntries, recorded).deltaUsd,
      });
      lines.push(
        "",
        `${arm} @${name} vs recorded @${name}: ${verdict.pass ? "WORTH IT" : "NOT WORTH IT"} ${JSON.stringify(verdict.checks)}`,
        `${arm} @${name} vs summary-removed @${name} (points ${SUMMARY_POINTS.join(",")}): ${versusRemoved.pass ? "WORTH IT" : "NOT WORTH IT"} ${JSON.stringify(versusRemoved.checks)}`,
      );
    }
  }
  return lines;
}
