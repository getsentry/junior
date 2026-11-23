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
async function scanFindingFiles(root, rule, paths = []) {
  // Hint severity keeps the exit code 0 when the scan finds matches.
  const { stdout } = await execFileAsync(
    "ast-grep",
    [
      "scan",
      "--inline-rules",
      JSON.stringify({ ...rule, severity: "hint" }),
      "--json=stream",
      ...paths,
    ],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).file);
}

// Scan only the directories that the rule's `files` globs start with.
function scanRoots(rule) {
  const roots = (rule.files ?? ["."]).map((glob) => {
    const parts = glob.split("/");
    const firstPattern = parts.findIndex((part) => /[*?[{]/.test(part));
    return parts.slice(0, firstPattern === -1 ? -1 : firstPattern).join("/");
  });
  return [...new Set(roots.map((root) => root || "."))];
}

async function findStaleIgnores(root, { file, rule }) {
  const { ignores, ...unignored } = rule;
  const findings = await scanFindingFiles(root, unignored, scanRoots(rule));
  const findingPaths = [...new Set(findings)];
  const stale = await Promise.all(
    ignores.map(async (glob) => {
      if (findingPaths.length === 0) return true;
      const kept = await scanFindingFiles(
        root,
        { ...unignored, ignores: [glob] },
        findingPaths,
      );
      return kept.length === findings.length;
    }),
  );
  return ignores
    .filter((_glob, index) => stale[index])
    .map(
      (glob) =>
        `${file}: ${rule.id} ignores ${glob}, but it exempts no finding.`,
    );
}

/** Report rule-level ast-grep ignores that exempt no finding of their rule. */
export async function checkAstGrepIgnores(root) {
  const results = await Promise.all(
    readRulesWithIgnores(root).map((entry) => findStaleIgnores(root, entry)),
  );
  return results.flat();
}

/** Check that every ast-grep rule-level ignore still exempts a finding. */
export async function run({ root }) {
  const errors = await checkAstGrepIgnores(root);
  if (errors.length === 0) return [];
  return [
    ...errors,
    "Delete each stale entry. Rule-level ignores exempt only the module that owns the boundary. For a one-off exception, put `// ast-grep-ignore: <rule-id> -- <reason>` on the line before the match.",
  ];
}
