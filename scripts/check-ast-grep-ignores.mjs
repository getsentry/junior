import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";

const RULES_DIRECTORY = "ast-grep/rules";
const execFileAsync = promisify(execFile);

// `ast-grep:lint` runs this check after the ast-grep scan.
export const lint = false;

// ast-grep reports unused inline `ast-grep-ignore` comments, but not a
// rule-level `ignores` glob that exempts nothing. Without this check, a stale
// allowlist entry stays forever and reads as a place to add more files.
function readRulesWithIgnores(root) {
  const directory = path.join(root, RULES_DIRECTORY);
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .flatMap((name) =>
      parseAllDocuments(fs.readFileSync(path.join(directory, name), "utf8"))
        .map((document) => document.toJS())
        .filter((rule) => rule.ignores?.length > 0)
        .map((rule) => ({ file: `${RULES_DIRECTORY}/${name}`, rule })),
    );
}

// Scanning through ast-grep keeps its glob semantics: `*` also matches `/`.
// One scan runs all the given rules, each under its own id, so the tree is
// walked once and not once per rule. Returns the finding files of each id.
async function scanFindingFiles(root, rules, paths) {
  const files = new Map(rules.map(({ id }) => [id, []]));
  if (rules.length === 0) return files;
  // Hint severity keeps the exit code 0 when the scan finds matches.
  const { stdout } = await execFileAsync(
    "ast-grep",
    [
      "scan",
      "--inline-rules",
      rules
        .map(({ id, rule }) =>
          JSON.stringify({ ...rule, id, severity: "hint" }),
        )
        .join("\n---\n"),
      "--json=stream",
      ...paths,
    ],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  for (const line of stdout.split("\n").filter(Boolean)) {
    const { ruleId, file } = JSON.parse(line);
    files.get(ruleId).push(file);
  }
  return files;
}

// Scan only the directories that the rules' `files` globs start with. A
// directory inside another one is dropped: ast-grep reports a file again
// for each path that contains it.
function scanRoots(rules) {
  const roots = rules.flatMap((rule) =>
    (rule.files ?? ["."]).map((glob) => {
      const parts = glob.split("/");
      const firstPattern = parts.findIndex((part) => /[*?[{]/.test(part));
      return (
        parts.slice(0, firstPattern === -1 ? -1 : firstPattern).join("/") || "."
      );
    }),
  );
  const unique = [...new Set(roots)];
  return unique.filter(
    (dir) =>
      !unique.some(
        (other) =>
          other !== dir && (other === "." || dir.startsWith(`${other}/`)),
      ),
  );
}

// A rule with `metadata.baseline` maps each file that it ignores to the
// number of findings that the file may keep, so an ignored file cannot gain a
// finding. Its ignores are exact paths, so a file with no finding is a stale
// entry. A count that is too high must go down, so the baseline only shrinks.
function checkBaselineCounts({ file, ignores, baseline, unignored }, findings) {
  const errors = [];
  const actual = new Map();
  for (const findingFile of findings) {
    actual.set(findingFile, (actual.get(findingFile) ?? 0) + 1);
  }
  for (const ignored of ignores) {
    const allowed = baseline[ignored];
    const count = actual.get(ignored) ?? 0;
    if (allowed === undefined) {
      errors.push(
        `${file}: ${unignored.id} ignores ${ignored}, but metadata.baseline has no count for it.`,
      );
    } else if (count === 0) {
      errors.push(
        `${file}: ${unignored.id} ignores ${ignored}, but it exempts no finding.`,
      );
    } else if (count > allowed) {
      errors.push(
        `${ignored}: ${unignored.id} finds ${count}, but its baseline in ${file} is ${allowed}. Fix the new finding. The baseline can only go down.`,
      );
    } else if (count < allowed) {
      errors.push(
        `${ignored}: ${unignored.id} finds ${count}, but its baseline in ${file} is ${allowed}. Lower the entry to ${count}.`,
      );
    }
  }
  for (const filePath of Object.keys(baseline)) {
    if (!ignores.includes(filePath)) {
      errors.push(
        `${file}: ${unignored.id} has a metadata.baseline count for ${filePath}, but does not ignore it.`,
      );
    }
  }
  return errors;
}

/**
 * Report rule-level ast-grep ignores that exempt no finding of their rule,
 * and ignored files whose findings do not match the rule's baseline counts.
 */
export async function checkAstGrepIgnores(root) {
  // Metadata does not change what a rule matches, and a baseline can be too
  // long to pass to ast-grep as an argument.
  const entries = readRulesWithIgnores(root).map(
    ({ file, rule: { ignores, metadata, ...unignored } }, index) => ({
      file,
      id: `rule-${index}`,
      ignores,
      baseline: metadata?.baseline,
      unignored,
    }),
  );
  const findings = await scanFindingFiles(
    root,
    entries.map(({ id, unignored }) => ({ id, rule: unignored })),
    scanRoots(entries.map(({ unignored }) => unignored)),
  );
  // An ignore is stale when the rule keeps every finding with only that
  // ignore set. Every finding file of every rule is scanned once more.
  const probes = entries.flatMap(({ id, ignores, baseline, unignored }) =>
    baseline || findings.get(id).length === 0
      ? []
      : ignores.map((glob, index) => ({
          id: `${id}-ignore-${index}`,
          rule: { ...unignored, ignores: [glob] },
        })),
  );
  const kept = await scanFindingFiles(root, probes, [
    ...new Set([...findings.values()].flat()),
  ]);
  return entries.flatMap((entry) => {
    const { file, id, ignores, baseline, unignored } = entry;
    if (baseline) return checkBaselineCounts(entry, findings.get(id));
    const count = findings.get(id).length;
    return ignores
      .filter(
        (_glob, index) =>
          count === 0 || kept.get(`${id}-ignore-${index}`).length === count,
      )
      .map(
        (glob) =>
          `${file}: ${unignored.id} ignores ${glob}, but it exempts no finding.`,
      );
  });
}

/** Check that rule-level ast-grep ignores and baseline counts are current. */
export async function run({ root }) {
  const errors = await checkAstGrepIgnores(root);
  if (errors.length === 0) return [];
  return [
    ...errors,
    "Delete each stale entry, and lower each count that went down. Rule-level ignores exempt only the module that owns the boundary, or the files that a baseline lists. Do not add or raise a baseline entry. For a one-off exception, put `// ast-grep-ignore: <rule-id> -- <reason>` on the line before the match.",
  ];
}
