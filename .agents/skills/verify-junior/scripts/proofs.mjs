#!/usr/bin/env node
// List, check, or run the `test` and `eval` proof commands in the map.
//
// Usage:
//   node proofs.mjs check [MAP_FILE...]
//       Fail when a command names a missing file, or a -t / --grep pattern
//       that matches no test title in its files. Runs nothing.
//   node proofs.mjs run --out DIR [--kind test|eval|e2e]... [MAP_FILE...]
//       Run each distinct command once, from the repo root. Write
//       DIR/<n>.log per command and DIR/summary.tsv (status, passed tests
//       per pattern, log, claims, command). Status is the exit code, or
//       `too-few` when fewer tests passed than the command has patterns.
//       Default kind: test.
// MAP_FILE defaults to every file in features/ except README.md.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const skillDir = join(import.meta.dirname, "..");
const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: skillDir,
  encoding: "utf8",
}).stdout.trim();
const packageDirs = {
  "@sentry/junior": "packages/junior",
  "@sentry/junior-github": "packages/junior-github",
  "@sentry/junior-evals": "packages/junior-evals",
};

const [mode, ...rest] = process.argv.slice(2);
let out;
const kinds = new Set();
const files = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--out") out = rest[++i];
  else if (rest[i] === "--kind") kinds.add(rest[++i]);
  else files.push(rest[i]);
}
if (kinds.size === 0) kinds.add("test");
const mapFiles = files.length
  ? files
  : readdirSync(join(skillDir, "features"))
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .map((name) => join(skillDir, "features", name));

/** Each proof command in a map file, with its kind and the claims that cite it. */
function readCommands(file) {
  const commands = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const id = line.match(/^- `([a-z0-9-]+)`/)?.[1];
    if (!id) continue;
    for (const [, kind, command] of line.matchAll(
      /`(test|eval)` with `(pnpm [^`]+)`/g,
    )) {
      commands.push({
        claim: `${basename(file, ".md")}#${id}`,
        command,
        kind: command.includes("test:e2e:dashboard") ? "e2e" : kind,
      });
    }
  }
  return commands;
}

/** The test files and title patterns that a command selects. */
function parse(command) {
  const pattern = command.match(/(?:-t|--grep) "([^"]+)"/)?.[1];
  if (command.includes("test:e2e:dashboard")) {
    const dir = join(repoRoot, "packages/junior-dashboard/e2e");
    return {
      paths: readdirSync(dir)
        .filter((f) => f.endsWith(".spec.ts"))
        .map((f) => join(dir, f)),
      pattern,
    };
  }
  const pkg = command.match(/--filter (\S+)/)?.[1];
  const dir = join(repoRoot, packageDirs[pkg] ?? "");
  const paths = command
    .split(/\s+/)
    .filter((token) => /\.(test|eval)\.ts$/.test(token))
    .map((token) => join(dir, token));
  return { paths, pattern };
}

function check(command) {
  const { paths, pattern } = parse(command);
  if (paths.length === 0) return "names no test file";
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length) return `missing ${missing.join(", ")}`;
  if (!pattern) return "has no -t or --grep pattern, so it runs a whole file";
  const source = paths.map((path) => readFileSync(path, "utf8")).join("\n");
  const unmatched = pattern.split("|").filter((part) => !source.includes(part));
  return unmatched.length
    ? `no title has: ${unmatched.join(" | ")}`
    : undefined;
}

const commands = mapFiles.flatMap(readCommands);
if (mode === "check") {
  let failed = 0;
  for (const { claim, command, kind } of commands) {
    const problem = check(command);
    if (problem) failed++;
    console.log(
      `${problem ? "FAIL" : "ok  "}  ${kind.padEnd(4)} ${claim}  ${problem ?? ""}`,
    );
  }
  console.log(
    `${commands.length - failed}/${commands.length} proof commands resolve`,
  );
  process.exit(failed ? 1 : 0);
} else if (mode === "run") {
  if (!out) throw new Error("run needs --out DIR");
  mkdirSync(out, { recursive: true });
  const distinct = [
    ...new Map(
      commands.filter((c) => kinds.has(c.kind)).map((c) => [c.command, c]),
    ).values(),
  ];
  const summary = [];
  distinct.forEach(({ command }, index) => {
    const claims = commands
      .filter((c) => c.command === command)
      .map((c) => c.claim);
    const result = spawnSync("bash", ["-c", command], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const log = `${index + 1}.log`;
    // Vitest skips the tests that -t does not match and still exits 0, so
    // require at least one passed test per pattern. The second form is the
    // Playwright summary.
    const output = `${result.stdout}${result.stderr}`;
    const passed = Number(
      (
        output.match(/Tests\s+(\d+) passed/) ??
        output.match(/^\s+(\d+) passed \(/m)
      )?.[1] ?? 0,
    );
    const patterns = parse(command).pattern?.split("|").length ?? 1;
    const status =
      result.status === 0 && passed < patterns ? "too-few" : result.status;
    writeFileSync(
      join(out, log),
      `$ ${command}\n# claims: ${claims.join(" ")}\n# exit: ${result.status}, passed: ${passed}, patterns: ${patterns}\n\n${output}`,
    );
    summary.push(
      `${status}\t${passed}/${patterns}\t${log}\t${claims.join(" ")}\t${command}`,
    );
    console.log(
      `${status}  ${passed} passed for ${patterns} patterns  ${claims.join(" ")}  (${log})`,
    );
  });
  writeFileSync(join(out, "summary.tsv"), `${summary.join("\n")}\n`);
  process.exit(summary.some((row) => !row.startsWith("0\t")) ? 1 : 0);
} else {
  console.error("usage: proofs.mjs check|run ...");
  process.exit(2);
}
