import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Drizzle migration check. Each migration is a folder named
 * `YYYYMMDDHHMMSS_name` that holds `migration.sql` and `snapshot.json`. The
 * migrator skips a folder without `migration.sql`, and drizzle-kit needs each
 * snapshot to find conflicts. `drizzle-kit check` then reports migrations of
 * two branches that change the same thing, and a schema that no migration
 * creates.
 */

const MIGRATION_FOLDER = /^\d{14}_[a-z0-9_]+$/;

/** Report migration folders that the migrator or drizzle-kit cannot read. */
export function checkDrizzleMigrationDirectory(directory) {
  const errors = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.name === "meta") {
      errors.push(
        `${entryPath}: Drizzle v1 does not read migrations/meta. Run \`drizzle-kit up\`.`,
      );
      continue;
    }
    if (!entry.isDirectory() || !MIGRATION_FOLDER.test(entry.name)) {
      errors.push(
        `${entryPath}: a migration must be a folder named YYYYMMDDHHMMSS_name. Run \`pnpm db:generate\` to write one.`,
      );
      continue;
    }
    for (const file of ["migration.sql", "snapshot.json"]) {
      if (!fs.existsSync(path.join(entryPath, file))) {
        errors.push(`${path.join(entryPath, file)}: file is missing`);
      }
    }
  }
  return errors;
}

/**
 * Report the problems that `drizzle-kit check --output json` finds in one
 * package. On an error, its stderr says what conflicts and how to fix it.
 */
export function drizzleKitCheckErrors(packageDirectory, { stdout, stderr }) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    result = { status: "error" };
  }
  const messages = (result.warnings ?? []).map((warning) => warning.message);
  if (result.status !== "ok") {
    messages.unshift(
      `drizzle-kit check failed:\n${stderr.trim() || stdout.trim()}`,
    );
  }
  return messages.map((message) => `${packageDirectory}: ${message}`);
}

/** List the packages that have Drizzle migrations. */
function migrationPackages(root) {
  const packagesDirectory = path.join(root, "packages");
  return fs
    .readdirSync(packagesDirectory)
    .sort()
    .map((name) => path.join(packagesDirectory, name))
    .filter(
      (directory) =>
        fs.existsSync(path.join(directory, "drizzle.config.ts")) &&
        fs.existsSync(path.join(directory, "migrations")),
    );
}

/** Check each package's migration folders, then run `drizzle-kit check`. */
export function run({ root }) {
  const errors = [];
  for (const directory of migrationPackages(root)) {
    const folderErrors = checkDrizzleMigrationDirectory(
      path.join(directory, "migrations"),
    );
    errors.push(...folderErrors);
    if (folderErrors.length > 0) continue;
    const check = spawnSync(
      path.join(directory, "node_modules", ".bin", "drizzle-kit"),
      ["check", "--config", "drizzle.config.ts", "--output", "json"],
      { cwd: directory, encoding: "utf8" },
    );
    if (check.error) throw check.error;
    errors.push(
      ...drizzleKitCheckErrors(path.relative(root, directory), check),
    );
  }
  return errors;
}
