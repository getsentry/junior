import fs from "node:fs";
import path from "node:path";

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

/** Report missing, orphaned, out-of-order, or disconnected Drizzle migration metadata. */
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
  let previousWhen = -Infinity;

  for (const [index, entry] of entries.entries()) {
    const prefix = String(index).padStart(4, "0");
    if (entry?.idx !== index) {
      errors.push(`${journalPath}: entry ${index} must have idx ${index}`);
    }
    // The migrator skips each migration whose `when` is not newer than the
    // last applied one, so an out-of-order entry never runs.
    if (typeof entry?.when !== "number" || entry.when <= previousWhen) {
      errors.push(
        `${journalPath}: entry ${index} must have a "when" greater than the previous entry's, or the migrator skips it. Run \`pnpm db:rebase\` to regenerate the branch migrations.`,
      );
    } else {
      previousWhen = entry.when;
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

/** List the `migrations` directories of the packages that have a Drizzle journal. */
export function migrationDirectories(root) {
  const packagesDirectory = path.join(root, "packages");
  return fs
    .readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDirectory, entry.name, "migrations"))
    .filter((directory) =>
      fs.existsSync(path.join(directory, "meta", "_journal.json")),
    );
}

/** Check the journal and snapshots of each package's Drizzle migrations. */
export function run({ root }) {
  return migrationDirectories(root).flatMap(checkDrizzleMigrationDirectory);
}
