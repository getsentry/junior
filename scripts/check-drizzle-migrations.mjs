import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ZERO_SNAPSHOT_ID = "00000000-0000-0000-0000-000000000000";

function readJson(filePath, errors) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(
      `${filePath}: ${error instanceof Error ? error.message : error}`,
    );
    return undefined;
  }
}

/** Report missing, orphaned, or disconnected Drizzle migration metadata. */
export function checkDrizzleMigrationDirectory(directory) {
  const errors = [];
  const journalPath = path.join(directory, "meta", "_journal.json");
  const journal = readJson(journalPath, errors);
  const entries = Array.isArray(journal?.entries) ? journal.entries : undefined;
  if (!entries) {
    if (journal) errors.push(`${journalPath}: entries must be an array`);
    return errors;
  }

  const expectedSqlFiles = new Set();
  const expectedSnapshotFiles = new Set();
  const snapshotIds = new Set();
  let previousSnapshotId = ZERO_SNAPSHOT_ID;

  for (const [index, entry] of entries.entries()) {
    const prefix = String(index).padStart(4, "0");
    if (entry?.idx !== index) {
      errors.push(`${journalPath}: entry ${index} must have idx ${index}`);
    }
    if (typeof entry?.tag !== "string" || !entry.tag.startsWith(`${prefix}_`)) {
      errors.push(`${journalPath}: entry ${index} must use a ${prefix}_ tag`);
      continue;
    }

    const sqlFile = `${entry.tag}.sql`;
    const snapshotFile = `${prefix}_snapshot.json`;
    expectedSqlFiles.add(sqlFile);
    expectedSnapshotFiles.add(snapshotFile);

    const sqlPath = path.join(directory, sqlFile);
    if (!fs.existsSync(sqlPath)) {
      errors.push(`${sqlPath}: migration SQL is missing`);
    }

    const snapshotPath = path.join(directory, "meta", snapshotFile);
    if (!fs.existsSync(snapshotPath)) {
      errors.push(`${snapshotPath}: migration snapshot is missing`);
      continue;
    }
    const snapshot = readJson(snapshotPath, errors);
    if (!snapshot) continue;
    if (snapshot.prevId !== previousSnapshotId) {
      errors.push(
        `${snapshotPath}: prevId must match the previous snapshot id ${previousSnapshotId}`,
      );
    }
    if (typeof snapshot.id !== "string" || !snapshot.id) {
      errors.push(`${snapshotPath}: snapshot id is missing`);
      continue;
    }
    if (snapshotIds.has(snapshot.id)) {
      errors.push(`${snapshotPath}: snapshot id ${snapshot.id} is duplicated`);
    }
    snapshotIds.add(snapshot.id);
    previousSnapshotId = snapshot.id;
  }

  for (const file of fs.readdirSync(directory)) {
    if (/^\d{4}_.+\.sql$/.test(file) && !expectedSqlFiles.has(file)) {
      errors.push(
        `${path.join(directory, file)}: migration SQL is not in the journal`,
      );
    }
  }
  const metadataDirectory = path.join(directory, "meta");
  for (const file of fs.readdirSync(metadataDirectory)) {
    if (
      /^\d{4}_snapshot\.json$/.test(file) &&
      !expectedSnapshotFiles.has(file)
    ) {
      errors.push(
        `${path.join(metadataDirectory, file)}: migration snapshot is not in the journal`,
      );
    }
  }
  return errors;
}

function migrationDirectories(root) {
  const packagesDirectory = path.join(root, "packages");
  return fs
    .readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDirectory, entry.name, "migrations"))
    .filter((directory) =>
      fs.existsSync(path.join(directory, "meta", "_journal.json")),
    );
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDirectory, "..");
  const directories = migrationDirectories(root);
  const errors = directories.flatMap(checkDrizzleMigrationDirectory);
  if (errors.length === 0) {
    console.log(
      `Drizzle migration metadata is valid in ${directories.length} packages.`,
    );
    return;
  }
  console.error(
    ["Drizzle migration metadata check failed:", ...errors].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
