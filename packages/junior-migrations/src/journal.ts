import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MigrationJournalEntry, ResolvedMigration } from "./types";

interface DrizzleJournalEntry {
  breakpoints?: unknown;
  idx?: unknown;
  tag?: unknown;
  when?: unknown;
}

interface DrizzleJournal {
  dialect?: unknown;
  entries?: unknown;
}

function parseJournalEntry(
  value: DrizzleJournalEntry,
  position: number,
): MigrationJournalEntry {
  if (
    typeof value.idx !== "number" ||
    !Number.isInteger(value.idx) ||
    value.idx !== position ||
    typeof value.when !== "number" ||
    !Number.isFinite(value.when) ||
    typeof value.tag !== "string" ||
    !value.tag ||
    typeof value.breakpoints !== "boolean"
  ) {
    throw new Error(`Invalid Drizzle journal entry at index ${position}`);
  }
  return {
    breakpoints: value.breakpoints,
    index: value.idx,
    tag: value.tag,
    when: value.when,
  };
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function validateTypeScriptSource(tag: string, source: string): void {
  const allowedRuntimeImports = new Set([
    "@sentry/junior/migration-helpers/v1",
  ]);
  const imports = source.matchAll(
    /^\s*import\s+([^;]+?)\s+from\s+["']([^"']+)["'];?/gm,
  );
  for (const match of imports) {
    const clause = match[1]?.trim();
    const specifier = match[2];
    if (clause?.startsWith("type ")) {
      continue;
    }
    if (
      !specifier ||
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      specifier.startsWith("@/") ||
      ((specifier === "@sentry/junior" ||
        specifier.startsWith("@sentry/junior/")) &&
        !allowedRuntimeImports.has(specifier))
    ) {
      throw new Error(
        `TypeScript migration ${tag} cannot import application runtime code`,
      );
    }
  }
  if (
    /^\s*import\s*["']/m.test(source) ||
    /^\s*export\s+.+\s+from\s+["'][./]/m.test(source) ||
    /\b(?:import\s*\(|require\s*\()/.test(source)
  ) {
    throw new Error(`TypeScript migration ${tag} cannot load runtime modules`);
  }
}

/** Read and validate the ordered Drizzle journal entries in one migration directory. */
export async function readMigrationJournal(
  migrationsFolder: string,
): Promise<MigrationJournalEntry[]> {
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  let source: string;
  try {
    source = await readFile(journalPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Can't find meta/_journal.json file", { cause: error });
    }
    throw error;
  }
  const parsed = JSON.parse(source) as DrizzleJournal;
  if (parsed.dialect !== "postgresql" || !Array.isArray(parsed.entries)) {
    throw new Error(`Unsupported Drizzle journal in ${journalPath}`);
  }
  const entries = parsed.entries.map((entry, index) =>
    parseJournalEntry(entry as DrizzleJournalEntry, index),
  );
  const timestamps = new Set<number>();
  for (const entry of entries) {
    if (timestamps.has(entry.when)) {
      throw new Error(`Duplicate migration timestamp ${entry.when}`);
    }
    timestamps.add(entry.when);
  }
  return entries;
}

/** Resolve every journal entry to exactly one immutable SQL or TypeScript source file. */
export async function resolveMigrations(
  migrationsFolder: string,
): Promise<ResolvedMigration[]> {
  const entries = await readMigrationJournal(migrationsFolder);
  return await Promise.all(
    entries.map(async (entry) => {
      const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
      const typescriptPath = join(migrationsFolder, `${entry.tag}.ts`);
      const [sqlSource, typescriptSource] = await Promise.all([
        optionalFile(sqlPath),
        optionalFile(typescriptPath),
      ]);
      if ((sqlSource === undefined) === (typescriptSource === undefined)) {
        throw new Error(
          `Migration ${entry.tag} must have exactly one .sql or .ts file`,
        );
      }
      const kind = sqlSource === undefined ? "typescript" : "sql";
      const source = sqlSource ?? typescriptSource ?? "";
      const path = kind === "sql" ? sqlPath : typescriptPath;
      if (kind === "typescript") {
        validateTypeScriptSource(entry.tag, source);
      }
      return {
        ...entry,
        hash: createHash("sha256").update(source).digest("hex"),
        kind,
        path,
        source,
      };
    }),
  );
}
