import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDrizzleMigrationDirectory,
  migrationDirectories,
} from "./check-drizzle-migrations.mjs";

/**
 * Regenerate a branch's Drizzle migrations on top of origin/main:
 * `pnpm db:rebase [junior-github ...]`, after you merge or rebase on
 * origin/main. With no package directory names, it does every package.
 *
 * Two branches that each add a migration always conflict. Both append to the
 * journal and take the same number, and each snapshot lacks the other
 * branch's schema. So this script restores origin/main's migrations, runs
 * `db:generate` again with the branch migration name, and copies hand edits
 * and custom SQL back when that is safe. It stops when it cannot keep the
 * branch's intent.
 *
 * Temporary: Drizzle v1 drops the journal and the snapshot chain, and then
 * this script can go.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "origin/main";
const BREAKPOINT = "--> statement-breakpoint";

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function existingRefs(refs) {
  return refs.filter((ref) =>
    git(["rev-parse", "-q", "--verify", ref], { allowFailure: true }),
  );
}

function generate(packageDirectory, args) {
  const result = spawnSync("pnpm", ["run", "db:generate", ...args], {
    cwd: packageDirectory,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`db:generate failed in ${packageDirectory}`);
  }
}

function readJournal(directory) {
  const journalPath = path.join(directory, "meta", "_journal.json");
  return JSON.parse(fs.readFileSync(journalPath, "utf8")).entries;
}

/** Compare SQL by statement, ignoring whitespace. */
function statements(sql) {
  return sql
    .split(BREAKPOINT)
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function sameStatements(left, right) {
  return JSON.stringify(statements(left)) === JSON.stringify(statements(right));
}

function assertBranchIsCurrent() {
  const unmerged = (git(["diff", "--name-only", "--diff-filter=U"]) ?? "")
    .split("\n")
    .filter((file) => file && !/\/migrations\//.test(file));
  if (unmerged.length > 0) {
    throw new Error(
      `Resolve these conflicts first:\n  ${unmerged.join("\n  ")}`,
    );
  }
  const current = existingRefs(["HEAD", "MERGE_HEAD"]).some(
    (ref) =>
      git(["merge-base", "--is-ancestor", BASE, ref], {
        allowFailure: true,
      }) !== undefined,
  );
  if (!current) {
    throw new Error(
      `Merge or rebase on ${BASE} first. Otherwise db:generate drops the schema changes that ${BASE} added.`,
    );
  }
}

/**
 * Read the SQL that db:generate wrote for a branch migration, from the last
 * branch commit that changed it.
 */
async function generatedSql(directory, tag, generateMigration) {
  const relative = path.relative(ROOT, directory);
  const commit = git([
    "log",
    "-1",
    "--format=%H",
    ...existingRefs(["HEAD", "REBASE_HEAD"]),
    "--",
    `${relative}/${tag}.sql`,
  ]);
  if (!commit) {
    throw new Error(`Commit ${relative}/${tag}.sql first.`);
  }
  const show = (file) =>
    JSON.parse(git(["show", `${commit}:${relative}/meta/${file}`]));
  const entry = show("_journal.json").entries.find((item) => item.tag === tag);
  const prefix = (idx) => String(idx).padStart(4, "0");
  const current = show(`${prefix(entry.idx)}_snapshot.json`);
  const previous = show(`${prefix(entry.idx - 1)}_snapshot.json`);
  return (await generateMigration(previous, current)).join(`\n${BREAKPOINT}\n`);
}

/** Describe each branch migration: its SQL, and whether it has hand edits. */
async function branchMigrations(directory) {
  const relative = path.relative(ROOT, directory);
  const baseFiles = new Set(
    git(["ls-tree", "--name-only", `${BASE}:${relative}`]).split("\n"),
  );
  const tags = fs
    .readdirSync(directory)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file) && !baseFiles.has(file))
    .map((file) => file.slice(0, -".sql".length))
    .sort();
  const require = createRequire(path.join(directory, "..", "package.json"));
  const { generateMigration } = require("drizzle-kit/api");
  const migrations = [];
  for (const tag of tags) {
    const sql = fs.readFileSync(path.join(directory, `${tag}.sql`), "utf8");
    // One at a time: drizzle-kit may prompt about a rename.
    const generated = await generatedSql(directory, tag, generateMigration);
    migrations.push({
      tag,
      name: tag.replace(/^\d{4}_/, ""),
      sql,
      generated,
      custom: statements(generated).length === 0,
      edited: !sameStatements(sql, generated),
    });
  }
  return migrations;
}

/** Refuse branch migrations that one regeneration cannot reproduce. */
function assertReproducible(relative, migrations) {
  const schema = migrations.filter((migration) => !migration.custom);
  const firstCustom = migrations.findIndex((migration) => migration.custom);
  if (
    firstCustom !== -1 &&
    migrations.slice(firstCustom).some((m) => !m.custom)
  ) {
    throw new Error(
      `${relative}: a custom migration comes before a schema migration. Regenerate them in order by hand: run db:generate for each, then copy each custom SQL back.`,
    );
  }
  if (schema.length > 1 && schema.some((migration) => migration.edited)) {
    throw new Error(
      `${relative}: db:generate would collapse ${schema.map((m) => m.tag).join(", ")} into one migration and lose their hand edits. Collapse them into one migration by hand, then run pnpm db:rebase again.`,
    );
  }
}

/** Regenerate one package's branch migrations on top of origin/main's. */
async function rebasePackage(directory) {
  const relative = path.relative(ROOT, directory);
  const packageDirectory = path.dirname(directory);
  const migrations = await branchMigrations(directory);
  if (migrations.length === 0) return [];
  assertReproducible(relative, migrations);

  fs.rmSync(directory, { recursive: true });
  git(["restore", `--source=${BASE}`, "--worktree", "--", relative]);
  const report = [];
  const lastTag = () => readJournal(directory).at(-1).tag;
  const schema = migrations.filter((migration) => !migration.custom);
  if (schema.length > 0) {
    const before = lastTag();
    generate(packageDirectory, [`--name=${schema[0].name}`]);
    const tag = lastTag();
    if (tag === before) {
      if (schema.some((migration) => migration.edited)) {
        throw new Error(
          `${relative}: ${BASE} already has the schema changes of ${schema[0].tag}, but it has hand edits. Decide by hand whether they are still needed.`,
        );
      }
      report.push(
        `${schema.map((m) => m.tag).join(", ")}: ${BASE} already has these changes, removed`,
      );
    } else if (schema[0].edited) {
      const sqlPath = path.join(directory, `${tag}.sql`);
      if (
        !sameStatements(fs.readFileSync(sqlPath, "utf8"), schema[0].generated)
      ) {
        throw new Error(
          `${relative}: ${BASE} changes the SQL that db:generate writes for ${schema[0].tag}, which has hand edits. Run db:generate and apply the hand edits again by hand.`,
        );
      }
      fs.writeFileSync(sqlPath, schema[0].sql);
      report.push(`${schema[0].tag} -> ${tag} (hand edits kept)`);
    } else {
      report.push(
        `${schema.map((m) => m.tag).join(", ")} -> ${tag} (regenerated)`,
      );
    }
  }
  for (const migration of migrations.filter((m) => m.custom)) {
    generate(packageDirectory, ["--custom", `--name=${migration.name}`]);
    const tag = lastTag();
    fs.writeFileSync(path.join(directory, `${tag}.sql`), migration.sql);
    report.push(`${migration.tag} -> ${tag} (custom SQL kept)`);
  }

  const errors = checkDrizzleMigrationDirectory(directory);
  const entries = readJournal(directory).length;
  generate(packageDirectory, []);
  if (readJournal(directory).length !== entries) {
    errors.push(`${relative}: a second db:generate still finds schema changes`);
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  // The restore rewrote files that did not change. Refresh their index stat
  // data, so `git merge --abort` and `git status` see them as unchanged.
  git(["update-index", "-q", "--refresh"], { allowFailure: true });
  return report.map((line) => `${relative}: ${line}`);
}

async function main(names) {
  assertBranchIsCurrent();
  const directories = migrationDirectories(ROOT).filter(
    (directory) =>
      names.length === 0 ||
      names.includes(path.basename(path.dirname(directory))),
  );
  if (directories.length === 0) {
    throw new Error(`No package with migrations matches ${names.join(", ")}.`);
  }
  const report = [];
  for (const directory of directories) {
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), "db-rebase-"));
    fs.cpSync(directory, backup, { recursive: true });
    try {
      report.push(...(await rebasePackage(directory)));
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.cpSync(backup, directory, { recursive: true });
      throw error;
    } finally {
      fs.rmSync(backup, { recursive: true, force: true });
    }
  }
  if (report.length === 0) {
    console.log(`No branch migrations: every migration is on ${BASE}.`);
    return;
  }
  console.log(
    `\n${report.join("\n")}\n\nReview the changes, then git add the migrations directories.`,
  );
}

main(process.argv.slice(2)).catch((error) => {
  console.error(
    `db:rebase stopped and left that package's migrations as they were.\n${error.message}`,
  );
  process.exit(1);
});
