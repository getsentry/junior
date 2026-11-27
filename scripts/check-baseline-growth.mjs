import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Baselines let a check fail only on new violations, so a baseline may only
 * shrink. Without this check, an agent that trips a check adds an entry and
 * the check passes. This check compares each baseline to the merge base with
 * `origin/main` and fails when a rule allows more violations than before.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BASE_BRANCH = "origin/main";

// A ratchet list is found by its name, so a new one is checked without an
// edit here.
const BASELINE_PATTERNS = [
  "scripts/*-baseline.{json,txt}",
  "scripts/*-exceptions.mjs",
  "packages/*/scripts/*-baseline.{json,txt}",
  "packages/*/scripts/*-exceptions.mjs",
];
// Files that match a pattern but are allowed to grow.
const GROWABLE = new Set([
  // Approved system errors: a new system error adds an entry.
  "packages/junior/scripts/tool-error-classification-baseline.txt",
  // Byte budgets, not a list of violations.
  "scripts/dashboard-bundle-size-baseline.json",
  // Approved Inbox item fields: a field that a design change adds adds an
  // entry. Review catches a field that no design line backs.
  "scripts/inbox-item-fields-baseline.json",
]);

/**
 * Flatten a parsed baseline into a map from entry key to allowed count. A key
 * is the file path, then the rule name if the baseline has one, then any
 * detail, joined by tabs. An entry with an empty path and count 0 records that
 * a rule exists, so a rule with no entries left still counts as present.
 */
export function baselineEntries(value) {
  const entries = new Map();
  const add = (key, count) =>
    entries.set(key.join("\t"), (entries.get(key.join("\t")) ?? 0) + count);
  add([""], 0);
  if (Array.isArray(value)) {
    for (const item of value) add([item], 1);
    return entries;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number") add([key], item);
    else if (typeof item === "string") add([key], 1);
    else {
      // Nested baselines group files by rule. Put the path first.
      for (const [nested, count] of baselineEntries(item)) {
        const [filePath, ...detail] = nested.split("\t");
        add([filePath, key, ...detail], count);
      }
    }
  }
  return entries;
}

/** Parse baseline file source into entries, by file type. */
export async function parseBaseline(filePath, source) {
  if (filePath.endsWith(".json")) return baselineEntries(JSON.parse(source));
  if (filePath.endsWith(".mjs")) {
    const module = await import(
      `data:text/javascript,${encodeURIComponent(source)}`
    );
    const [value] = Object.values(module);
    return baselineEntries(value);
  }
  // A text baseline has one entry per line. The whole line is the key.
  return baselineEntries(
    source
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => line.replaceAll("\t", " ")),
  );
}

const ruleOf = (key) => key.split("\t")[1] ?? "";

/**
 * Total the entries per rule. A file that moves or splits keeps the same
 * total. Only a change that adds violations raises it.
 */
function totalsByRule(entries) {
  const totals = new Map();
  for (const [key, count] of entries) {
    totals.set(ruleOf(key), (totals.get(ruleOf(key)) ?? 0) + count);
  }
  return totals;
}

/**
 * Report each rule whose total is higher than at the base, with the entries
 * that are new or higher.
 */
export function findGrowth(baseEntries, headEntries) {
  const baseTotals = totalsByRule(baseEntries);
  const growth = [];
  for (const [rule, count] of totalsByRule(headEntries)) {
    const allowed = baseTotals.get(rule);
    // A rule that is new in this change adopts a new check.
    if (allowed === undefined || count <= allowed) continue;
    const entries = [...headEntries]
      .filter(
        ([key, entryCount]) =>
          ruleOf(key) === rule && entryCount > (baseEntries.get(key) ?? 0),
      )
      .map(([key]) => key.split("\t")[0]);
    growth.push({ rule, allowed, count, entries });
  }
  return growth;
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function mergeBase() {
  try {
    return git(["merge-base", "HEAD", BASE_BRANCH]).trim();
  } catch (error) {
    throw new Error(
      `baseline-growth check needs ${BASE_BRANCH}. Run \`git fetch origin main\`.`,
      { cause: error },
    );
  }
}

function readAtBase(base, filePath) {
  try {
    return git(["show", `${base}:${filePath}`], { stdio: "pipe" });
  } catch {
    // A baseline that is new in this change has nothing to compare against.
    return undefined;
  }
}

/** Check that no baseline allows more violations than on the base branch. */
export async function run() {
  const base = mergeBase();
  const errors = [];
  const baselines = fs
    .globSync(BASELINE_PATTERNS, { cwd: REPO_ROOT })
    .filter((filePath) => !GROWABLE.has(filePath));
  for (const filePath of baselines) {
    const headPath = path.join(REPO_ROOT, filePath);
    const baseSource = readAtBase(base, filePath);
    if (baseSource === undefined) continue;
    const growth = findGrowth(
      await parseBaseline(filePath, baseSource),
      await parseBaseline(filePath, fs.readFileSync(headPath, "utf8")),
    );
    for (const { rule, allowed, count, entries } of growth) {
      errors.push(
        `${filePath}${rule ? ` (${rule})` : ""}: ${allowed} -> ${count}, from ${entries.join(", ")}`,
      );
    }
  }
  if (errors.length === 0) return [];
  return [
    `These baselines allow more violations than on ${BASE_BRANCH}:`,
    ...errors,
    "Revert the baseline entry and fix the code that the owning check reports. A baseline may only shrink.",
  ];
}
