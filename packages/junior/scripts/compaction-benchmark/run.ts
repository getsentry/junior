import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
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
  assertOutsideGit,
  mergeExport,
  readEvents,
  writeEvents,
} from "./events";
import { eventText, rebuildCompactions, type CompactionPoint } from "./history";
import { BudgetStop, MODELS, mapLimit, modelCaller } from "./models";
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

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string" },
    "max-usd": { type: "string" },
    "dry-run": { type: "boolean", default: false },
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
    "Usage: run.ts <merge|rebuild|tier1|score|distill|rerun-summary|tier2|probe|report> --data DIR [--dry-run] [--max-usd N]",
  );
  process.exit(2);
}
assertOutsideGit(data);
const path = (name: string) => join(data, name);
const readJson = <T>(name: string): T =>
  JSON.parse(readFileSync(path(name), "utf8")) as T;
const writeJson = (name: string, value: unknown) => {
  mkdirSync(join(path(name), ".."), { recursive: true });
  writeFileSync(path(name), JSON.stringify(value, null, 1));
};
const budget = {
  cacheDir: path("cache"),
  maxUsd: Number(values["max-usd"] ?? 0),
  dryRun: values["dry-run"] ?? false,
};

function loadPoints(): CompactionPoint[] {
  return rebuildCompactions(readEvents(path("events.jsonl")));
}

function selected(points: CompactionPoint[]): CompactionPoint[] {
  if (!values.points) return points;
  const wanted = new Set(values.points.split(",").map(Number));
  return points.filter((point) => wanted.has(point.index));
}

function loadArms(): Record<string, ArmContext[]> {
  const arms: Record<string, ArmContext[]> = { ...freeArms(loadPoints()) };
  if (!existsSync(path("arms"))) return arms;
  for (const file of readdirSync(path("arms")).sort()) {
    if (file.endsWith(".json")) {
      arms[file.slice(0, -".json".length)] = readJson(`arms/${file}`);
    }
  }
  return arms;
}

function laterWork(
  events: ReturnType<typeof readEvents>,
  point: CompactionPoint,
) {
  const lines: string[] = [];
  let size = 0;
  for (const event of events) {
    if (event.seq <= point.seq || event.seq > point.windowEndSeq) continue;
    if (!["user_message", "assistant_message"].includes(event.data.type))
      continue;
    const text = eventText(event.data).slice(0, 2_000);
    size += text.length;
    if (size > 120_000) break;
    lines.push(
      `seq ${event.seq} ${event.data.type === "user_message" ? "user" : "agent"}: ${text}`,
    );
  }
  return lines.join("\n");
}

function printSpend(ledger: {
  spentUsd: number;
  estimatedUsd: number;
  pendingCalls: number;
}) {
  if (budget.dryRun) {
    console.log(
      `dry run: ${ledger.pendingCalls} uncached calls, estimated $${ledger.estimatedUsd.toFixed(2)}`,
    );
  } else {
    console.log(`spent so far in this cache: $${ledger.spentUsd.toFixed(2)}`);
  }
}

async function main() {
  if (command === "merge") {
    const { events, missing } = mergeExport(data!);
    writeEvents(path("events.jsonl"), events);
    console.log(
      `events: ${events.length}, missing payloads: ${missing.length}`,
    );
    if (missing.length) process.exitCode = 1;
    return;
  }
  if (command === "rebuild") {
    for (const point of loadPoints()) {
      const dropped = point.dropped.reduce((sum, m) => sum + m.tokens, 0);
      const tail = point.tail.reduce((sum, m) => sum + m.tokens, 0);
      console.log(
        `#${point.index} seq ${point.seq} v${point.version}: messages rebuilt ${point.rebuiltInputMessages} / recorded ${point.details.inputMessageCount}; removed ${point.dropped.length} msgs ~${dropped} tok; tail ${point.tail.length} msgs ~${tail} tok; recorded est ${point.details.estimatedInputTokens}; summary $${point.recordedSummaryCostUsd?.toFixed(4) ?? "?"}; next-version calls ${point.nextVersionCalls}`,
      );
    }
    return;
  }
  if (command === "tier1") {
    const facts = mineTier1(readEvents(path("events.jsonl")), loadPoints());
    writeJson("tier1.json", facts);
    const byKind: Record<string, number> = {};
    for (const fact of facts) byKind[fact.kind] = (byKind[fact.kind] ?? 0) + 1;
    console.log(`tier1 facts: ${facts.length}`, byKind);
    return;
  }
  if (command === "score") {
    const facts = readJson<Tier1Fact[]>("tier1.json");
    const points = loadPoints();
    const arms = loadArms();
    for (const [name, arm] of Object.entries(arms)) {
      const presence = tier1Presence(facts, arm);
      const cost = costSummary(points, arm, arms["recorded"]!);
      console.log(
        `${name.padEnd(14)} tier1 presence ${pct(presence.recall)} (n=${presence.n}) by age ${Object.entries(
          presence.byAge,
        )
          .map(([k, v]) => `${k}:${pct(v.recall)}/${v.n}`)
          .join(
            " ",
          )} | mean ctx ${Math.round(cost.meanTokens)} tok | worker $${cost.workerUsd.toFixed(2)} | modeled savings vs recorded $${cost.savingsUsd.toFixed(2)} (${pct(cost.savingsRatio)})`,
      );
      console.log(
        `${"".padEnd(14)} by kind ${Object.entries(presence.byKind)
          .map(([k, v]) => `${k}:${pct(v.recall)}/${v.n}`)
          .join(" ")}`,
      );
    }
    return;
  }

  const { call, ledger } = modelCaller(budget);
  try {
    if (command === "distill") {
      // `luna` is the default distiller; any other value is a Gateway text model id.
      const modelId = values.model === "luna" ? MODELS.luna : values.model;
      const arm = await distillationChain(loadPoints(), modelId, call);
      const name = modelId.split("/").at(-1);
      if (!budget.dryRun) writeJson(`arms/distill-${name}.json`, arm);
    } else if (command === "rerun-summary") {
      const points = selected(loadPoints());
      for (let run = 1; run <= Number(values.runs); run += 1) {
        const arm = await summaryRerun(points, call, run);
        if (!budget.dryRun) writeJson(`arms/rerun-${run}.json`, arm);
      }
    } else if (command === "tier2") {
      const events = readEvents(path("events.jsonl"));
      const points = selected(loadPoints());
      const windows = new Map(
        points.map((point) => [point.index, laterWork(events, point)]),
      );
      const items = await mineTier2(points, windows, call);
      if (!budget.dryRun) {
        writeJson("tier2.json", items);
        console.log(
          `tier2 items: ${items.length}; review ${path("tier2.json")} before probing`,
        );
      }
    } else if (command === "probe") {
      const points = loadPoints();
      const arms = loadArms();
      const names =
        values.arms?.split(",") ??
        Object.keys(arms).filter((name) => name !== "removed");
      const facts = readJson<Tier1Fact[]>("tier1.json");
      const items = existsSync(path("tier2.json"))
        ? readJson<Tier2Item[]>("tier2.json")
        : [];
      const jobs = names.flatMap((arm) =>
        [false, true].flatMap((withRaw) => [
          ...facts.map((fact) => ({ arm, withRaw, tier: 1 as const, fact })),
          ...items.map((item) => ({ arm, withRaw, tier: 2 as const, item })),
        ]),
      );
      const results = await mapLimit(
        jobs,
        8,
        async (job): Promise<ProbeResult> => {
          const pointIndex = job.tier === 1 ? job.fact.point : job.item.point;
          const point = points[pointIndex]!;
          const context =
            arms[job.arm]?.find((entry) => entry.point === pointIndex)
              ?.context ?? "";
          const question =
            job.tier === 1
              ? `Earlier work used a ${job.fact.kind} value at ▢▢▢ in this action:\n<action>${job.fact.maskedUse}</action>\nWhich value fills ▢▢▢?`
              : job.item.question;
          const { answer, costUsd } = await answerProbe({
            arm: job.arm,
            point,
            context,
            question,
            withRaw: job.withRaw,
            call,
          });
          const score =
            job.tier === 1
              ? { recall: scoreTier1Answer(job.fact, answer), leaked: 0 }
              : scoreTier2Answer(job.item, answer);
          return {
            arm: job.arm,
            withRaw: job.withRaw,
            tier: job.tier,
            id:
              job.tier === 1
                ? `${job.fact.point}:${job.fact.key}`
                : job.item.id,
            point: pointIndex,
            age: job.tier === 1 ? job.fact.age : 0,
            ...score,
            costUsd,
          };
        },
      );
      if (!budget.dryRun) writeJson("probes.json", results);
    } else if (command === "report") {
      const points = loadPoints();
      const arms = loadArms();
      const results = readJson<ProbeResult[]>("probes.json");
      const reruns = ["rerun-1", "rerun-2", "rerun-3"].filter(
        (name) => arms[name],
      );
      const rerunRecall = reruns.map(
        (name) => probeRecall(results, name, 1, false).recall ?? 0,
      );
      const spread =
        rerunRecall.length > 1
          ? Math.max(...rerunRecall) - Math.min(...rerunRecall)
          : 0;
      const recordedUsd = arms["recorded"]!.reduce(
        (sum, entry) => sum + entry.workerCostUsd,
        0,
      );
      const lines = [
        "| arm | raw | T1 recall | T1 age>=5 | T2 recall | T2 leaks | mean ctx tok | worker $ | modeled savings $ |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
      ];
      for (const [name, arm] of Object.entries(arms)) {
        const cost = costSummary(points, arm, arms["recorded"]!);
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
        const cost = costSummary(points, arms[name]!, arms["recorded"]!);
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
      writeFileSync(path("report.md"), lines.join("\n"));
      console.log(lines.join("\n"));
      return;
    } else {
      throw new Error(`Unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof BudgetStop) {
      console.error(error.message);
      process.exitCode = 3;
    } else {
      throw error;
    }
  }
  printSpend(ledger);
}

function pct(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

await main();
