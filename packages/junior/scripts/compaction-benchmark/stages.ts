import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  answerProbe,
  distillationChain,
  freeArms,
  mineTier2,
  summaryRerun,
  type ArmContext,
  type Tier2Item,
} from "./arms";
import {
  mergeExport,
  readEvents,
  writeEvents,
  type BenchEvent,
} from "./events";
import { eventText, rebuildCompactions, type CompactionPoint } from "./history";
import {
  buildLorePool,
  composeContext,
  loreArms,
  pinnedBlock,
  DEFAULT_BUDGETS,
  type LoreBudgets,
} from "./lore";
import {
  MODELS,
  mapLimit,
  type ChatRequest,
  type ChatResult,
  type ModelCall,
} from "./models";
import {
  costSummary,
  probeRecall,
  scoreTier1Answer,
  scoreTier2Answer,
  tier1Presence,
  totalVersionCost,
  wilson,
  worthIt,
  BAR,
  isPass,
  type ProbeResult,
} from "./report";
import { mineTier1, type Tier1Fact } from "./tier1";
import {
  firstTurnAfter,
  maskValue,
  turnAt,
  turnsOf,
  type BenchTurn,
} from "./turns";

type Call = (request: ModelCall) => Promise<{ text: string; costUsd: number }>;

/** Files and the model callers for one data directory. */
export interface StageContext {
  dir: string;
  call: Call;
  chat: (request: ChatRequest) => Promise<ChatResult>;
  dryRun: boolean;
}

function file(dir: string, name: string) {
  return join(dir, name);
}

function readJson<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(file(dir, name), "utf8")) as T;
}

function writeJson(dir: string, name: string, value: unknown) {
  mkdirSync(dirname(file(dir, name)), { recursive: true });
  writeFileSync(file(dir, name), JSON.stringify(value, null, 1));
}

function pct(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/** Rebuild compaction points from `events.jsonl`. */
export function loadPoints(dir: string): CompactionPoint[] {
  return rebuildCompactions(readEvents(file(dir, "events.jsonl")));
}

/** The event log, its compaction points and its Turns. */
export function loadData(dir: string): {
  events: BenchEvent[];
  points: CompactionPoint[];
  turns: BenchTurn[];
} {
  const events = readEvents(file(dir, "events.jsonl"));
  return { events, points: rebuildCompactions(events), turns: turnsOf(events) };
}

/**
 * The real Turn input that keys per-Turn retrieval. Tier 1: the Turn that
 * later used the fact, with the fact itself masked, so retrieval cannot key
 * on the answer. Tier 2: the first Turn after the compaction.
 */
export function probeQueries(
  points: readonly CompactionPoint[],
  turns: readonly BenchTurn[],
) {
  return {
    tier1: (fact: Tier1Fact) =>
      maskValue(turnAt(turns, fact.useSeq)?.input ?? "", fact.value),
    tier2: (item: Tier2Item) =>
      firstTurnAfter(turns, points[item.point]?.seq ?? 0)?.input ?? "",
  };
}

/** Free arms plus every saved arm under `arms/`. */
export function loadArms(dir: string): Record<string, ArmContext[]> {
  const arms: Record<string, ArmContext[]> = { ...freeArms(loadPoints(dir)) };
  if (!existsSync(file(dir, "arms"))) return arms;
  for (const name of readdirSync(file(dir, "arms")).sort()) {
    if (name.endsWith(".json")) {
      arms[name.slice(0, -".json".length)] = readJson(dir, `arms/${name}`);
    }
  }
  return arms;
}

/** Merge the export. Returns false while a needed payload is missing. */
export function merge(dir: string): boolean {
  const { events, missing } = mergeExport(dir);
  writeEvents(file(dir, "events.jsonl"), events);
  console.log(`events: ${events.length}, missing payloads: ${missing.length}`);
  return missing.length === 0;
}

/** Print each compaction point and how well it matches the recorded counts. */
export function rebuild(dir: string) {
  for (const point of loadPoints(dir)) {
    const removed = point.dropped.reduce((sum, m) => sum + m.tokens, 0);
    const tail = point.tail.reduce((sum, m) => sum + m.tokens, 0);
    console.log(
      `#${point.index} seq ${point.seq} v${point.version}: messages rebuilt ${point.rebuiltInputMessages} / recorded ${point.details.inputMessageCount}; removed ${point.dropped.length} msgs ~${removed} tok; tail ${point.tail.length} msgs ~${tail} tok; summary $${point.recordedSummaryCostUsd?.toFixed(4) ?? "?"}; next-version calls ${point.nextVersionCalls}`,
    );
  }
}

/** Mine Tier 1 facts into `tier1.json`. */
export function tier1(dir: string) {
  const facts = mineTier1(
    readEvents(file(dir, "events.jsonl")),
    loadPoints(dir),
  );
  writeJson(dir, "tier1.json", facts);
  const byKind: Record<string, number> = {};
  for (const fact of facts) byKind[fact.kind] = (byKind[fact.kind] ?? 0) + 1;
  console.log(`tier1 facts: ${facts.length}`, byKind);
}

/** Print Tier 1 presence recall and modeled cost for every arm. */
export function score(dir: string) {
  const facts = readJson<Tier1Fact[]>(dir, "tier1.json");
  const { points, turns } = loadData(dir);
  const queries = probeQueries(points, turns);
  const arms = loadArms(dir);
  for (const [name, arm] of Object.entries(arms)) {
    const presence = tier1Presence(facts, arm, queries.tier1);
    const cost = costSummary(points, arm, arms["recorded"]!);
    const byAge = Object.entries(presence.byAge)
      .map(([age, row]) => `${age}:${pct(row.recall)}/${row.n}`)
      .join(" ");
    const byKind = Object.entries(presence.byKind)
      .map(([kind, row]) => `${kind}:${pct(row.recall)}/${row.n}`)
      .join(" ");
    console.log(
      `${name.padEnd(18)} tier1 presence ${pct(presence.recall)} (n=${presence.n}) by age ${byAge} | by kind ${byKind} | mean ctx ${Math.round(cost.meanTokens)} tok | worker $${cost.workerUsd.toFixed(2)} | modeled savings vs recorded $${cost.savingsUsd.toFixed(2)} (${pct(cost.savingsRatio)})`,
    );
  }
}

function selected(points: CompactionPoint[], indexes?: number[]) {
  if (!indexes) return points;
  const wanted = new Set(indexes);
  return points.filter((point) => wanted.has(point.index));
}

function laterWork(events: readonly BenchEvent[], point: CompactionPoint) {
  const lines: string[] = [];
  let size = 0;
  for (const event of events) {
    if (event.seq <= point.seq || event.seq > point.windowEndSeq) continue;
    if (!["user_message", "assistant_message"].includes(event.data.type)) {
      continue;
    }
    const text = eventText(event.data).slice(0, 2_000);
    size += text.length;
    if (size > 120_000) break;
    const role = event.data.type === "user_message" ? "user" : "agent";
    lines.push(`seq ${event.seq} ${role}: ${text}`);
  }
  return lines.join("\n");
}

/**
 * Mine Tier 2 probes. An existing `tier2.json` holds a person's review, so
 * it is never overwritten.
 */
export async function tier2(
  ctx: StageContext,
  indexes?: number[],
): Promise<Tier2Item[]> {
  const events = readEvents(file(ctx.dir, "events.jsonl"));
  const points = selected(loadPoints(ctx.dir), indexes);
  const windows = new Map(
    points.map((point) => [point.index, laterWork(events, point)]),
  );
  const items = await mineTier2(points, windows, ctx.call);
  if (ctx.dryRun) return items;
  const target = existsSync(file(ctx.dir, "tier2.json"))
    ? "tier2.mined.json"
    : "tier2.json";
  writeJson(ctx.dir, target, items);
  console.log(
    `tier2 items: ${items.length}, written to ${file(ctx.dir, target)}`,
  );
  return items;
}

/** Run one distillation arm. `luna` or a Gateway text model id. */
export async function distill(
  ctx: StageContext,
  model = "luna",
): Promise<Record<string, ArmContext[]>> {
  const modelId = model === "luna" ? MODELS.luna : model;
  const arm = await distillationChain(loadPoints(ctx.dir), modelId, ctx.call);
  const name = `distill-${modelId.split("/").at(-1)}`;
  if (!ctx.dryRun) writeJson(ctx.dir, `arms/${name}.json`, arm);
  return { [name]: arm };
}

/** Rerun today's summary at selected points. */
export async function rerunSummary(
  ctx: StageContext,
  runs: number,
  indexes?: number[],
): Promise<Record<string, ArmContext[]>> {
  const points = selected(loadPoints(ctx.dir), indexes);
  const arms: Record<string, ArmContext[]> = {};
  for (let run = 1; run <= runs; run += 1) {
    const arm = await summaryRerun(points, ctx.call, run);
    arms[`rerun-${run}`] = arm;
    if (!ctx.dryRun) writeJson(ctx.dir, `arms/rerun-${run}.json`, arm);
  }
  return arms;
}

/**
 * Build the `lore` and `hybrid` arms. The distillation chain reruns from its
 * cache to recover each point's new observations, then a Luna curator and a
 * Luna meta call run at each point.
 */
export async function lore(
  ctx: StageContext,
  budgets: LoreBudgets = DEFAULT_BUDGETS,
): Promise<Record<string, ArmContext[]>> {
  const { points, turns } = loadData(ctx.dir);
  const chain = await distillationChain(points, MODELS.luna, ctx.call);
  const pool = await buildLorePool({
    points,
    observations: new Map(
      chain.map((entry) => [entry.point, entry.observations ?? []]),
    ),
    budgets,
    call: ctx.call,
  });
  const arms = loreArms({
    points,
    pool,
    turns,
    recorded: freeArms(points).recorded,
    distillUsd: new Map(
      chain.map((entry) => [entry.point, entry.workerCostUsd]),
    ),
    budgets,
    dryRun: ctx.dryRun,
  });
  if (!ctx.dryRun) {
    writeJson(ctx.dir, "lore/pool.json", pool);
    writeJson(ctx.dir, "lore/budgets.json", budgets);
    for (const [name, arm] of Object.entries(arms)) {
      writeJson(ctx.dir, `arms/${name}.json`, arm);
    }
    const last = pool.at(-1);
    const byCategory: Record<string, number> = {};
    for (const entry of last?.entries ?? []) {
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
    }
    console.log(
      `lore: ${last?.entries.length ?? 0} entries at the last point`,
      byCategory,
      `pinned ~${Math.round(pinnedBlock(last?.entries ?? [], budgets.pinnedTokens).length / 4)} tok, ${last?.observations.length ?? 0} observation docs`,
    );
  }
  return arms;
}

/**
 * Ask every Tier 1 and Tier 2 probe of each arm, with and without search.
 * Retrieval arms key their per-Turn injection on the real Turn input, never
 * the probe question. With `arms`, rows of other arms in `probes.json` stay.
 * Dry runs pass the arms and items that earlier dry stages would produce.
 */
export async function probe(
  ctx: StageContext,
  options: {
    arms?: string[];
    extraArms?: Record<string, ArmContext[]>;
    items?: Tier2Item[];
    /** Experiment 1: tail-specific facts, points and output file. */
    facts?: Tier1Fact[];
    points?: CompactionPoint[];
    output?: string;
  } = {},
): Promise<ProbeResult[]> {
  const data = loadData(ctx.dir);
  const points = options.points ?? data.points;
  const queries = probeQueries(points, data.turns);
  const arms = { ...loadArms(ctx.dir), ...options.extraArms };
  const names =
    options.arms ?? Object.keys(arms).filter((name) => name !== "removed");
  const output = options.output ?? "probes.json";
  const facts = options.facts ?? readJson<Tier1Fact[]>(ctx.dir, "tier1.json");
  const items =
    options.items ??
    (existsSync(file(ctx.dir, "tier2.json"))
      ? readJson<Tier2Item[]>(ctx.dir, "tier2.json")
      : []);
  // An arm built at only some points (the reruns) is probed only there.
  const jobs = names.flatMap((arm) => {
    const has = new Set((arms[arm] ?? []).map((entry) => entry.point));
    return [false, true].flatMap((withRaw) => [
      ...facts
        .filter((fact) => has.has(fact.point))
        .map((fact) => ({ arm, withRaw, tier: 1 as const, fact })),
      ...items
        .filter((item) => has.has(item.point))
        .map((item) => ({ arm, withRaw, tier: 2 as const, item })),
    ]);
  });
  const results = await mapLimit(jobs, 8, async (job): Promise<ProbeResult> => {
    const pointIndex = job.tier === 1 ? job.fact.point : job.item.point;
    const entry = arms[job.arm]!.find(
      (context) => context.point === pointIndex,
    )!;
    const context = composeContext(
      entry,
      job.tier === 1 ? queries.tier1(job.fact) : queries.tier2(job.item),
    );
    const question =
      job.tier === 1
        ? `Earlier work used a ${job.fact.kind} value at ▢▢▢ in this action:\n<action>${job.fact.maskedUse}</action>\nWhich value fills ▢▢▢?`
        : job.item.question;
    const { answer, costUsd } = await answerProbe({
      arm: job.arm,
      point: points[pointIndex]!,
      context,
      question,
      withRaw: job.withRaw,
      call: ctx.call,
    });
    const scored =
      job.tier === 1
        ? { recall: scoreTier1Answer(job.fact, answer), leaked: 0 }
        : scoreTier2Answer(job.item, answer);
    return {
      arm: job.arm,
      withRaw: job.withRaw,
      tier: job.tier,
      id: job.tier === 1 ? `${job.fact.point}:${job.fact.key}` : job.item.id,
      point: pointIndex,
      age: job.tier === 1 ? job.fact.age : 0,
      ...scored,
      costUsd,
    };
  });
  if (ctx.dryRun) return results;
  const kept =
    options.arms && existsSync(file(ctx.dir, output))
      ? readJson<ProbeResult[]>(ctx.dir, output).filter(
          (row) => !names.includes(row.arm),
        )
      : [];
  writeJson(ctx.dir, output, [...kept, ...results]);
  return results;
}

/** Arm configs and the bar, hashed so a report shows what it scored. */
export function fingerprint(dir: string): string {
  const hash = (name: string) =>
    existsSync(file(dir, name))
      ? createHash("sha256")
          .update(readFileSync(file(dir, name)))
          .digest("hex")
          .slice(0, 12)
      : "none";
  const budgets = existsSync(file(dir, "lore/budgets.json"))
    ? readJson<LoreBudgets>(dir, "lore/budgets.json")
    : DEFAULT_BUDGETS;
  const config = {
    bar: BAR,
    models: MODELS,
    budgets,
    tier1: hash("tier1.json"),
    tier2: hash("tier2.json"),
  };
  return `${createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12)} ${JSON.stringify(config)}`;
}

function cell(row: {
  recall?: number;
  passRate?: number;
  n: number;
  passes: number;
}) {
  const [low, high] = wilson(row.passes, row.n);
  return `${pct(row.recall)} / ${pct(row.passRate)} [${pct(low)}–${pct(high)}]`;
}

/**
 * Recall cells of one arm and raw setting: overall Tier 1, its age buckets,
 * and Tier 2, with leaks. `only` limits rows to some points.
 */
export function recallCells(
  results: readonly ProbeResult[],
  name: string,
  withRaw: boolean,
  only?: ReadonlySet<number>,
) {
  const row = (tier: 1 | 2, minAge = 0, maxAge = Infinity) => {
    const rows = results.filter(
      (entry) =>
        entry.arm === name &&
        entry.tier === tier &&
        entry.withRaw === withRaw &&
        entry.age >= minAge &&
        entry.age <= maxAge &&
        (!only || only.has(entry.point)),
    );
    const passes = rows.filter(isPass).length;
    return {
      n: rows.length,
      passes,
      recall: rows.length
        ? rows.reduce((sum, entry) => sum + entry.recall, 0) / rows.length
        : undefined,
      passRate: rows.length ? passes / rows.length : undefined,
      leaks: rows.reduce((sum, entry) => sum + entry.leaked, 0),
    };
  };
  const t2 = row(2);
  return {
    t1n: row(1).n,
    t2n: t2.n,
    cells: `${cell(row(1))} | ${cell(row(1, 0, 1))} | ${cell(row(1, 2, 4))} | ${cell(row(1, 5))} | ${cell(t2)} | ${t2.leaks}`,
  };
}

/** Summed experiment 1 total cost of an arm, and today's, over some points. */
export function totalCost(
  points: readonly CompactionPoint[],
  arm: readonly ArmContext[],
  recorded: readonly ArmContext[],
) {
  let armUsd = 0;
  let todayUsd = 0;
  for (const entry of arm) {
    const point = points[entry.point]!;
    armUsd += totalVersionCost(point, entry);
    todayUsd += totalVersionCost(point, recorded[entry.point]!);
  }
  return { armUsd, todayUsd, deltaUsd: armUsd - todayUsd };
}

/** Write and print the results tables and the worth-it verdicts. */
export function report(dir: string) {
  const points = loadPoints(dir);
  const arms = loadArms(dir);
  const results = readJson<ProbeResult[]>(dir, "probes.json");
  const facts = readJson<Tier1Fact[]>(dir, "tier1.json");
  const items = existsSync(file(dir, "tier2.json"))
    ? readJson<Tier2Item[]>(dir, "tier2.json")
    : [];
  const kindOf = new Map<string, string>([
    ...facts.map(
      (fact) => [`${fact.point}:${fact.key}`, fact.kind] as [string, string],
    ),
    ...items.map((item) => [item.id, item.kind] as [string, string]),
  ]);
  // Reruns exist at only some points. Compare them with each other there.
  const rerunNames = Object.keys(arms).filter((name) =>
    name.startsWith("rerun-"),
  );
  const rerunPoints = new Set(
    rerunNames.flatMap((name) => arms[name]!.map((entry) => entry.point)),
  );
  const spreads = ([1, 2] as const).map((tier) => {
    const values = rerunNames.map(
      (name) =>
        probeRecall(results, name, tier, false, 0, rerunPoints).recall ?? 0,
    );
    return values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
  });
  const spread = Math.max(...spreads);
  const recorded = arms["recorded"]!;
  const recordedUsd = recorded.reduce(
    (sum, entry) => sum + entry.workerCostUsd,
    0,
  );
  const scoredArms = Object.keys(arms).filter(
    (name) => name !== "removed" && results.some((row) => row.arm === name),
  );
  const lines = [
    `config ${fingerprint(dir)}`,
    "",
    "Cells: mean recall / full-pass rate [Wilson 95% CI of the pass rate]. `empty` is the guessability floor. Reruns are scored only at their points.",
    "",
    "| arm | raw | T1 | T1 age 1 | T1 age 2-4 | T1 age 5+ | T2 | T2 leaks | mean ctx tok | worker $ | modeled savings $ | total $ | total Δ vs today $ |",
    "|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const name of scoredArms) {
    const cost = costSummary(points, arms[name]!, recorded);
    const only = name.startsWith("rerun-") ? rerunPoints : undefined;
    const total = totalCost(points, arms[name]!, recorded);
    for (const withRaw of [false, true]) {
      lines.push(
        `| ${name} | ${withRaw ? "yes" : "no"} | ${recallCells(results, name, withRaw, only).cells} | ${Math.round(cost.meanTokens)} | ${cost.workerUsd.toFixed(2)} | ${only ? "n/a" : cost.savingsUsd.toFixed(2)} | ${total.armUsd.toFixed(2)} | ${only ? "n/a" : total.deltaUsd.toFixed(2)} |`,
      );
    }
  }
  const kinds = [...new Set(kindOf.values())].sort();
  lines.push(
    "",
    "Recall by kind (summary only / +raw):",
    "",
    `| arm | ${kinds.join(" | ")} |`,
    `|---|${kinds.map(() => "---").join("|")}|`,
  );
  for (const name of scoredArms.filter((arm) => !arm.startsWith("rerun-"))) {
    const byKind = kinds.map((kind) =>
      [false, true]
        .map((withRaw) => {
          const rows = results.filter(
            (entry) =>
              entry.arm === name &&
              entry.withRaw === withRaw &&
              kindOf.get(entry.id) === kind,
          );
          return rows.length
            ? pct(
                rows.reduce((sum, entry) => sum + entry.recall, 0) /
                  rows.length,
              )
            : "n/a";
        })
        .join(" / "),
    );
    lines.push(`| ${name} | ${byKind.join(" | ")} |`);
  }
  lines.push(
    "",
    `rerun spread at points ${[...rerunPoints].join(", ")}: T1 ${pct(spreads[0])}, T2 ${pct(spreads[1])}`,
    "lore and hybrid use BM25 only. Lore also ranks with embeddings, so they are a lower bound for Lore.",
  );
  for (const name of scoredArms.filter(
    (arm) =>
      arm.startsWith("distill-") || arm.startsWith("lore") || arm === "hybrid",
  )) {
    const cost = costSummary(points, arms[name]!, recorded);
    const verdict = worthIt({
      results,
      arm: name,
      rerunSpread: spread,
      extraUsd: -cost.savingsUsd,
      recordedSummaryUsd: recordedUsd,
    });
    const byTotal = worthIt({
      results,
      arm: name,
      rerunSpread: spread,
      extraUsd: -cost.savingsUsd,
      recordedSummaryUsd: recordedUsd,
      totalCostDeltaUsd: totalCost(points, arms[name]!, recorded).deltaUsd,
    });
    lines.push(
      `${name}: ${verdict.pass ? "WORTH IT" : "NOT WORTH IT"} (summary-spend bar) ${JSON.stringify(verdict.checks)}`,
      `${name}: ${byTotal.pass ? "WORTH IT" : "NOT WORTH IT"} (total-cost bar) cost check ${JSON.stringify(byTotal.checks["total cost <= today"])}`,
    );
  }
  writeFileSync(file(dir, "report.md"), lines.join("\n"));
  console.log(lines.join("\n"));
}
