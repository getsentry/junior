import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Run repo checks by name: `node scripts/check.mjs file-length money-units`.
 * With no name, it runs every check that `pnpm lint` needs. A check runs its
 * `scripts/check-<file>.test.mjs` tests, then `scripts/check-<file>.mjs`.
 * Each `pnpm <name>:check` script calls this runner.
 */

// `lint: true` checks run with no name, in this order. `after` runs once the
// check script passes.
const CHECKS = {
  "file-length": { file: "file-length", lint: true },
  "baseline-growth": { file: "baseline-growth", lint: true },
  "typecheck-coverage": { file: "typecheck-coverage", lint: true },
  "migration-metadata": { file: "drizzle-migrations", lint: true },
  "migration-locks": {
    file: "migration-locks",
    lint: true,
    after: [
      "node_modules/.bin/squawk",
      "--reporter",
      "gcc",
      "packages/*/migrations/*.sql",
    ],
  },
  "money-units": { file: "money-units", lint: true },
  "lockfile-families": { file: "lockfile-families", lint: true },
  "test-architecture": { file: "test-architecture", lint: true },
  "type-assertions": { file: "type-assertions", lint: true },
  "await-in-loop": { file: "await-in-loop", lint: true },
  "nav-request-budgets": { file: "nav-request-budgets", lint: true },
  "dashboard-style": { file: "dashboard-styles", lint: true },
  // `ast-grep:lint` runs this after the ast-grep scan.
  "ast-grep-ignores": { file: "ast-grep-ignores", lint: false },
  // CI runs these in their own jobs, after a build or on release changes.
  "dashboard-bundle-size": { file: "dashboard-bundle-size", lint: false },
  "package-types": { file: "package-types", lint: false },
  release: { file: "release-config", lint: false },
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Return the check script files in `scripts/` that have no runner entry. */
function unregisteredScripts() {
  const registered = new Set(
    Object.values(CHECKS).map((check) => `check-${check.file}.mjs`),
  );
  return fs
    .readdirSync(path.join(ROOT, "scripts"))
    .filter(
      (name) =>
        /^check-.+\.mjs$/.test(name) &&
        !name.endsWith(".test.mjs") &&
        !registered.has(name),
    );
}

function main(names) {
  const unregistered = unregisteredScripts();
  if (unregistered.length > 0) {
    console.error(
      `Add each check script to CHECKS in scripts/check.mjs: ${unregistered.join(", ")}`,
    );
    return 1;
  }
  const unknown = names.filter((name) => !(name in CHECKS));
  if (unknown.length > 0) {
    console.error(
      `Unknown check: ${unknown.join(", ")}. Known: ${Object.keys(CHECKS).join(", ")}`,
    );
    return 1;
  }
  const checks = (
    names.length > 0
      ? names
      : Object.keys(CHECKS).filter((name) => CHECKS[name].lint)
  ).map((name) => CHECKS[name]);

  const tests = checks
    .map((check) => `scripts/check-${check.file}.test.mjs`)
    .filter((test) => fs.existsSync(path.join(ROOT, test)));
  if (tests.length > 0) {
    const status = run(process.execPath, ["--test", ...tests]);
    if (status !== 0) return status;
  }
  for (const check of checks) {
    const status = run(process.execPath, [`scripts/check-${check.file}.mjs`]);
    if (status !== 0) return status;
    if (check.after) {
      const [command, ...args] = check.after;
      const afterStatus = run(command, args);
      if (afterStatus !== 0) return afterStatus;
    }
  }
  return 0;
}

// lint-staged appends the staged file paths. The checks scan the whole repo,
// so the runner ignores them.
process.exitCode = main(
  process.argv.slice(2).filter((arg) => !arg.includes(path.sep)),
);
