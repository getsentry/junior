import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArmContext, Tier2Item } from "./arms";
import {
  replayCases,
  replayRuntime,
  replayTurn,
  type BehaviorResult,
  type ReplayCase,
} from "./behavior";
import {
  BEHAVIOR_RULES,
  applicableRules,
  ruleStandingPoints,
} from "./behavior-rules";
import { mapLimit } from "./models";
import { wilson } from "./report";
import { loadArms, loadData, type StageContext } from "./stages";

/** Arms the behavioral track replays by default. */
export const BEHAVIOR_ARMS = [
  "empty",
  "recorded",
  "distill-gpt-6-luna",
  "lore",
  "hybrid",
];

function readItems(dir: string): Tier2Item[] {
  return JSON.parse(
    readFileSync(join(dir, "tier2.json"), "utf8"),
  ) as Tier2Item[];
}

/** Replay cases that have at least one applicable rule, with those rules. */
function scoredCases(dir: string, turnsPerPoint: number, indexes?: number[]) {
  const { events, points, turns } = loadData(dir);
  const standing = ruleStandingPoints(readItems(dir));
  const wanted = indexes ? new Set(indexes) : undefined;
  const cases = replayCases(
    events,
    points.filter((point) => !wanted || wanted.has(point.index)),
    turns,
    turnsPerPoint,
  )
    .map((replay) => ({
      replay,
      rules: applicableRules({
        point: replay.point.index,
        standing,
        turn: replay.turn,
        real: replay.real,
      }),
    }))
    .filter((entry) => entry.rules.length > 0);
  return { cases, standing };
}

/** Print where each rule stands and at which points it applies. No model. */
export function rules(dir: string, turnsPerPoint = 1) {
  const { cases, standing } = scoredCases(dir, turnsPerPoint);
  for (const rule of BEHAVIOR_RULES) {
    const at = cases
      .filter((entry) => entry.rules.some((applied) => applied.id === rule.id))
      .map((entry) => entry.replay.point.index);
    console.log(
      `${rule.id.padEnd(32)} standing from ${standing.has(rule.id) ? `#${standing.get(rule.id)}` : "never (no tier2 item)"}; applies at ${at.length} points: ${at.join(", ") || "-"}`,
    );
  }
  console.log(
    `${turnsPerPoint} Turn(s) per point: ${cases.length} replayed Turns have at least one rule, at points ${[...new Set(cases.map((entry) => entry.replay.point.index))].join(", ")}`,
  );
}

/**
 * Replay the next real Turn at each scored point for each arm and write
 * `behavior.json`. Dry runs pass the arms that earlier dry stages produce.
 */
export async function behavior(
  ctx: StageContext,
  options: {
    arms?: string[];
    points?: number[];
    turnsPerPoint?: number;
    extraArms?: Record<string, ArmContext[]>;
  } = {},
): Promise<BehaviorResult[]> {
  const { cases, standing } = scoredCases(
    ctx.dir,
    options.turnsPerPoint ?? 1,
    options.points,
  );
  const arms = { ...loadArms(ctx.dir), ...options.extraArms };
  const names = options.arms ?? BEHAVIOR_ARMS;
  const missing = names.filter((name) => !arms[name]);
  if (missing.length) {
    throw new Error(`behavior: build these arms first: ${missing.join(", ")}`);
  }
  const runtime = await replayRuntime();
  const jobs: Array<{ arm: string; replay: ReplayCase }> = names.flatMap(
    (arm) => cases.map(({ replay }) => ({ arm, replay })),
  );
  const results = await mapLimit(jobs, 4, (job) =>
    replayTurn({
      arm: job.arm,
      entry:
        job.arm === "empty"
          ? undefined
          : arms[job.arm]!.find(
              (entry) => entry.point === job.replay.point.index,
            ),
      replay: job.replay,
      standing,
      runtime,
      chat: ctx.chat,
    }),
  );
  if (!ctx.dryRun) {
    const path = join(ctx.dir, "behavior.json");
    const kept = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as BehaviorResult[]).filter(
          (row) =>
            !names.includes(row.arm) ||
            !cases.some((entry) => entry.replay.turn.id === row.turn),
        )
      : [];
    writeFileSync(path, JSON.stringify([...kept, ...results], null, 1));
  }
  return results;
}

function pct(value: number | undefined) {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

/**
 * Write `behavior.md`: rule outcomes per arm, never pooled with recall.
 * The pass rate counts only decided outcomes; inconclusive ones are listed.
 */
export function behaviorReport(dir: string) {
  const path = join(dir, "behavior.json");
  if (!existsSync(path)) return;
  const results = JSON.parse(readFileSync(path, "utf8")) as BehaviorResult[];
  const arms = [...new Set(results.map((row) => row.arm))];
  const lines = [
    "Behavioral track. Cells: pass / fail / inconclusive, then the pass rate of decided outcomes [Wilson 95% CI]. Not pooled with recall.",
    "",
    `| rule | ${arms.join(" | ")} |`,
    `|---|${arms.map(() => "---").join("|")}|`,
  ];
  for (const rule of BEHAVIOR_RULES) {
    const cells = arms.map((arm) => {
      const outcomes = results
        .filter((row) => row.arm === arm)
        .map((row) => row.outcomes[rule.id])
        .filter(Boolean);
      const pass = outcomes.filter((outcome) => outcome === "pass").length;
      const fail = outcomes.filter((outcome) => outcome === "fail").length;
      const open = outcomes.length - pass - fail;
      const [low, high] = wilson(pass, pass + fail);
      return `${pass}/${fail}/${open} ${pct(pass + fail ? pass / (pass + fail) : undefined)} [${pct(low)}–${pct(high)}]`;
    });
    lines.push(`| ${rule.id} | ${cells.join(" | ")} |`);
  }
  lines.push(
    "",
    ...arms.map((arm) => {
      const rows = results.filter((row) => row.arm === arm);
      const capped = rows.filter((row) => row.ending === "step_cap").length;
      const cost = rows.reduce((sum, row) => sum + row.costUsd, 0);
      return `${arm}: ${rows.length} Turns, ${capped} hit the step cap, $${cost.toFixed(2)}`;
    }),
  );
  writeFileSync(join(dir, "behavior.md"), lines.join("\n"));
  console.log(lines.join("\n"));
}
