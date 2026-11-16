import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
import { MODELS, mapLimit, type ModelCall } from "./models";
import {
  costSummary,
  probeRecall,
  scoreTier1Answer,
  scoreTier2Answer,
  tier1Presence,
  worthIt,
  type ProbeResult,
} from "./report";
import { mineTier1, type Tier1Fact } from "./tier1";

type Call = (request: ModelCall) => Promise<{ text: string; costUsd: number }>;

/** Files and the model caller for one data directory. */
export interface StageContext {
  dir: string;
  call: Call;
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
  const points = loadPoints(dir);
  const arms = loadArms(dir);
  for (const [name, arm] of Object.entries(arms)) {
    const presence = tier1Presence(facts, arm);
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
 * Ask every Tier 1 and Tier 2 probe of each arm, with and without search.
 * Dry runs pass the arms and items that earlier dry stages would produce.
 */
export async function probe(
  ctx: StageContext,
  options: {
    arms?: string[];
    extraArms?: Record<string, ArmContext[]>;
    items?: Tier2Item[];
  } = {},
): Promise<ProbeResult[]> {
  const points = loadPoints(ctx.dir);
  const arms = { ...loadArms(ctx.dir), ...options.extraArms };
  const names =
    options.arms ?? Object.keys(arms).filter((name) => name !== "removed");
  const facts = readJson<Tier1Fact[]>(ctx.dir, "tier1.json");
  const items =
    options.items ??
    (existsSync(file(ctx.dir, "tier2.json"))
      ? readJson<Tier2Item[]>(ctx.dir, "tier2.json")
      : []);
  const jobs = names.flatMap((arm) =>
    [false, true].flatMap((withRaw) => [
      ...facts.map((fact) => ({ arm, withRaw, tier: 1 as const, fact })),
      ...items.map((item) => ({ arm, withRaw, tier: 2 as const, item })),
    ]),
  );
  const results = await mapLimit(jobs, 8, async (job): Promise<ProbeResult> => {
    const pointIndex = job.tier === 1 ? job.fact.point : job.item.point;
    const context =
      arms[job.arm]?.find((entry) => entry.point === pointIndex)?.context ?? "";
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
  if (!ctx.dryRun) writeJson(ctx.dir, "probes.json", results);
  return results;
}

/** Write and print the results table and the worth-it verdicts. */
export function report(dir: string) {
  const points = loadPoints(dir);
  const arms = loadArms(dir);
  const results = readJson<ProbeResult[]>(dir, "probes.json");
  const rerunRecall = Object.keys(arms)
    .filter((name) => name.startsWith("rerun-"))
    .map((name) => probeRecall(results, name, 1, false).recall ?? 0);
  const spread =
    rerunRecall.length > 1
      ? Math.max(...rerunRecall) - Math.min(...rerunRecall)
      : 0;
  const recorded = arms["recorded"]!;
  const recordedUsd = recorded.reduce(
    (sum, entry) => sum + entry.workerCostUsd,
    0,
  );
  const lines = [
    "| arm | raw | T1 recall | T1 age>=5 | T2 recall | T2 leaks | mean ctx tok | worker $ | modeled savings $ |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [name, arm] of Object.entries(arms)) {
    const cost = costSummary(points, arm, recorded);
    for (const withRaw of [false, true]) {
      const t1 = probeRecall(results, name, 1, withRaw);
      const old = probeRecall(results, name, 1, withRaw, 5);
      const t2 = probeRecall(results, name, 2, withRaw);
      if (!t1.n && !t2.n) continue;
      lines.push(
        `| ${name} | ${withRaw ? "yes" : "no"} | ${pct(t1.recall)} | ${pct(old.recall)} | ${pct(t2.recall)} | ${t2.leaks} | ${Math.round(cost.meanTokens)} | ${cost.workerUsd.toFixed(2)} | ${cost.savingsUsd.toFixed(2)} |`,
      );
    }
  }
  lines.push("", `rerun spread (T1, summary only): ${pct(spread)}`);
  for (const name of Object.keys(arms).filter((arm) =>
    arm.startsWith("distill-"),
  )) {
    const cost = costSummary(points, arms[name]!, recorded);
    const verdict = worthIt({
      results,
      arm: name,
      rerunSpread: spread,
      extraUsd: -cost.savingsUsd,
      recordedSummaryUsd: recordedUsd,
    });
    lines.push(
      `${name}: ${verdict.pass ? "WORTH IT" : "NOT WORTH IT"} ${JSON.stringify(verdict.checks)}`,
    );
  }
  writeFileSync(file(dir, "report.md"), lines.join("\n"));
  console.log(lines.join("\n"));
}
